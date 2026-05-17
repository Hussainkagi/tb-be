const express = require("express");
const router = express.Router({ mergeParams: true });

const HolidayController = require("../controller/holidayController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// All routes scoped under /api/companies/:company_id/holidays

// ─────────────────────────────────────────────
// COMPANY-WIDE HOLIDAYS
// ─────────────────────────────────────────────

// GET  /api/companies/:company_id/holidays
router.get(
    "/",
    verifyToken,
    validateTenant,
    isEmployee,                             // all roles can view holidays
    HolidayController.getAllByCompany
);

// GET  /api/companies/:company_id/holidays/company-wide
router.get(
    "/company-wide",
    verifyToken,
    validateTenant,
    isEmployee,
    HolidayController.getCompanyWide
);

// POST /api/companies/:company_id/holidays
router.post(
    "/",
    verifyToken,
    validateTenant,
    isAdmin,                                // only admin can create holidays
    HolidayController.create
);

// ─────────────────────────────────────────────
// BRANCH-SCOPED HOLIDAYS
// ─────────────────────────────────────────────

// GET  /api/companies/:company_id/branches/:branch_id/holidays
// Main employee-facing API — returns company-wide + branch-specific merged
router.get(
    "/branch/:branch_id",
    verifyToken,
    validateTenant,
    isEmployee,
    HolidayController.getAllByBranch
);

// GET  /api/companies/:company_id/branches/:branch_id/holidays/branch-only
router.get(
    "/branch/:branch_id/branch-only",
    verifyToken,
    validateTenant,
    isManager,
    HolidayController.getBranchSpecific
);

// ─────────────────────────────────────────────
// ATTENDANCE / PAYROLL HELPERS
// ─────────────────────────────────────────────

// GET  /api/companies/:company_id/branches/:branch_id/holidays/check?date=YYYY-MM-DD
// Used by attendance service before allowing check-in/out
router.get(
    "/branch/:branch_id/check",
    verifyToken,
    validateTenant,
    isEmployee,
    HolidayController.checkIsHoliday
);

// GET  /api/companies/:company_id/branches/:branch_id/holidays/range?from=YYYY-MM-DD&to=YYYY-MM-DD
// Used by payroll service for monthly holiday count
router.get(
    "/branch/:branch_id/range",
    verifyToken,
    validateTenant,
    isManager,
    HolidayController.getByDateRange
);

// ─────────────────────────────────────────────
// SINGLE RECORD
// ─────────────────────────────────────────────

// GET    /api/companies/:company_id/holidays/:id
router.get(
    "/:id",
    verifyToken,
    validateTenant,
    isManager,
    HolidayController.getById
);

// PUT    /api/companies/:company_id/holidays/:id
router.put(
    "/:id",
    verifyToken,
    validateTenant,
    isAdmin,
    HolidayController.update
);

// PATCH  /api/companies/:company_id/holidays/:id/activate
router.patch(
    "/:id/activate",
    verifyToken,
    validateTenant,
    isAdmin,
    HolidayController.activate
);

// PATCH  /api/companies/:company_id/holidays/:id/deactivate
router.patch(
    "/:id/deactivate",
    verifyToken,
    validateTenant,
    isAdmin,
    HolidayController.deactivate
);

// DELETE /api/companies/:company_id/holidays/:id
router.delete(
    "/:id",
    verifyToken,
    validateTenant,
    isAdmin,
    HolidayController.delete
);

module.exports = router;