
const express = require("express");
const router = express.Router({ mergeParams: true });

const AttendanceReportController = require("../controller/attendanceReportController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");
const { requireReport } = require("../middleware/enforceEntitlement");
const { ReportKey } = require("../enums/features");

// All routes scoped under /api/companies/:company_id/attendance-reports
// All report endpoints are manager+ only (read-only, no employee access)

// Report access is an ENUM entitlement, not a boolean: each plan carries the
// list of report keys it includes (Trial: casual + detailed; Pro adds working
// hours + headcount; Gold all). Adding a report later means adding its key to
// enums/features.js and ticking it into the plans that should have it — no
// change to this file.


// GET /api/companies/:company_id/attendance-reports/detailed?employeeId=&startDate=&endDate=&timezone=
router.get(
    "/detailed",
    verifyToken,
    validateTenant,
    isManager,
    requireReport(ReportKey.DETAILED),
    AttendanceReportController.getDetailedReport,
);

// GET /api/companies/:company_id/attendance-reports/headcount?employeeId=&startDate=&endDate=&timezone=
router.get(
    "/headcount",
    verifyToken,
    validateTenant,
    isEmployee,
    requireReport(ReportKey.HEADCOUNT),
    AttendanceReportController.getHeadcount,
);

// GET /api/companies/:company_id/attendance-reports/check-in-out-ratio?employeeId=&startDate=&endDate=&timezone=
router.get(
    "/check-in-out-ratio",
    verifyToken,
    validateTenant,
    isManager,
    requireReport(ReportKey.CHECK_IN_OUT_RATIO),
    AttendanceReportController.getCheckInOutRatio,
);

// GET /api/companies/:company_id/attendance-reports/punctuality-ratio?employeeId=&startDate=&endDate=&timezone=
router.get(
    "/punctuality-ratio",
    verifyToken,
    validateTenant,
    isManager,
    requireReport(ReportKey.PUNCTUALITY),
    AttendanceReportController.getPunctualityRatio,
);

// GET /api/companies/:company_id/attendance-reports/working-hours?employeeId=&startDate=&endDate=&timezone=
router.get(
    "/working-hours",
    verifyToken,
    validateTenant,
    isManager,
    requireReport(ReportKey.WORKING_HOURS),
    AttendanceReportController.getWorkingHours,
);

// GET /api/companies/:company_id/attendance-reports/casual?employeeId=&startDate=&endDate=&branchId=&departmentId=
router.get(
    "/casual",
    verifyToken,
    validateTenant,
    isManager,
    requireReport(ReportKey.CASUAL),
    AttendanceReportController.getCasualReport,
);

module.exports = router;