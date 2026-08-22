const EntitlementModel = require("../models/entitlementModel");
const PlanModel = require("../models/planModel");
const { Limit, LimitLabel } = require("../enums/features");

/**
 * Resolves what a company is allowed to do, and caches it.
 *
 * Everything that gates behaviour goes through here: the requireFeature /
 * enforceLimit middleware, the /billing/entitlements endpoint the frontend
 * renders from, and the pricing page.
 *
 * Caching mirrors the pattern already used by enforceCompanyActive and
 * isSuperAdmin — a short TTL map, plus explicit invalidation on the events
 * that actually change entitlements (coupon redeemed, plan changed, grid
 * edited, override added). The TTL is the safety net, not the mechanism: an
 * upgrade must feel instant, so redemption invalidates rather than waiting the
 * TTL out.
 */

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // company_id -> { snapshot, expires_at }

/**
 * Grid edits change entitlements for every company on that plan at once, and
 * we do not keep a plan → companies index in memory. Bumping a generation
 * counter invalidates the whole cache lazily instead of walking it.
 */
let generation = 0;

// ─────────────────────────────────────────────────────────────────────────────
// Value shaping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Collapses a resolved DB row into the value the API and the middleware use.
 *
 *   boolean → true | false
 *   limit   → null (unlimited) | integer
 *   enum    → array of allowed sub-keys
 */
