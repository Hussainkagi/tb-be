const express = require("express");
const router = express.Router({ mergeParams: true });
const multer = require("multer");

const AttendanceController = require("../controller/attendanceController");
const AttendanceRequestController = require("../controller/attendanceRequestController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");
const { requireEmployeeAccess } = require("../middleware/employeeAccess");
const { requireFeature, stripUnentitledUpload } = require("../middleware/enforceEntitlement");
const { Feature } = require("../enums/features");

// ---------------------------------------------------------------------------
// Multer — memory storage so req.file.buffer is available for Cloudinary
// ---------------------------------------------------------------------------
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
    fileFilter(req, file, cb) {
        if (!file.mimetype.startsWith("image/")) {
            return cb(new Error("Only image files are allowed for selfie upload"));
        }
        cb(null, true);
    },
});

// All routes scoped under /api/companies/:company_id/attendance

// ─────────────────────────────────────────────
// EMPLOYEE — self check-in / check-out
// ─────────────────────────────────────────────
// Photo verification is Pro+. It is stripped, not rejected: the selfie is an
// optional part of the payload, and 403-ing the whole request would stop a
// Trial employee from clocking in at all. The check-in is written without the
// photo and the response carries X-Feature-Stripped.
router.post(
    "/check-in",
    verifyToken,
    validateTenant,
    isEmployee,
    upload.single("selfie"),        // field name: "selfie"  → req.file
    stripUnentitledUpload(Feature.ATTENDANCE_PHOTO),
    AttendanceController.checkIn,
);

router.post(
    "/check-out",
    verifyToken,
    validateTenant,
    isEmployee,
    upload.single("selfie"),        // field name: "selfie"  → req.file
    stripUnentitledUpload(Feature.ATTENDANCE_PHOTO),
    AttendanceController.checkOut,
);

// ─────────────────────────────────────────────
// ADMIN + MANAGER — company-wide views
// ─────────────────────────────────────────────

// GET /api/companies/:company_id/attendance?startDate=&endDate=
router.get("/", verifyToken, validateTenant, isManager, AttendanceController.getByCompany);

// GET /api/companies/:company_id/attendance/summary?startDate=&endDate=
router.get("/summary", verifyToken, validateTenant, isManager, AttendanceController.getSummary);

// GET /api/companies/:company_id/attendance/map?startDate=&endDate=
// Branch attendance map — Pro+.
router.get("/map", verifyToken, validateTenant, isManager, requireFeature(Feature.ATTENDANCE_BRANCH_MAP), AttendanceController.getCheckInLocations);

// ─────────────────────────────────────────────
// ADMIN + MANAGER — nested filters
// ─────────────────────────────────────────────

// GET /api/companies/:company_id/attendance/branch/:branch_id?startDate=&endDate=
router.get("/branch/:branch_id", verifyToken, validateTenant, isManager, AttendanceController.getByBranch);

// GET /api/companies/:company_id/attendance/employee/:employee_id?startDate=&endDate=
// Employees: their own history only. Managers: anyone in this company.
router.get("/employee/:employee_id", verifyToken, validateTenant, isEmployee, requireEmployeeAccess("employee_id"), AttendanceController.getByEmployee);

// ─────────────────────────────────────────────
// ATTENDANCE REQUESTS — check in/out from outside the allowed places,
// approved by an admin. Declared before "/:id" so "requests" is not an id.
// ─────────────────────────────────────────────
router.post(
    "/requests",
    verifyToken,
    validateTenant,
    isEmployee,
    upload.single("selfie"),
    stripUnentitledUpload(Feature.ATTENDANCE_PHOTO),
    AttendanceRequestController.create,
);
router.get("/requests/mine", verifyToken, validateTenant, isEmployee, AttendanceRequestController.listMine);
router.get("/requests", verifyToken, validateTenant, isAdmin, AttendanceRequestController.list);
router.post("/requests/review", verifyToken, validateTenant, isAdmin, AttendanceRequestController.review);

// GET /api/companies/:company_id/attendance/me/calendar?month=YYYY-MM
// The caller's own month, current by default. The employee is resolved from the token.
router.get("/me/calendar", verifyToken, validateTenant, isEmployee, requireFeature(Feature.ATTENDANCE_SELF_HISTORY), AttendanceController.getMyCalendar);

// ─────────────────────────────────────────────
// SINGLE RECORD
// ─────────────────────────────────────────────

// GET /api/companies/:company_id/attendance/:id
router.get("/:id", verifyToken, validateTenant, isManager, AttendanceController.getById);

// PUT /api/companies/:company_id/attendance/:id  (admin override — remarks, status, etc.)
router.put("/:id", verifyToken, validateTenant, isAdmin, AttendanceController.update);

// DELETE /api/companies/:company_id/attendance/:id
router.delete("/:id", verifyToken, validateTenant, isAdmin, AttendanceController.delete);

// ---------------------------------------------------------------------------
// Multer error handler — must be defined after the routes that use it
// ---------------------------------------------------------------------------
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || err.message === "Only image files are allowed for selfie upload") {
        return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
});

module.exports = router;