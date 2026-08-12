const EntitlementService = require("../service/entitlementService");
const { Feature, Limit } = require("../enums/features");

/**
 * Plan gating.
 *
 * The frontend greys out what a company cannot use — that is UX. This file is
 * the boundary that actually holds: a disabled button is one devtools edit away
 * from being enabled, a 403 here is not.
 *
 * Three gates:
 *
 *   requireFeature(key)         boolean capability   → mount on the whole router
 *   requireReport(sub_key)      enum member          → mount per report endpoint
 *   enforceLimit(key, count)    numeric cap          → mount on CREATE only
 *
 * Must run AFTER verifyToken (needs req.user) and after the tenant guard.
 *
 * Every denial returns the same shape, so the frontend has one interceptor:
 *
 *   403 {
 *     success: false,
 *     code: "FEATURE_NOT_IN_PLAN" | "LIMIT_REACHED",
 *     message, data: { feature, current_plan, required_plans, ... }
 *   }
 */

// A company_id can arrive from the route (most modules are mounted under
// /companies/:company_id) or from the token. Route wins, but the tenant guard
// has already established the two agree.
const companyIdOf = (req) =>
    req.params.company_id || req.body?.company_id || req.user?.company_id || null;

/** Super admins operate above the tenant boundary — plans do not apply to them. */
const isPlatformActor = (req) => req.user?.is_super_admin === true;

const denyFeature = async (res, { feature_key, snapshot, label }) => {
    const required_plans = await EntitlementService.plansOffering(feature_key);

    return res.status(403).json({
        success: false,
        code: "FEATURE_NOT_IN_PLAN",
        message: `${label || "This feature"} is not included in your current plan.`,
        data: {
            feature: feature_key,
            current_plan: snapshot?.plan?.code ?? null,
            plan_expired: snapshot?.plan?.is_downgraded_by_expiry ?? false,
            required_plans,
            upgrade_path: "/billing/pricing",
        },
        timestamp: new Date().toISOString(),
    });
};

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Gate a boolean feature.
 *
 * Validates the key at mount time and throws on an unknown one — a typo in a
 * gate is a coding error, and it should break at boot rather than quietly lock
 * every tenant out of a route in production.
 *
 * @param {object}  [options]
 * @param {boolean} [options.allowReads]
 *        Let GET/HEAD through and gate only writes. Use this on modules where
 *        a company can accumulate real records — payroll, payslips — so that a
 *        downgrade stops them generating new ones without hiding the history
 *        they already built. Leave it off for features whose whole value IS the
 *        read (gratuity figures, audit trail): there is nothing to lose access
 *        to, because a plan without the feature never produced any.
 */
const requireFeature = (feature_key, options = {}) => {
    if (!Object.values(Feature).includes(feature_key)) {
        throw new Error(
            `requireFeature("${feature_key}") — unknown feature key. Add it to enums/features.js and a migration first.`
        );
    }

    const { allowReads = false } = options;

    return async (req, res, next) => {
        if (isPlatformActor(req)) return next();
        if (allowReads && SAFE_METHODS.has(req.method)) return next();

        const company_id = companyIdOf(req);
        if (!company_id) {
            return res.status(400).json({
                success: false,
                message: "Company context is required for this request.",
            });
        }

        try {
            const snapshot = await EntitlementService.getSnapshot(company_id);
            if (!snapshot) {
                return res.status(404).json({ success: false, message: "Company not found" });
            }

            if (snapshot.features[feature_key] === true) return next();

            return denyFeature(res, {
                feature_key,
                snapshot,
                label: snapshot.detail?.[feature_key]?.label,
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Failed to verify plan entitlements",
                error: error.message,
            });
        }
    };
};

/**
 * Gate one member of an enum feature — currently the report catalogue.
 * Trial gets casual + detailed, Pro adds working hours + headcount, Gold all.
 */
const requireReport = (report_key) => async (req, res, next) => {
    if (isPlatformActor(req)) return next();

    const company_id = companyIdOf(req);
    if (!company_id) {
        return res.status(400).json({
            success: false,
            message: "Company context is required for this request.",
        });
    }

    try {
        const snapshot = await EntitlementService.getSnapshot(company_id);
        if (!snapshot) {
            return res.status(404).json({ success: false, message: "Company not found" });
        }

        const allowed = snapshot.features[Feature.REPORTS];
        if (Array.isArray(allowed) && allowed.includes(report_key)) return next();

        const required_plans = await EntitlementService.plansOffering(Feature.REPORTS);

        return res.status(403).json({
            success: false,
            code: "FEATURE_NOT_IN_PLAN",
            message: "This report is not included in your current plan.",
            data: {
                feature: Feature.REPORTS,
                report: report_key,
                current_plan: snapshot.plan.code,
                available_reports: Array.isArray(allowed) ? allowed : [],
                required_plans,
                upgrade_path: "/billing/pricing",
            },
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Failed to verify plan entitlements",
            error: error.message,
        });
    }
};

