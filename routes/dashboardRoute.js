const express = require("express");
const router = express.Router({ mergeParams: true });

const DashboardController = require("../controller/dashboardController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// All routes scoped under /api/companies/:company_id/dashboard
//
// Read-only company-wide statistics. Admin only, except the operational
// attendance views, which a branch manager also needs day to day.

// GET /api/companies/:company_id/dashboard/overview
//     ?branchId=&sections=today,warnings&rangeDays=30&upcomingDays=30&sampleLimit=5
router.get(
    "/overview",
    verifyToken,
    validateTenant,
    isAdmin,
    DashboardController.getOverview
);

// GET /api/companies/:company_id/dashboard/attendance/today
//     ?view=checked-in|missing&branchId=&departmentId=&attendanceStatus=late&onlyOpen=true&date=&page=&limit=
router.get(
    "/attendance/today",
    verifyToken,
    validateTenant,
    isManager,
    DashboardController.getTodayAttendance
);

// GET /api/companies/:company_id/dashboard/warnings
//     ?severity=critical&sampleLimit=10&expiryWindowDays=60
router.get(
    "/warnings",
    verifyToken,
    validateTenant,
    isAdmin,
    DashboardController.getWarnings
);

// GET /api/companies/:company_id/dashboard/branches?startDate=&endDate=
router.get(
    "/branches",
    verifyToken,
    validateTenant,
    isAdmin,
    DashboardController.getBranchStats
);

// GET /api/companies/:company_id/dashboard/upcoming?branchId=&days=30
router.get(
    "/upcoming",
    verifyToken,
    validateTenant,
    isManager,
    DashboardController.getUpcoming
);

module.exports = router;
