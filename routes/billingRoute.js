const express = require("express");
const router = express.Router({ mergeParams: true });

const BillingController = require("../controller/billingController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// Mounted at /api/companies/:company_id/billing
//
// Deliberately NOT gated by requireFeature — a company must always be able to
// see what it is on and upgrade, especially when its plan has lapsed. Gating
// the upgrade path behind the plan would be the one lockout with no way out.

// ─────────────────────────────────────────────
// ENTITLEMENTS — every authenticated user
// ─────────────────────────────────────────────
// The webapp and the mobile app both read this at login to decide what to
// enable, disable and badge. Employees need it too: their own screens are
// gated (photo check-in, self-view history), so this is not admin-only.
router.get(
    "/entitlements",
    verifyToken,
    validateTenant,
    isEmployee,
    BillingController.getEntitlements
);

// ─────────────────────────────────────────────
// PRICING — every authenticated user
// ─────────────────────────────────────────────
// Behind every "Upgrade" badge. Readable by all roles so an employee tapping a
// locked feature sees why, even though only an admin can act on it.
router.get(
    "/pricing",
    verifyToken,
    validateTenant,
    isEmployee,
    BillingController.getPricing
);

// ─────────────────────────────────────────────
// COUPONS — admin only
// ─────────────────────────────────────────────
// Redeeming changes what the company pays for. Admin only, and the redemption
// is bound to the caller's own company inside the service.
router.post(
    "/coupons/redeem",
    verifyToken,
    validateTenant,
    isAdmin,
    BillingController.redeemCoupon
);

// Codes issued to this company (redeemed and outstanding).
router.get(
    "/coupons",
    verifyToken,
    validateTenant,
    isAdmin,
    BillingController.listCoupons
);

module.exports = router;
