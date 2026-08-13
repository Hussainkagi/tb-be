const PlanModel = require("../models/planModel");
const EntitlementModel = require("../models/entitlementModel");
const EntitlementService = require("./entitlementService");
const SuperAdminModel = require("../models/superAdminModel");

/**
 * Super Admin plan administration: plans, the plan × feature grid, and
 * per-company overrides.
 *
 * The feature CATALOG is deliberately read-only here. Rows arrive via
 * migrations because a key nothing enforces is dead config — the panel lists
 * the catalog and lets you decide which plans get each key, which is where the
 * real flexibility lives.
 *
 * Every mutation invalidates the entitlement cache and writes an audit row.
 * Plan changes are money decisions; "who moved this company to Gold" must be
 * answerable a year later.
 */

const CODE_PATTERN = /^[a-z0-9_-]{2,50}$/;

/**
 * Validates a grid cell against its feature's value_type, so a checkbox can
 * never end up stored in limit_value where nothing will ever read it.
 */
const normaliseCell = (feature, raw) => {
    switch (feature.value_type) {
        case "limit": {
            const isUnlimited = raw.is_unlimited === true;
            if (isUnlimited) {
                return { bool_value: null, limit_value: null, is_unlimited: true, json_value: null, note: raw.note ?? null };
            }
            const n = Number(raw.limit_value);
            if (!Number.isInteger(n) || n < 0) {
                return { error: `"${feature.key}" is a limit — send an integer limit_value >= 0, or is_unlimited: true.` };
            }
            return { bool_value: null, limit_value: n, is_unlimited: false, json_value: null, note: raw.note ?? null };
        }

        case "enum": {
            const list = raw.json_value;
            if (!Array.isArray(list) || list.some((v) => typeof v !== "string")) {
                return { error: `"${feature.key}" is an enum — send json_value as an array of strings.` };
            }
            return {
                bool_value: null, limit_value: null, is_unlimited: false,
                json_value: JSON.stringify(list), note: raw.note ?? null,
            };
        }

        case "boolean":
        default:
            return {
                bool_value: raw.bool_value === true,
                limit_value: null, is_unlimited: false, json_value: null,
                note: raw.note ?? null,
            };
    }
};

