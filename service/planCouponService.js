const crypto = require("crypto");

const PlanCouponModel = require("../models/planCouponModel");
const PlanModel = require("../models/planModel");
const CompanyModel = require("../models/companyModel");
const SuperAdminModel = require("../models/superAdminModel");
const EntitlementService = require("./entitlementService");

/**
 * Upgrade coupons.
 *
 * The product decision behind this module: we take payment out of band (the
 * customer emails us, we invoice, they pay), then hand them a code. That keeps
 * a payment gateway out of the app entirely, at the cost of one manual step
 * per upgrade — a good trade at this stage.
 *
 * The security posture follows from the codes being shared over email:
 *   - every code is bound to one company at mint time
 *   - a code is single-use, enforced under a row lock, not a status check
 *   - a code can never move a company DOWN a tier
 *   - failed redemptions are logged and throttled
 */

// Ambiguity-free alphabet: no O/0, no I/1/L. These get read off a phone screen
// and typed by hand, and "was that an O or a zero" is a support ticket.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_GROUPS = 3;
const CODE_GROUP_LEN = 4;

const MAX_FAILED_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MINUTES = 15;

/** e.g. TB-4KDM-9XQP-2WVH — prefixed so it is recognisable in an inbox. */
const generateCode = () => {
    const groups = [];
    for (let g = 0; g < CODE_GROUPS; g++) {
        let group = "";
        for (let i = 0; i < CODE_GROUP_LEN; i++) {
            // randomInt, not Math.random — these are bearer tokens for money.
            group += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
        }
        groups.push(group);
    }
    return `TB-${groups.join("-")}`;
};

const generateUniqueCode = async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
        const code = generateCode();
        if (!(await PlanCouponModel.codeExists(code))) return code;
    }
    throw new Error("Could not generate a unique coupon code after 10 attempts");
};

/** Machine reason → what the company admin actually sees. */
const REDEEM_MESSAGES = {
    NOT_FOUND:         "That code is not valid. Check it and try again.",
    ALREADY_REDEEMED:  "This code has already been used.",
    REVOKED:           "This code is no longer valid. Please contact support.",
    NOT_YET_VALID:     "This code is not active yet.",
    WINDOW_EXPIRED:    "This code has expired. Please contact support for a new one.",
    PLAN_UNAVAILABLE:  "The plan attached to this code is no longer available. Please contact support.",
    COMPANY_NOT_FOUND: "Company not found.",
    DOWNGRADE_BLOCKED: "This code is for a lower plan than the one you are on, so it has not been applied.",
    THROTTLED:         "Too many incorrect attempts. Please wait a few minutes and try again.",
};

