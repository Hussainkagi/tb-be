const express = require("express");
const router = express.Router({ mergeParams: true });

const LeaveRequestController = require("../controller/leaveRequestController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// ─────────────────────────────────────────────────────────────────────────────
// All admin routes scoped under /api/companies/:company_id
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────
// ADMIN — company-wide list & filtered views
// NOTE: named routes must come before /:id style params
// ─────────────────────────────────────────────

// GET /api/companies/:company_id/leave-requests
router.get(
    "/leave-requests",
    verifyToken,
    validateTenant,
    isAdmin,
    LeaveRequestController.getAllByCompany
);

// GET /api/companies/:company_id/leave-requests/status/:status
router.get(
    "/leave-requests/status/:status",
    verifyToken,
    validateTenant,
    isAdmin,
    LeaveRequestController.getByCompanyAndStatus
);

// GET /api/companies/:company_id/leave-requests/date-range?from_date=&to_date=&branch_id=
router.get(
    "/leave-requests/date-range",
    verifyToken,
    validateTenant,
    isAdmin,
    LeaveRequestController.getByDateRange
);

// ─────────────────────────────────────────────
// ADMIN — branch-scoped list & filtered views
// ─────────────────────────────────────────────

// GET /api/companies/:company_id/branches/:branch_id/leave-requests
router.get(
    "/branches/:branch_id/leave-requests",
    verifyToken,
    validateTenant,
    isAdmin,
    LeaveRequestController.getAllByBranch
);

// GET /api/companies/:company_id/branches/:branch_id/leave-requests/status/:status
router.get(
    "/branches/:branch_id/leave-requests/status/:status",
    verifyToken,
    validateTenant,
    isAdmin,
    LeaveRequestController.getByBranchAndStatus
);

// ─────────────────────────────────────────────
// ADMIN — single record
// ─────────────────────────────────────────────

// GET /api/companies/:company_id/leave-requests/:id
router.get(
    "/leave-requests/:id",
    verifyToken,
    validateTenant,
    isAdmin,
    LeaveRequestController.getById
);

// ─────────────────────────────────────────────
// ADMIN — approval workflow
// ─────────────────────────────────────────────

// PATCH /api/companies/:company_id/leave-requests/:id/approve
router.patch(
    "/leave-requests/:id/approve",
    verifyToken,
    validateTenant,
    isAdmin,
    LeaveRequestController.approve
);

// PATCH /api/companies/:company_id/leave-requests/:id/reject
router.patch(
    "/leave-requests/:id/reject",
    verifyToken,
    validateTenant,
    isAdmin,
    LeaveRequestController.reject
);

module.exports = router;