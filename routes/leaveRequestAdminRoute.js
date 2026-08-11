const express = require("express");
const router = express.Router({ mergeParams: true });

const LeaveRequestController = require("../controller/leaveRequestController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isEmployee } = require("../middleware/authorizeRoles");
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

// GET /api/companies/:company_id/leave-requests/stage/:stage   (hod | admin | completed)
// The admin's action queue is stage=admin — requests that cleared the HOD leg
// (or never needed one). stage=hod shows what is still with the department heads.
router.get(
    "/leave-requests/stage/:stage",
    verifyToken,
    validateTenant,
    isAdmin,
    LeaveRequestController.getByCompanyAndStage
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

// ─────────────────────────────────────────────
// HEAD OF DEPARTMENT — stage one of the approval workflow
//
// A head of department normally holds the Employee role, so these routes are
// authorised by identity (does this user head a department?) inside the
// service, not by role. isEmployee only keeps anonymous callers out.
// ─────────────────────────────────────────────

// GET /api/companies/:company_id/hod/leave-requests?stage=hod|admin|all&status=
router.get(
    "/hod/leave-requests",
    verifyToken,
    validateTenant,
    isEmployee,
    LeaveRequestController.getForHod
);

// PATCH /api/companies/:company_id/hod/leave-requests/:id/approve
router.patch(
    "/hod/leave-requests/:id/approve",
    verifyToken,
    validateTenant,
    isEmployee,
    LeaveRequestController.hodApprove
);

// PATCH /api/companies/:company_id/hod/leave-requests/:id/reject
router.patch(
    "/hod/leave-requests/:id/reject",
    verifyToken,
    validateTenant,
    isEmployee,
    LeaveRequestController.hodReject
);

module.exports = router;