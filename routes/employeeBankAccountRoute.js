const express = require("express");
const router = express.Router({ mergeParams: true });

const EmployeeBankAccountController = require("../controller/employeeBankAccountController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// ─────────────────────────────────────────────────────────────────────────────
// Mounted at /api/companies/:company_id/bank-accounts
//
// Bank details are payroll-sensitive, so reads and writes are Admin-only.
// The field specs are static metadata, so Managers can fetch those to render
// the form.
// ─────────────────────────────────────────────────────────────────────────────

// ── Field specs (metadata — drives the dynamic form) ─────────────────────────

// Countries that have a dedicated bank-detail format
router.get("/field-specs", verifyToken, validateTenant, isManager,
    EmployeeBankAccountController.listCountries);

// Field spec for one country. Any ISO2 code works; unknown ones return the
// generic international form with is_generic = true.
router.get("/field-specs/:country_code", verifyToken, validateTenant, isManager,
    EmployeeBankAccountController.getFieldSpec);

// ── Company-wide ─────────────────────────────────────────────────────────────

// ?work_country=IN to filter
router.get("/", verifyToken, validateTenant, isAdmin,
    EmployeeBankAccountController.listByCompany);

// ── Per employee ─────────────────────────────────────────────────────────────

// The account salary is paid into
router.get("/employees/:employee_id", verifyToken, validateTenant, isAdmin,
    EmployeeBankAccountController.getForEmployee);

// Full list (history, if more than one was ever added)
router.get("/employees/:employee_id/all", verifyToken, validateTenant, isAdmin,
    EmployeeBankAccountController.listForEmployee);

// Create or replace the primary account.
// Body: { work_country: "IN", account_holder_name, bank_name, account_number, ifsc_code, ... }
router.post("/employees/:employee_id", verifyToken, validateTenant, isAdmin,
    EmployeeBankAccountController.upsertForEmployee);

router.put("/employees/:employee_id", verifyToken, validateTenant, isAdmin,
    EmployeeBankAccountController.upsertForEmployee);

// ── By account id ────────────────────────────────────────────────────────────

router.put("/:id", verifyToken, validateTenant, isAdmin,
    EmployeeBankAccountController.update);

router.delete("/:id", verifyToken, validateTenant, isAdmin,
    EmployeeBankAccountController.remove);

module.exports = router;