/**
 * Cap a countable resource — ON CREATE ONLY.
 *
 * Mount this on POST routes and nothing else. A company that downgrades while
 * holding 140 employees on a 100 cap must keep seeing, editing and paying all
 * 140; it simply cannot add the 141st. Enforcing caps on reads would read as
 * data loss, and it is the single most common way this kind of gating goes
 * wrong.
 *
 * @param {string} limit_key  one of enums/features.js → Limit
 * @param {function|number} countOf  how many records this request creates.
 *        Pass a function for bulk endpoints, e.g. (req) => req.rows.length.
 */
const enforceLimit = (limit_key, countOf = 1) => {
    if (!Object.values(Limit).includes(limit_key)) {
        throw new Error(`enforceLimit("${limit_key}") — unknown limit key.`);
    }

    return async (req, res, next) => {
        if (isPlatformActor(req)) return next();

        const company_id = companyIdOf(req);
        if (!company_id) {
            return res.status(400).json({
                success: false,
                message: "Company context is required for this request.",
            });
        }

        try {
            const count = typeof countOf === "function" ? countOf(req) : countOf;

            // A bulk endpoint whose parser has not run yet reports 0. Treat that
            // as 1 rather than as "adds nothing", so the check cannot be skipped
            // by shipping an unparsed body.
            const requested = Number.isFinite(count) && count > 0 ? count : 1;

            const result = await EntitlementService.checkLimit(company_id, limit_key, requested);
            if (result.allowed) return next();

            if (result.reason === "COMPANY_NOT_FOUND") {
                return res.status(404).json({ success: false, message: "Company not found" });
            }

            const required_plans = await EntitlementService.plansOffering(limit_key);

            return res.status(403).json({
                success: false,
                code: "LIMIT_REACHED",
                message:
                    requested > 1
                        ? `Adding ${requested} ${result.label} would exceed your plan limit of ${result.limit}. You have ${result.remaining} remaining.`
                        : `Your plan allows up to ${result.limit} ${result.label}. Upgrade to add more.`,
                data: {
                    feature: limit_key,
                    limit: result.limit,
                    used: result.used,
                    requested,
                    remaining: result.remaining,
                    current_plan: result.plan_code,
                    required_plans,
                    upgrade_path: "/billing/pricing",
                },
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Failed to verify plan limits",
                error: error.message,
            });
        }
    };
};

/**
 * Drops an uploaded file when the company is not entitled to it.
 *
 * Used for photo verification on check-in/out. A 403 would be the wrong answer
 * here: the selfie is an optional part of the request, and rejecting the whole
 * call would stop a Trial employee from clocking in at all. So the attendance
 * record is written without the photo, and the response says so — a stale app
 * build that still shows the camera degrades instead of breaking.
 */
const stripUnentitledUpload = (feature_key) => async (req, res, next) => {
    if (!req.file || isPlatformActor(req)) return next();

    const company_id = companyIdOf(req);
    if (!company_id) return next();

    try {
        const snapshot = await EntitlementService.getSnapshot(company_id);
        if (snapshot && snapshot.features[feature_key] !== true) {
            req.file = undefined;
            req.uploadStrippedByPlan = feature_key;
            res.set("X-Feature-Stripped", feature_key);
        }
    } catch {
        // A resolver failure must not stop someone clocking in.
    }
    next();
};

/**
 * Attaches the snapshot to req without gating anything, for handlers that need
 * to shape a response by plan (e.g. the dashboard hiding its alerts panel).
 */
const attachEntitlements = async (req, res, next) => {
    const company_id = companyIdOf(req);
    if (!company_id) return next();

    try {
        req.entitlements = await EntitlementService.getSnapshot(company_id);
    } catch {
        // Never block a request over this — it is a convenience, not a gate.
        req.entitlements = null;
    }
    next();
};

module.exports = {
    requireFeature,
    requireReport,
    enforceLimit,
    stripUnentitledUpload,
    attachEntitlements,
};
