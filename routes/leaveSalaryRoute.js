const express = require("express");
const router = express.Router({ mergeParams: true });

const LeaveSalaryController = require("../controller/leaveSalaryController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");
const { requireFeature } = require("../middleware/enforceEntitlement");
const { Feature } = require("../enums/features");

// ─────────────────────────────────────────────────────────────────────────────
// Mounted at /api/companies/:company_id/leave-salary
//
// The router itself is mounted behind requireFeature(LEAVE_SALARY) in
// server.js. The two payout paths carry their own keys on top of that, so a
// plan can sell accrual tracking without opening the payment paths — and so
// they can be priced separately later without touching this file.
//
// Amounts are payroll-sensitive: Admin for anything that shows or moves money,
// Manager for the read-only balance views, and every employee for their own.
// ─────────────────────────────────────────────────────────────────────────────

// ── Employee self-service ────────────────────────────────────────────────────
// Ahead of /employees/:employee_id so "me" is never read as an id.

// GET /leave-salary/me — the signed-in employee's own bucket
router.get("/me", verifyToken, validateTenant, isEmployee,
    LeaveSalaryController.getMine);

// ── Configuration ────────────────────────────────────────────────────────────

// GET /leave-salary/config — resolved rules + the statutory defaults behind them
router.get("/config", verifyToken, validateTenant, isManager,
    LeaveSalaryController.getConfig);

router.put("/config", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.upsertConfig);

// PATCH /leave-salary/leave-types/:leave_type_id — { counts_toward_leave_salary }
// Which leave types draw the bucket down. Until at least one is flagged,
// annual leave taken never reduces the balance.
router.patch("/leave-types/:leave_type_id", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.setLeaveTypeCounting);

// ── Company-wide ─────────────────────────────────────────────────────────────

// GET /leave-salary/summary?branch_id=&as_of_date=
// What each employee has collected, and the total accrued liability.
router.get("/summary", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.companySummary);

// POST /leave-salary/accruals/run — book every completed month.
// { as_of_date?, employee_id?, branch_id?, dry_run?, recalculate? }
router.post("/accruals/run", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.runAccrual);

// ── Advance leave salary ─────────────────────────────────────────────────────
// Paid before the employee proceeds on leave (UAE Art. 29).

router.use("/advances", requireFeature(Feature.LEAVE_SALARY_ADVANCE, { allowReads: true }));

// GET /leave-salary/advances/preview?employee_id=&from_date=&to_date=
router.get("/advances/preview", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.previewAdvance);

// GET /leave-salary/advances?status=&employee_id=&payroll_month=
router.get("/advances", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.listAdvances);

// POST /leave-salary/advances — { employee_id, leave_request_id | from_date+to_date }
router.post("/advances", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.createAdvance);

router.patch("/advances/:id/approve", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.approveAdvance);

router.patch("/advances/:id/mark-paid", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.markAdvancePaid);

router.patch("/advances/:id/cancel", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.cancelAdvance);

// ── Encashment ───────────────────────────────────────────────────────────────
// Unused balance cashed out. These days DO leave the bucket.

router.use("/encashments", requireFeature(Feature.LEAVE_SALARY_ENCASHMENT, { allowReads: true }));

// GET /leave-salary/encashments?status=&employee_id=&encashment_type=
router.get("/encashments", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.listEncashments);

// POST /leave-salary/encashments — { employee_id, days | encash_full_balance }
router.post("/encashments", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.createEncashment);

router.patch("/encashments/:id/approve", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.approveEncashment);

router.patch("/encashments/:id/mark-paid", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.markEncashmentPaid);

router.patch("/encashments/:id/cancel", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.cancelEncashment);

// ── Per employee ─────────────────────────────────────────────────────────────

// GET /leave-salary/employees/:employee_id?as_of_date=
// Balance, ledger and every payout raised against it.
router.get("/employees/:employee_id", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.getForEmployee);

// GET /leave-salary/employees/:employee_id/accruals?year=
router.get("/employees/:employee_id/accruals", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.getAccrualLedger);

// GET /leave-salary/employees/:employee_id/unpaid-leave-deduction?payroll_month=YYYY-MM
// Indicative only — payroll generation applies the actual deduction.
router.get("/employees/:employee_id/unpaid-leave-deduction", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.getUnpaidLeaveDeduction);

// PUT /leave-salary/employees/:employee_id/config
// Calculation base, accrual start and the opening balance carried in from
// whatever the company used before.
router.put("/employees/:employee_id/config", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.upsertEmployeeConfig);

// Revert to the company settings.
router.delete("/employees/:employee_id/config", verifyToken, validateTenant, isAdmin,
    LeaveSalaryController.removeEmployeeConfig);

module.exports = router;