const PlanService = {
    // ═══════════════════════════════════════════════════════════════════════
    // CATALOG
    // ═══════════════════════════════════════════════════════════════════════

    async listFeatures() {
        try {
            const rows = await PlanModel.listFeatures();

            // Grouped by category — the panel renders one section per group,
            // and this is the same order the pricing page uses.
            const grouped = rows.reduce((acc, f) => {
                (acc[f.category] ||= []).push(f);
                return acc;
            }, {});

            return { success: true, data: { features: rows, grouped } };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // PLANS
    // ═══════════════════════════════════════════════════════════════════════

    async listPlans({ include_inactive = false } = {}) {
        try {
            const plans = await PlanModel.listPlans({ include_inactive });

            const withCounts = await Promise.all(
                plans.map(async (p) => ({
                    ...p,
                    company_count: await PlanModel.countCompaniesOnPlan(p.id),
                }))
            );

            return { success: true, data: withCounts };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getPlan(plan_id) {
        try {
            const plan = await PlanModel.findPlanById(plan_id);
            if (!plan) return { success: false, message: "Plan not found" };

            const [grid, company_count] = await Promise.all([
                PlanModel.getPlanGrid(plan_id),
                PlanModel.countCompaniesOnPlan(plan_id),
            ]);

            return { success: true, data: { plan, grid, company_count } };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async createPlan(data, actor, { ip_address } = {}) {
        try {
            const { code, name } = data;

            if (!code || !CODE_PATTERN.test(code)) {
                return {
                    success: false,
                    message: "code is required: lowercase letters, digits, hyphen or underscore, 2–50 characters.",
                };
            }
            if (!name) return { success: false, message: "name is required" };

            const existing = await PlanModel.findPlanByCode(code);
            if (existing) return { success: false, message: `Plan code "${code}" already exists` };

            const plan = await PlanModel.createPlan(data);

            // A brand-new plan grants nothing until its grid is filled in.
            // Stated explicitly in the response so nobody assigns a company to
            // an empty plan and wonders why the app went dark.
            await SuperAdminModel.createAuditLog({
                actor_user_id: actor.user_id,
                action: "plan.create",
                metadata: { plan_code: plan.code, plan_id: plan.id },
                ip_address,
            });

            EntitlementService.invalidateAll();

            return {
                success: true,
                message: "Plan created. It grants nothing until you configure its feature grid.",
                data: plan,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async updatePlan(plan_id, data, actor, { ip_address } = {}) {
        try {
            const plan = await PlanModel.findPlanById(plan_id);
            if (!plan) return { success: false, message: "Plan not found" };

            // Deactivating a plan companies are still on would strand them on
            // a plan the resolver skips. Move them first.
            if (data.is_active === false && plan.is_active) {
                const count = await PlanModel.countCompaniesOnPlan(plan_id);
                if (count > 0) {
                    return {
                        success: false,
                        message: `Cannot deactivate "${plan.code}" — ${count} company(ies) are on it. Move them to another plan first.`,
                    };
                }
            }

            const updated = await PlanModel.updatePlan(plan_id, data);

            await SuperAdminModel.createAuditLog({
                actor_user_id: actor.user_id,
                action: "plan.update",
                metadata: { plan_id, plan_code: plan.code, changes: data },
                ip_address,
            });

            // Pricing and grace_days feed entitlement resolution for every
            // company on the plan, so the whole cache goes.
            EntitlementService.invalidateAll();

            return { success: true, message: "Plan updated", data: updated };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deletePlan(plan_id, actor, { ip_address } = {}) {
        try {
            const plan = await PlanModel.findPlanById(plan_id);
            if (!plan) return { success: false, message: "Plan not found" };

            if (plan.is_fallback) {
                return {
                    success: false,
                    message: "Cannot delete the fallback plan — expired companies land on it. Assign the fallback to another plan first.",
                };
            }

            const companies = await PlanModel.countCompaniesOnPlan(plan_id);
            if (companies > 0) {
                return {
                    success: false,
                    message: `Cannot delete "${plan.code}" — ${companies} company(ies) are on it.`,
                };
            }

            const coupons = await PlanModel.countActiveCouponsForPlan(plan_id);
            if (coupons > 0) {
                return {
                    success: false,
                    message: `Cannot delete "${plan.code}" — ${coupons} unredeemed coupon(s) point at it. Revoke them first.`,
                };
            }

            const deleted = await PlanModel.softDeletePlan(plan_id);

            await SuperAdminModel.createAuditLog({
                actor_user_id: actor.user_id,
                action: "plan.delete",
                metadata: { plan_id, plan_code: plan.code },
                ip_address,
            });

            EntitlementService.invalidateAll();

            return { success: true, message: "Plan deleted", data: deleted };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // THE GRID
    // ═══════════════════════════════════════════════════════════════════════

    async getPlanGrid(plan_id) {
        try {
            const plan = await PlanModel.findPlanById(plan_id);
            if (!plan) return { success: false, message: "Plan not found" };

            const grid = await PlanModel.getPlanGrid(plan_id);
            return { success: true, data: { plan, grid } };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * Saves the grid screen. Validates every cell before writing any of them —
     * a half-applied plan is worse than a rejected save.
     */
    async savePlanGrid(plan_id, cells, actor, { ip_address } = {}) {
        try {
            const plan = await PlanModel.findPlanById(plan_id);
            if (!plan) return { success: false, message: "Plan not found" };

            if (!Array.isArray(cells) || cells.length === 0) {
                return { success: false, message: "features must be a non-empty array" };
            }

            const catalog = await PlanModel.listFeatures();
            const byKey = new Map(catalog.map((f) => [f.key, f]));

            const normalised = [];
            const errors = [];

            for (const cell of cells) {
                const feature = byKey.get(cell.feature_key);
                if (!feature) {
                    errors.push(`Unknown feature key "${cell.feature_key}"`);
                    continue;
                }

                const value = normaliseCell(feature, cell);
                if (value.error) {
                    errors.push(value.error);
                    continue;
                }

                normalised.push({ feature_key: feature.key, ...value });
            }

            if (errors.length > 0) {
                return { success: false, message: "Invalid grid values", errors };
            }

            const grid = await PlanModel.replacePlanGrid(plan_id, normalised);

            await SuperAdminModel.createAuditLog({
                actor_user_id: actor.user_id,
                action: "plan.grid_update",
                metadata: {
                    plan_id,
                    plan_code: plan.code,
                    changed_keys: normalised.map((c) => c.feature_key),
                },
                ip_address,
            });

            // This is the moment every company on the plan changes. Editing
            // the grid takes effect for existing customers immediately, which
            // is the intent — a new module ticked into Gold should light up for
            // Gold customers without them doing anything.
            EntitlementService.invalidateAll();

            return {
                success: true,
                message: `Grid saved. ${normalised.length} feature(s) updated for "${plan.code}".`,
                data: grid,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async setPlanFeature(plan_id, feature_key, value, actor, { ip_address } = {}) {
        try {
            const [plan, feature] = await Promise.all([
                PlanModel.findPlanById(plan_id),
                PlanModel.findFeature(feature_key),
            ]);

            if (!plan) return { success: false, message: "Plan not found" };
            if (!feature) return { success: false, message: `Unknown feature key "${feature_key}"` };

            const normalised = normaliseCell(feature, value);
            if (normalised.error) return { success: false, message: normalised.error };

            const row = await PlanModel.upsertPlanFeatureValue(plan_id, feature_key, normalised);

            await SuperAdminModel.createAuditLog({
                actor_user_id: actor.user_id,
                action: "plan.feature_update",
                metadata: { plan_id, plan_code: plan.code, feature_key, value: normalised },
                ip_address,
            });

            EntitlementService.invalidateAll();

            return { success: true, message: "Feature updated", data: row };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // PER-COMPANY OVERRIDES
    // ═══════════════════════════════════════════════════════════════════════

    async listCompanyOverrides(company_id) {
        try {
            const rows = await EntitlementModel.listOverrides(company_id);
            return { success: true, data: rows };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * "Pro, but 150 employees." Keeps one negotiated deal from spawning a
     * private plan that nobody remembers the reason for — hence reason being
     * required rather than optional.
     */
    async upsertCompanyOverride(company_id, payload, actor, { ip_address } = {}) {
        try {
            const { feature_key, reason, expires_at = null } = payload;

            const feature = await PlanModel.findFeature(feature_key);
            if (!feature) return { success: false, message: `Unknown feature key "${feature_key}"` };

            if (!reason || String(reason).trim().length < 3) {
                return {
                    success: false,
                    message: "reason is required — an override with no recorded justification is impossible to audit later.",
                };
            }

            const normalised = normaliseCell(feature, payload);
            if (normalised.error) return { success: false, message: normalised.error };

            const row = await EntitlementModel.upsertOverride({
                company_id,
                feature_key,
                bool_value: normalised.bool_value,
                limit_value: normalised.limit_value,
                is_unlimited: normalised.is_unlimited,
                json_value: normalised.json_value,
                reason,
                expires_at,
                created_by: actor.user_id,
            });

            await SuperAdminModel.createAuditLog({
                actor_user_id: actor.user_id,
                action: "company.feature_override",
                target_company_id: company_id,
                reason,
                metadata: { feature_key, value: normalised, expires_at },
                ip_address,
            });

            EntitlementService.invalidate(company_id);

            return { success: true, message: "Override applied", data: row };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async removeCompanyOverride(company_id, feature_key, actor, { ip_address } = {}) {
        try {
            const row = await EntitlementModel.deleteOverride(company_id, feature_key);
            if (!row) return { success: false, message: "Override not found" };

            await SuperAdminModel.createAuditLog({
                actor_user_id: actor.user_id,
                action: "company.feature_override_remove",
                target_company_id: company_id,
                metadata: { feature_key },
                ip_address,
            });

            EntitlementService.invalidate(company_id);

            return { success: true, message: "Override removed. The plan value applies again.", data: row };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * The Super Admin's view of one company's resolved entitlements — the same
     * numbers the tenant sees, so support can answer "why can't I add an
     * employee" without logging in as them.
     */
    async getCompanyEntitlements(company_id) {
        return EntitlementService.getEntitlementsForCompany(company_id);
    },
};

module.exports = PlanService;