const PlanCouponService = {
    // ═══════════════════════════════════════════════════════════════════════
    // SUPER ADMIN — mint & manage
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Mints a code for one company.
     *
     * Two windows, kept separate on purpose:
     *   valid_from / valid_until → when it may be REDEEMED
     *   duration_days            → how long the plan runs once redeemed
     *
     * Collapsing them into one date is the mistake that shows up three months
     * later as "the customer redeemed on the last day and got two days of Pro".
     */
    async createCoupon(payload, actor, { ip_address } = {}) {
        try {
            const {
                company_id, plan_id,
                valid_from, valid_until,
                duration_days = null, notes = null,
            } = payload;

            if (!company_id) return { success: false, message: "company_id is required" };
            if (!plan_id)    return { success: false, message: "plan_id is required" };
            if (!valid_until) return { success: false, message: "valid_until is required" };

            const company = await CompanyModel.findById(company_id);
            if (!company) return { success: false, message: "Company not found" };

            const plan = await PlanModel.findPlanById(plan_id);
            if (!plan) return { success: false, message: "Plan not found" };
            if (!plan.is_active) {
                return { success: false, message: `Plan "${plan.code}" is inactive and cannot be sold.` };
            }

            const from = valid_from ? new Date(valid_from) : new Date();
            const until = new Date(valid_until);

            if (Number.isNaN(from.getTime()) || Number.isNaN(until.getTime())) {
                return { success: false, message: "valid_from and valid_until must be valid dates" };
            }
            if (until <= from) {
                return { success: false, message: "valid_until must be after valid_from" };
            }
            if (until <= new Date()) {
                return { success: false, message: "valid_until is in the past — the code could never be redeemed" };
            }

            if (duration_days !== null && duration_days !== undefined) {
                const n = Number(duration_days);
                if (!Number.isInteger(n) || n <= 0) {
                    return { success: false, message: "duration_days must be a positive integer" };
                }
            }

            // Neither the coupon nor the plan says how long the subscription
            // runs — redeeming would grant the plan forever. Almost always a
            // mistake, so it is rejected rather than silently honoured.
            if (!duration_days && !plan.duration_days) {
                return {
                    success: false,
                    message: `Plan "${plan.code}" has no duration_days, so this coupon would grant it permanently. Set duration_days on the coupon, or on the plan.`,
                };
            }

            // A downgrade coupon cannot be redeemed (the redeem path blocks
            // it), so refuse to mint one instead of handing over a dead code.
            const currentPlan = company.plan_id ? await PlanModel.findPlanById(company.plan_id) : null;
            if (currentPlan && plan.tier < currentPlan.tier) {
                return {
                    success: false,
                    message: `${company.company_name} is on "${currentPlan.code}" (tier ${currentPlan.tier}). A coupon for "${plan.code}" (tier ${plan.tier}) would be a downgrade and cannot be redeemed. Change the plan directly instead.`,
                };
            }

            const code = await generateUniqueCode();

            const coupon = await PlanCouponModel.create({
                code,
                company_id,
                plan_id,
                valid_from: from,
                valid_until: until,
                duration_days: duration_days ?? null,
                notes,
                created_by: actor.user_id,
            });

            await SuperAdminModel.createAuditLog({
                actor_user_id: actor.user_id,
                action: "coupon.create",
                target_company_id: company_id,
                metadata: {
                    coupon_code: code,
                    plan_code: plan.code,
                    valid_from: from,
                    valid_until: until,
                    duration_days: duration_days ?? plan.duration_days,
                    notes,
                },
                ip_address,
            });

            return {
                success: true,
                message: "Coupon created. Share the code with the company admin.",
                data: {
                    ...coupon,
                    plan_code: plan.code,
                    plan_name: plan.name,
                    company_name: company.company_name,
                    grants_days: duration_days ?? plan.duration_days,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async listCoupons(query = {}) {
        try {
            const page = Math.max(1, parseInt(query.page, 10) || 1);
            const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));

            const { rows, total } = await PlanCouponModel.list({
                page, limit,
                company_id: query.company_id,
                status: query.status,
                search: query.search,
            });

            return { success: true, data: rows, pagination: { page, limit, total } };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getCoupon(coupon_id) {
        try {
            const coupon = await PlanCouponModel.findById(coupon_id);
            if (!coupon) return { success: false, message: "Coupon not found" };
            return { success: true, data: coupon };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * Kills an unredeemed code — wrong company, payment reversed, code leaked.
     * A redeemed coupon cannot be revoked: the upgrade already happened, and
     * unwinding it is a plan change, not a coupon operation.
     */
    async revokeCoupon(coupon_id, reason, actor, { ip_address } = {}) {
        try {
            const coupon = await PlanCouponModel.findById(coupon_id);
            if (!coupon) return { success: false, message: "Coupon not found" };

            if (coupon.status === "redeemed") {
                return {
                    success: false,
                    message: "This coupon has already been redeemed. Change the company's plan directly to reverse it.",
                };
            }
            if (coupon.status === "revoked") {
                return { success: false, message: "This coupon is already revoked" };
            }

            const revoked = await PlanCouponModel.revoke(coupon_id, reason);

            await SuperAdminModel.createAuditLog({
                actor_user_id: actor.user_id,
                action: "coupon.revoke",
                target_company_id: coupon.company_id,
                reason,
                metadata: { coupon_code: coupon.code, plan_code: coupon.plan_code },
                ip_address,
            });

            return { success: true, message: "Coupon revoked", data: revoked };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // COMPANY ADMIN — redeem
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Applies a code to the caller's own company.
     *
     * company_id comes from the authenticated context, never from the body —
     * otherwise anyone holding a code could apply it to a company they picked.
     *
     * Codes are normalised (trim + uppercase) because they are typed by hand.
     */
    async redeemCoupon({ code, company_id, user_id, ip_address }) {
        const normalised = String(code || "").trim().toUpperCase();

        if (!normalised) {
            return { success: false, message: "Enter the code you were sent." };
        }

        try {
            // Codes are short and typed by humans, which also makes them
            // guessable at machine speed. Throttle per company.
            const recentFailures = await PlanCouponModel.countRecentFailures(
                company_id, ATTEMPT_WINDOW_MINUTES
            );
            if (recentFailures >= MAX_FAILED_ATTEMPTS) {
                await PlanCouponModel.logAttempt({
                    company_id, user_id, code_attempted: normalised,
                    was_successful: false, failure_reason: "THROTTLED", ip_address,
                });
                return { success: false, code: "THROTTLED", message: REDEEM_MESSAGES.THROTTLED };
            }

            const result = await PlanCouponModel.redeem({
                code: normalised, company_id, user_id,
            });

            await PlanCouponModel.logAttempt({
                company_id, user_id, code_attempted: normalised,
                was_successful: result.success,
                failure_reason: result.success ? null : result.reason,
                ip_address,
            });

            if (!result.success) {
                return {
                    success: false,
                    code: result.reason,
                    message: REDEEM_MESSAGES[result.reason] || "That code could not be applied.",
                    data: result.data ?? null,
                };
            }

            // The upgrade has to feel instant — the admin is looking at the
            // screen. Without this the TTL would leave the UI locked for up to
            // a minute after a successful redemption.
            EntitlementService.invalidate(company_id);

            const { plan, expires_at, was_renewal, previous_plan_code } = result.data;

            return {
                success: true,
                message: was_renewal
                    ? `Your ${plan.name} plan has been extended.`
                    : `You are now on ${plan.name}.`,
                data: {
                    plan_code: plan.code,
                    plan_name: plan.name,
                    previous_plan_code,
                    expires_at,
                    was_renewal,
                    entitlements: await EntitlementService.getSnapshot(company_id),
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** The company's own coupon history — its records only. */
    async listCompanyCoupons(company_id) {
        try {
            const rows = await PlanCouponModel.listForCompany(company_id);
            return { success: true, data: rows };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = PlanCouponService;
