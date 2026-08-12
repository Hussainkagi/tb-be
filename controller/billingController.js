const EntitlementService = require("../service/entitlementService");
const PlanCouponService = require("../service/planCouponService");

/**
 * The company-facing billing surface, mounted at
 * /api/companies/:company_id/billing.
 *
 * Three things the webapp needs:
 *   GET  /entitlements   → what to enable, disable and badge (called at login)
 *   GET  /pricing        → the upgrade modal behind every "Upgrade" badge
 *   POST /coupons/redeem → apply the code we emailed them
 */

const ipOf = (req) =>
    (req.headers["x-forwarded-for"]?.split(",")[0] || req.ip || "").trim() || null;

const fail = (res, error) =>
    res.status(500).json({
        success: false,
        message: "Server error",
        error: error.message,
    });

const BillingController = {
    /**
     * The one call the frontend gates everything off. Fetch at login and after
     * a successful redemption; cache in app state in between.
     */
    async getEntitlements(req, res) {
        try {
            const result = await EntitlementService.getEntitlementsForCompany(
                req.params.company_id
            );
            return res.status(result.success ? 200 : 404).json(result);
        } catch (error) {
            return fail(res, error);
        }
    },

    /** Every public plan + which one they are on. Powers the upgrade modal. */
    async getPricing(req, res) {
        try {
            const result = await EntitlementService.getPricingPage(req.params.company_id);
            return res.status(result.success ? 200 : 400).json(result);
        } catch (error) {
            return fail(res, error);
        }
    },

    /**
     * Redeem an upgrade code.
     *
     * company_id is taken from the route (already tenant-checked) and the user
     * from the token — never from the body, so a code cannot be applied to a
     * company the caller does not administer.
     */
    async redeemCoupon(req, res) {
        try {
            const result = await PlanCouponService.redeemCoupon({
                code: req.body?.code,
                company_id: req.params.company_id,
                user_id: req.user.user_id,
                ip_address: ipOf(req),
            });

            // Throttling is a 429 so the frontend can tell "wrong code, try
            // again" apart from "stop trying for a while".
            if (!result.success && result.code === "THROTTLED") {
                return res.status(429).json(result);
            }

            return res.status(result.success ? 200 : 400).json(result);
        } catch (error) {
            return fail(res, error);
        }
    },

    /** Codes issued to this company, for the "previous upgrades" list. */
    async listCoupons(req, res) {
        try {
            const result = await PlanCouponService.listCompanyCoupons(req.params.company_id);
            return res.status(result.success ? 200 : 400).json(result);
        } catch (error) {
            return fail(res, error);
        }
    },
};

module.exports = BillingController;
