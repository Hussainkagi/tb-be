const PlanService = require("../service/planService");
const PlanCouponService = require("../service/planCouponService");

/**
 * Super Admin plan console: plans, the feature grid, per-company overrides and
 * upgrade coupons. Mounted under /api/super-admin — every route below is
 * already behind verifyToken + requireSuperAdmin.
 *
 * Helpers mirror superAdminController so both files read the same way.
 */

const actorOf = (req) => ({
    user_id: req.user.user_id,
    company_id: req.user.company_id,
    role: req.user.role,
});

const ipOf = (req) =>
    (req.headers["x-forwarded-for"]?.split(",")[0] || req.ip || "").trim() || null;

const send = (res, result, okStatus = 200, failStatus = 400) =>
    res.status(result.success ? okStatus : failStatus).json(result);

const fail = (res, error) =>
    res.status(500).json({
        success: false,
        message: "Server error",
        error: error.message,
    });

const PlanController = {
    // ── Feature catalog (read-only) ──────────────────────────────────────────
    async listFeatures(req, res) {
        try {
            return send(res, await PlanService.listFeatures());
        } catch (error) {
            return fail(res, error);
        }
    },

    // ── Plans ────────────────────────────────────────────────────────────────
    async listPlans(req, res) {
        try {
            const result = await PlanService.listPlans({
                include_inactive: req.query.include_inactive === "true",
            });
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async getPlan(req, res) {
        try {
            return send(res, await PlanService.getPlan(req.params.plan_id), 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    async createPlan(req, res) {
        try {
            const result = await PlanService.createPlan(req.body, actorOf(req), {
                ip_address: ipOf(req),
            });
            return send(res, result, 201);
        } catch (error) {
            return fail(res, error);
        }
    },

    async updatePlan(req, res) {
        try {
            const result = await PlanService.updatePlan(
                req.params.plan_id, req.body, actorOf(req), { ip_address: ipOf(req) }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async deletePlan(req, res) {
        try {
            const result = await PlanService.deletePlan(
                req.params.plan_id, actorOf(req), { ip_address: ipOf(req) }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    // ── The grid ─────────────────────────────────────────────────────────────
    async getPlanGrid(req, res) {
        try {
            return send(res, await PlanService.getPlanGrid(req.params.plan_id), 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    // PUT body: { features: [{ feature_key, bool_value | limit_value | is_unlimited | json_value, note }] }
    async savePlanGrid(req, res) {
        try {
            const result = await PlanService.savePlanGrid(
                req.params.plan_id, req.body?.features, actorOf(req), { ip_address: ipOf(req) }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async setPlanFeature(req, res) {
        try {
            const result = await PlanService.setPlanFeature(
                req.params.plan_id, req.params.feature_key, req.body,
                actorOf(req), { ip_address: ipOf(req) }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    // ── Per-company overrides ────────────────────────────────────────────────
    async getCompanyEntitlements(req, res) {
        try {
            const result = await PlanService.getCompanyEntitlements(req.params.company_id);
            return send(res, result, 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    async listCompanyOverrides(req, res) {
        try {
            return send(res, await PlanService.listCompanyOverrides(req.params.company_id));
        } catch (error) {
            return fail(res, error);
        }
    },

    async upsertCompanyOverride(req, res) {
        try {
            const result = await PlanService.upsertCompanyOverride(
                req.params.company_id, req.body, actorOf(req), { ip_address: ipOf(req) }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async removeCompanyOverride(req, res) {
        try {
            const result = await PlanService.removeCompanyOverride(
                req.params.company_id, req.params.feature_key,
                actorOf(req), { ip_address: ipOf(req) }
            );
            return send(res, result, 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    // ── Coupons ──────────────────────────────────────────────────────────────
    async createCoupon(req, res) {
        try {
            const result = await PlanCouponService.createCoupon(req.body, actorOf(req), {
                ip_address: ipOf(req),
            });
            return send(res, result, 201);
        } catch (error) {
            return fail(res, error);
        }
    },

    async listCoupons(req, res) {
        try {
            return send(res, await PlanCouponService.listCoupons(req.query));
        } catch (error) {
            return fail(res, error);
        }
    },

    async getCoupon(req, res) {
        try {
            return send(res, await PlanCouponService.getCoupon(req.params.coupon_id), 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    async revokeCoupon(req, res) {
        try {
            const result = await PlanCouponService.revokeCoupon(
                req.params.coupon_id, req.body?.reason, actorOf(req), { ip_address: ipOf(req) }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },
};

module.exports = PlanController;
