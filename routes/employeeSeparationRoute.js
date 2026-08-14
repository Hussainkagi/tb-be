const express = require("express");
const router = express.Router({ mergeParams: true });

const EmployeeSeparationController = require("../controller/employeeSeparationController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");
const { requireFeature } = require("../middleware/enforceEntitlement");
const { Feature } = require("../enums/features");

// ─────────────────────────────────────────────────────────────────────────────
// Mounted at /api/companies/:company_id/separations
//
// Plan gating sits on the three paths that CREATE something — a resignation, a
// termination, a settlement. The shared workflow endpoints (list, approve,
// reject, complete) are not gated separately: they only ever act on cases that
// already exist, and a case can only exist under a plan that allowed it to be
// raised. Gating them again would mean a company that downgrades mid-notice
// could no longer close cases it is legally obliged to close — the same
// reasoning that keeps payroll reads open in server.js.
//
// Roles: Admin decides and settles. An employee may resign and withdraw their
// own resignation, and see their own case — nothing else.
// ─────────────────────────────────────────────────────────────────────────────

// ── Named routes first, so none of them is read as an :id ────────────────────

// GET /separations/me — the employee's own case and history
router.get("/me", verifyToken, validateTenant, isEmployee,
    EmployeeSeparationController.getMine);

// GET /separations/termination-types — reference data for the form
router.get("/termination-types", verifyToken, validateTenant, isManager,
    EmployeeSeparationController.getTerminationTypes);

// GET /separations/settlements?status=&employee_id=
router.get("/settlements", verifyToken, validateTenant, isAdmin,
    requireFeature(Feature.FINAL_SETTLEMENT, { allowReads: true }),
    EmployeeSeparationController.listSettlements);

// ── Resignation ──────────────────────────────────────────────────────────────

// POST /separations/resignations — the employee resigning for themselves
router.post("/resignations", verifyToken, validateTenant, isEmployee,
    requireFeature(Feature.RESIGNATION),
    EmployeeSeparationController.submitOwnResignation);

// POST /separations/resignations/for-employee — admin filing one on their behalf
// (a resignation handed in on paper or given verbally)
router.post("/resignations/for-employee", verifyToken, validateTenant, isAdmin,
    requireFeature(Feature.RESIGNATION),
    EmployeeSeparationController.submitResignationForEmployee);

// ── Termination ──────────────────────────────────────────────────────────────

// POST /separations/terminations
// { employee_id, termination_type, reason, requested_last_working_date?,
//   notice_period_days?, is_gratuity_forfeited?, forfeiture_reason? }
router.post("/terminations", verifyToken, validateTenant, isAdmin,
    requireFeature(Feature.TERMINATION),
    EmployeeSeparationController.initiateTermination);

// ── The case ─────────────────────────────────────────────────────────────────

// GET /separations?status=&type=&branch_id=&from_date=&to_date=
router.get("/", verifyToken, validateTenant, isAdmin,
    EmployeeSeparationController.list);

router.get("/:id", verifyToken, validateTenant, isAdmin,
    EmployeeSeparationController.getById);

// Editable only while the case is still pending.
router.patch("/:id", verifyToken, validateTenant, isAdmin,
    EmployeeSeparationController.update);

// PATCH /separations/:id/approve — { last_working_date, notice_start_date?,
//                                    is_notice_waived?, decision_notes? }
router.patch("/:id/approve", verifyToken, validateTenant, isAdmin,
    EmployeeSeparationController.approve);

router.patch("/:id/reject", verifyToken, validateTenant, isAdmin,
    EmployeeSeparationController.reject);

// The employee pulling their own resignation, before a decision is taken.
router.patch("/:id/withdraw", verifyToken, validateTenant, isEmployee,
    EmployeeSeparationController.withdraw);

// Admin revoking an accepted case — the employee stays employed.
router.patch("/:id/cancel", verifyToken, validateTenant, isAdmin,
    EmployeeSeparationController.cancel);

// PATCH /separations/:id/complete — last day passed, employee stood down.
// { exit_interview_notes?, is_rehire_eligible?, force?, allow_without_settlement? }
router.patch("/:id/complete", verifyToken, validateTenant, isAdmin,
    EmployeeSeparationController.complete);

// ── Final settlement ─────────────────────────────────────────────────────────

router.use("/:id/settlement", requireFeature(Feature.FINAL_SETTLEMENT, { allowReads: true }));

// GET /separations/:id/settlement/preview — computed live, nothing written
router.get("/:id/settlement/preview", verifyToken, validateTenant, isAdmin,
    EmployeeSeparationController.previewSettlement);

// POST /separations/:id/settlement — freeze the figures and raise the encashment
router.post("/:id/settlement", verifyToken, validateTenant, isAdmin,
    EmployeeSeparationController.saveSettlement);

router.patch("/:id/settlement/approve", verifyToken, validateTenant, isAdmin,
    EmployeeSeparationController.approveSettlement);

router.patch("/:id/settlement/mark-paid", verifyToken, validateTenant, isAdmin,
    EmployeeSeparationController.markSettlementPaid);

module.exports = router;
