const express = require("express");
const router = express.Router({ mergeParams: true });

const LeaveTypeController = require("../controller/leaveTypeController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");
const { requireFeature } = require("../middleware/enforceEntitlement");
const { Feature } = require("../enums/features");

// Leave balance & policy CONFIGURATION is Pro+. Trial companies still apply
// for, approve and view leave — they just run on the seeded default types
// instead of authoring their own. So /seed-defaults and every GET stay open;
// creating, editing, toggling and deleting leave types are gated.
const requireLeaveConfig = requireFeature(Feature.LEAVE_POLICY_CONFIG);

// All routes scoped under /api/companies/:company_id/leave-types

// ─────────────────────────────────────────────
// ADMIN — onboarding check (show/hide seed button)
// ─────────────────────────────────────────────

// GET /api/companies/:company_id/leave-types/has-defaults
router.get(
    "/has-defaults",
    verifyToken,
    validateTenant,
    isAdmin,
    LeaveTypeController.checkLeaveTypesExist
);

// ─────────────────────────────────────────────
// ADMIN — seed defaults (one-time action)
// ─────────────────────────────────────────────

// POST /api/companies/:company_id/leave-types/seed-defaults
router.post(
    "/seed-defaults",
    verifyToken,
    validateTenant,
    isAdmin,
    LeaveTypeController.seedDefaults
);

// ─────────────────────────────────────────────
// ADMIN — create custom leave type
// ─────────────────────────────────────────────

// POST /api/companies/:company_id/leave-types
router.post(
    "/",
    verifyToken,
    validateTenant,
    isAdmin,
    requireLeaveConfig,
    LeaveTypeController.create
);

// ─────────────────────────────────────────────
// ADMIN — filtered list views
// NOTE: named routes must come before /:id
// ─────────────────────────────────────────────

// GET /api/companies/:company_id/leave-types/active
router.get(
    "/active",
    verifyToken,
    validateTenant,
    isEmployee,
    LeaveTypeController.getActive
);

// GET /api/companies/:company_id/leave-types/paid
router.get(
    "/paid",
    verifyToken,
    validateTenant,
    isAdmin,
    LeaveTypeController.getPaid
);

// GET /api/companies/:company_id/leave-types/unpaid
router.get(
    "/unpaid",
    verifyToken,
    validateTenant,
    isAdmin,
    LeaveTypeController.getUnpaid
);

// GET /api/companies/:company_id/leave-types/carry-forward
router.get(
    "/carry-forward",
    verifyToken,
    validateTenant,
    isAdmin,
    LeaveTypeController.getCarryForward
);

// ─────────────────────────────────────────────
// ADMIN — company-wide list
// ─────────────────────────────────────────────

// GET /api/companies/:company_id/leave-types
router.get(
    "/",
    verifyToken,
    validateTenant,
    isEmployee,
    LeaveTypeController.getAllByCompany
);

// ─────────────────────────────────────────────
// ADMIN — single record
// ─────────────────────────────────────────────

// GET /api/companies/:company_id/leave-types/:id
router.get(
    "/:id",
    verifyToken,
    validateTenant,
    isAdmin,
    LeaveTypeController.getById
);

// PUT /api/companies/:company_id/leave-types/:id
router.put(
    "/:id",
    verifyToken,
    validateTenant,
    isAdmin,
    requireLeaveConfig,
    LeaveTypeController.update
);

// ─────────────────────────────────────────────
// ADMIN — toggle active state
// ─────────────────────────────────────────────

// PATCH /api/companies/:company_id/leave-types/:id/activate
router.patch(
    "/:id/activate",
    verifyToken,
    validateTenant,
    isAdmin,
    requireLeaveConfig,
    LeaveTypeController.activate
);

// PATCH /api/companies/:company_id/leave-types/:id/deactivate
router.patch(
    "/:id/deactivate",
    verifyToken,
    validateTenant,
    isAdmin,
    requireLeaveConfig,
    LeaveTypeController.deactivate
);

// ─────────────────────────────────────────────
// ADMIN — soft delete
// ─────────────────────────────────────────────

// DELETE /api/companies/:company_id/leave-types/:id
router.delete(
    "/:id",
    verifyToken,
    validateTenant,
    isAdmin,
    requireLeaveConfig,
    LeaveTypeController.delete
);

module.exports = router;