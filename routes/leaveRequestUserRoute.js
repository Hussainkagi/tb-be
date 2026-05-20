const express = require("express");
const router = express.Router({ mergeParams: true });

const LeaveRequestController = require("../controller/leaveRequestController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });



// ─────────────────────────────────────────────────────────────────────────────
// EMPLOYEE — create a leave request
// POST /api/companies/:company_id/branches/:branch_id/employees/:employee_id/leave-requests
// ─────────────────────────────────────────────────────────────────────────────

router.post(
    "/",
    upload.single("document_file"),
    verifyToken,
    validateTenant,
    isEmployee,
    LeaveRequestController.create
);

// ─────────────────────────────────────────────────────────────────────────────
// EMPLOYEE — view & manage own leave requests
// NOTE: named routes must come before /:id
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/companies/:company_id/branches/:branch_id/employees/:employee_id/leave-requests
router.get(
    "/",
    verifyToken,
    validateTenant,
    isEmployee,
    LeaveRequestController.getAllByEmployee
);

// GET /api/companies/:company_id/branches/:branch_id/employees/:employee_id/leave-requests/status/:status
router.get(
    "/status/:status",
    verifyToken,
    validateTenant,
    isEmployee,
    LeaveRequestController.getByEmployeeAndStatus
);

// ─────────────────────────────────────────────────────────────────────────────
// EMPLOYEE — update own pending request
// PUT /api/companies/:company_id/branches/:branch_id/employees/:employee_id/leave-requests/:id
// ─────────────────────────────────────────────────────────────────────────────

router.put(
    "/:id",
    verifyToken,
    validateTenant,
    isEmployee,
    LeaveRequestController.update
);

// ─────────────────────────────────────────────────────────────────────────────
// EMPLOYEE — cancel own request
// PATCH /api/companies/:company_id/branches/:branch_id/employees/:employee_id/leave-requests/:id/cancel
// ─────────────────────────────────────────────────────────────────────────────

router.patch(
    "/:id/cancel",
    verifyToken,
    validateTenant,
    isEmployee,
    LeaveRequestController.cancel
);

// ─────────────────────────────────────────────────────────────────────────────
// EMPLOYEE — soft delete own pending request
// DELETE /api/companies/:company_id/branches/:branch_id/employees/:employee_id/leave-requests/:id
// ─────────────────────────────────────────────────────────────────────────────

router.delete(
    "/:id",
    verifyToken,
    validateTenant,
    isEmployee,
    LeaveRequestController.delete
);

// ─────────────────────────────────────────────────────────────────────────────
// SHARED — single record (employee owns it, admin manages it)
// GET /api/companies/:company_id/branches/:branch_id/employees/:employee_id/leave-requests/:id
// ─────────────────────────────────────────────────────────────────────────────

router.get(
    "/:id",
    verifyToken,
    validateTenant,
    isEmployee,
    LeaveRequestController.getById
);

module.exports = router;


// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ROUTES — mount separately in app.js / index.js
//
// const adminLeaveRequestRouter = require("./leaveRequestAdminRoutes");
// app.use("/api/companies/:company_id", adminLeaveRequestRouter);
// ─────────────────────────────────────────────────────────────────────────────