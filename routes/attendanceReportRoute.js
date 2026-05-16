const express = require("express");
const router = express.Router({ mergeParams: true });

const AttendanceReportController = require("../controller/attendanceReportController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// All routes scoped under /api/companies/:company_id/attendance-reports
// All report endpoints are manager+ only (read-only, no employee access)

// GET /api/companies/:company_id/attendance-reports/detailed?employeeId=&startDate=&endDate=&timezone=
router.get(
    "/detailed",
    verifyToken,
    validateTenant,
    isManager,
    AttendanceReportController.getDetailedReport,
);

// GET /api/companies/:company_id/attendance-reports/headcount?employeeId=&startDate=&endDate=&timezone=
router.get(
    "/headcount",
    verifyToken,
    validateTenant,
    isManager,
    AttendanceReportController.getHeadcount,
);

// GET /api/companies/:company_id/attendance-reports/check-in-out-ratio?employeeId=&startDate=&endDate=&timezone=
router.get(
    "/check-in-out-ratio",
    verifyToken,
    validateTenant,
    isManager,
    AttendanceReportController.getCheckInOutRatio,
);

// GET /api/companies/:company_id/attendance-reports/punctuality-ratio?employeeId=&startDate=&endDate=&timezone=
router.get(
    "/punctuality-ratio",
    verifyToken,
    validateTenant,
    isManager,
    AttendanceReportController.getPunctualityRatio,
);

// GET /api/companies/:company_id/attendance-reports/working-hours?employeeId=&startDate=&endDate=&timezone=
router.get(
    "/working-hours",
    verifyToken,
    validateTenant,
    isManager,
    AttendanceReportController.getWorkingHours,
);

module.exports = router;