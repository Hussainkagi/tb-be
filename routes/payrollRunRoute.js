const express = require("express");
const router = express.Router({ mergeParams: true });

const PayrollRunController = require("../controller/payrollRunController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// All routes scoped under /api/companies/:company_id/payroll-runs
//
// Role split follows maker-checker:
//   isManager (Admin or Manager) → MAKER actions: start, generate, adjust,
//                                  submit, issue and send payslips
//   isAdmin                      → CHECKER actions: approve, reject, pay,
//                                  complete, cancel, and settings
//
// The service adds the rule roles alone cannot express: the person who
// prepared a run may not approve it, whatever their role.

// ─────────────────────────────────────────────
// RESUME — "continue where you left off"
// ─────────────────────────────────────────────
router.get("/resume", verifyToken, validateTenant, isManager, PayrollRunController.resume);

// ─────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────
router.get("/settings", verifyToken, validateTenant, isManager, PayrollRunController.getSettings);
router.put("/settings", verifyToken, validateTenant, isAdmin, PayrollRunController.updateSettings);

// ─────────────────────────────────────────────
// APPROVAL QUEUE (checker's inbox)
// ─────────────────────────────────────────────
router.get("/pending-approval", verifyToken, validateTenant, isAdmin, PayrollRunController.pendingApprovals);

// ─────────────────────────────────────────────
// READ
// ─────────────────────────────────────────────
router.get("/", verifyToken, validateTenant, isManager, PayrollRunController.list);
router.get("/:run_id", verifyToken, validateTenant, isManager, PayrollRunController.getById);
router.get("/:run_id/timeline", verifyToken, validateTenant, isManager, PayrollRunController.timeline);

// ─────────────────────────────────────────────
// MAKER — steps 1 to 4
// ─────────────────────────────────────────────
router.post("/", verifyToken, validateTenant, isManager, PayrollRunController.start);
router.post("/:run_id/generate", verifyToken, validateTenant, isManager, PayrollRunController.generate);
router.post("/:run_id/adjustments/sync", verifyToken, validateTenant, isManager, PayrollRunController.syncAdjustments);
router.post("/:run_id/submit", verifyToken, validateTenant, isManager, PayrollRunController.submit);

// ─────────────────────────────────────────────
// CHECKER — steps 5 and 6
// ─────────────────────────────────────────────
router.post("/:run_id/approve", verifyToken, validateTenant, isAdmin, PayrollRunController.approve);
router.post("/:run_id/reject", verifyToken, validateTenant, isAdmin, PayrollRunController.reject);
// Read first — this is what the confirmation dialog shows before paying.
router.get("/:run_id/payment-summary", verifyToken, validateTenant, isAdmin, PayrollRunController.paymentSummary);
router.post("/:run_id/pay", verifyToken, validateTenant, isAdmin, PayrollRunController.pay);

// ─────────────────────────────────────────────
// PAYSLIPS — step 7
// (also run automatically by /pay when the confirmation dialog opts in)
// ─────────────────────────────────────────────
router.post("/:run_id/payslips/generate", verifyToken, validateTenant, isManager, PayrollRunController.generatePayslips);
router.post("/:run_id/payslips/email", verifyToken, validateTenant, isManager, PayrollRunController.emailPayslips);
router.post("/:run_id/payslips/notify", verifyToken, validateTenant, isManager, PayrollRunController.notifyEmployees);

// ─────────────────────────────────────────────
// CLOSE OUT
// ─────────────────────────────────────────────
router.post("/:run_id/complete", verifyToken, validateTenant, isAdmin, PayrollRunController.complete);
router.post("/:run_id/cancel", verifyToken, validateTenant, isAdmin, PayrollRunController.cancel);

module.exports = router;