const shapeValue = (row) => {
    switch (row.value_type) {
        case "limit":
            if (row.is_unlimited) return null;
            return row.limit_value ?? 0;   // unconfigured cap means zero, not infinity
        case "enum":
            return Array.isArray(row.json_value) ? row.json_value : [];
        case "boolean":
        default:
            return row.bool_value === true;
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot
// ─────────────────────────────────────────────────────────────────────────────

const buildSnapshot = async (company_id) => {
    const planState = await EntitlementModel.getCompanyPlanState(company_id);
    if (!planState) return null;

    // No fallback plan configured at all — refuse to guess. Denying everything
    // would lock every tenant out over a config mistake, so we surface it.
    if (!planState.effective_plan_id) {
        throw new Error(
            "No plan resolved for company and no fallback plan is configured. " +
            "Mark one plan with is_fallback = TRUE."
        );
    }

    const [rows, usage] = await Promise.all([
        EntitlementModel.getResolvedFeatures(company_id, planState.effective_plan_id),
        EntitlementModel.countUsage(company_id),
    ]);

    const features = {};   // key -> shaped value, for gating
    const detail = {};     // key -> full row, for the pricing/settings UI

    for (const row of rows) {
        features[row.key] = shapeValue(row);
        detail[row.key] = {
            key: row.key,
            category: row.category,
            label: row.label,
            value_type: row.value_type,
            value: features[row.key],
            is_enforceable: row.is_enforceable,
            is_overridden: row.is_overridden,
            note: row.note,
        };
    }

    // Usage against caps, precomputed so the frontend can render "8 / 10
    // employees" without knowing how to interpret the null-means-unlimited rule.
    const limits = {};
    for (const key of Object.values(Limit)) {
        const cap = features[key];              // null = unlimited
        const used = usage[key] ?? 0;
        limits[key] = {
            key,
            label: LimitLabel[key],
            used,
            limit: cap,
            is_unlimited: cap === null,
            remaining: cap === null ? null : Math.max(0, cap - used),
            // Over the cap without being blocked: the state a downgraded
            // company lands in. Reads keep working; creates do not.
            is_exceeded: cap !== null && used > cap,
            is_at_limit: cap !== null && used >= cap,
        };
    }

    return {
        company_id,
        plan: {
            id:   planState.effective_plan_id,
            code: planState.effective_plan_code,
            name: planState.effective_plan_name,
            assigned_code: planState.assigned_plan_code,
            expires_at: planState.plan_expires_at,
            is_expired: planState.is_expired === true,
            is_in_grace: planState.is_in_grace === true,
            // True when a paid plan lapsed and the company is being served the
            // fallback plan. The UI shows a renewal banner off this flag.
            is_downgraded_by_expiry: planState.is_downgraded_by_expiry === true,
        },
        features,
        detail,
        limits,
        generation,
        resolved_at: new Date().toISOString(),
    };
};

const EntitlementService = {
    /** Cached resolved entitlements. Every gate reads through this. */
    async getSnapshot(company_id) {
        const cached = cache.get(company_id);
        if (cached && cached.expires_at > Date.now() && cached.generation === generation) {
            return cached.snapshot;
        }

        const snapshot = await buildSnapshot(company_id);
        if (snapshot) {
            cache.set(company_id, {
                snapshot,
                generation,
                expires_at: Date.now() + CACHE_TTL_MS,
            });
        }
        return snapshot;
    },

    /** Drops one company. Call after a redemption or a plan/override change. */
    invalidate(company_id) {
        if (company_id) cache.delete(company_id);
        else cache.clear();
    },

    /** Drops everything. Call after editing a plan or the grid. */
    invalidateAll() {
        generation += 1;
        cache.clear();
    },

    // ── Checks ────────────────────────────────────────────────────────────────

    /**
     * Boolean gate. Unknown keys deny — a typo must fail closed, and it will
     * show up immediately in testing rather than quietly granting access.
     */
    async hasFeature(company_id, feature_key) {
        const snapshot = await this.getSnapshot(company_id);
        if (!snapshot) return false;
        return snapshot.features[feature_key] === true;
    },

    /** Enum gate — is this report/sub-capability included? */
    async hasEnumValue(company_id, feature_key, sub_key) {
        const snapshot = await this.getSnapshot(company_id);
        if (!snapshot) return false;
        const value = snapshot.features[feature_key];
        return Array.isArray(value) && value.includes(sub_key);
    },

    /**
     * Cap check for the CREATE path.
     *
     * `count` is how many records this one request would add — 1 for a normal
     * create, N for a bulk import. Checking the whole batch up front is what
     * stops a 60-row upload from walking a company 50 seats past its cap one
     * insert at a time.
     *
     * Never call this on a read path: a company sitting over its cap after a
     * downgrade must keep full access to the records it already has.
     */
    async checkLimit(company_id, limit_key, count = 1) {
        const snapshot = await this.getSnapshot(company_id);
        if (!snapshot) {
            return { allowed: false, reason: "COMPANY_NOT_FOUND" };
        }

        const cap = snapshot.features[limit_key];
        if (cap === null) {
            return { allowed: true, limit: null, is_unlimited: true };
        }

        // Count live rather than trusting the cached usage: the snapshot may be
        // up to a minute stale, and two admins inviting at once could otherwise
        // both see the same stale count and both slip through.
        const used = await EntitlementModel.countUsageFor(company_id, limit_key);

        if (used + count > cap) {
            return {
                allowed: false,
                reason: "LIMIT_REACHED",
                limit: cap,
                used,
                requested: count,
                remaining: Math.max(0, cap - used),
                label: LimitLabel[limit_key],
                plan_code: snapshot.plan.code,
            };
        }

        return { allowed: true, limit: cap, used, remaining: cap - used - count };
    },

    // ── API-facing reads ──────────────────────────────────────────────────────

    /** What GET /billing/entitlements returns. */
    async getEntitlementsForCompany(company_id) {
        try {
            const snapshot = await this.getSnapshot(company_id);
            if (!snapshot) return { success: false, message: "Company not found" };

            return {
                success: true,
                data: {
                    plan: snapshot.plan,
                    features: snapshot.features,
                    limits: snapshot.limits,
                    detail: Object.values(snapshot.detail),
                    resolved_at: snapshot.resolved_at,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * The in-app pricing page: every public plan with its visible features,
     * plus which one the company is on and which are an upgrade from here.
     */
    async getPricingPage(company_id) {
        try {
            const [plans, snapshot] = await Promise.all([
                PlanModel.listPlans({ public_only: true }),
                company_id ? this.getSnapshot(company_id) : null,
            ]);

            if (plans.length === 0) {
                return { success: false, message: "No plans are configured" };
            }

            const grid = await PlanModel.getGridForPlans(plans.map((p) => p.id));

            const byPlan = new Map(plans.map((p) => [p.id, []]));
            for (const cell of grid) {
                if (!cell.is_visible) continue;
                byPlan.get(cell.plan_id)?.push({
                    key: cell.key,
                    category: cell.category,
                    label: cell.label,
                    value_type: cell.value_type,
                    value: shapeValue(cell),
                    note: cell.note,
                });
            }

            const currentTier = snapshot
                ? plans.find((p) => p.id === snapshot.plan.id)?.tier ?? -1
                : -1;

            return {
                success: true,
                data: {
                    current_plan_code: snapshot?.plan.code ?? null,
                    current_plan_expires_at: snapshot?.plan.expires_at ?? null,
                    plans: plans.map((p) => ({
                        id: p.id,
                        code: p.code,
                        name: p.name,
                        tagline: p.tagline,
                        description: p.description,
                        price_amount: p.price_amount,
                        price_currency: p.price_currency,
                        billing_period: p.billing_period,
                        duration_days: p.duration_days,
                        tier: p.tier,
                        is_current: snapshot ? p.id === snapshot.plan.id : false,
                        is_upgrade: p.tier > currentTier,
                        features: byPlan.get(p.id) ?? [],
                    })),
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * Which plans would unlock a given feature. Powers the "Available on Gold"
     * line under a disabled button, without the frontend hardcoding plan names.
     */
    async plansOffering(feature_key) {
        const plans = await PlanModel.listPlans({ public_only: true });
        if (plans.length === 0) return [];

        const grid = await PlanModel.getGridForPlans(plans.map((p) => p.id));
        const offering = new Set(
            grid
                .filter((cell) => {
                    if (cell.key !== feature_key) return false;
                    if (cell.value_type === "limit") return cell.is_unlimited || cell.limit_value > 0;
                    if (cell.value_type === "enum") return Array.isArray(cell.json_value) && cell.json_value.length > 0;
                    return cell.bool_value === true;
                })
                .map((cell) => cell.plan_id)
        );

        return plans
            .filter((p) => offering.has(p.id))
            // The signup plan is excluded even though it grants everything.
            // Since 43_free_plan_and_full_trial.sql the 45-day trial offers
            // every feature at tier 0, so it would sort to the front of every
            // upgrade prompt — telling a company whose trial just lapsed to
            // "upgrade to Trial". It is not purchasable and they have already
            // had it; the honest answer is the cheapest PAID plan that carries
            // the feature.
            .filter((p) => p.is_signup_default !== true)
            .sort((a, b) => a.tier - b.tier)
            .map((p) => ({ code: p.code, name: p.name, tier: p.tier }));
    },
};

module.exports = EntitlementService;
