const express = require("express");
const router = express.Router({ mergeParams: true });

const ShiftController = require("../controller/shiftController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// All routes scoped under /api/companies/:company_id/branches/:branch_id/shifts

// ─────────────────────────────────────────────
// ADMIN + MANAGER
// ─────────────────────────────────────────────
router.get("/", verifyToken, validateTenant, isManager, ShiftController.getByBranch);
router.get("/company", verifyToken, validateTenant, isManager, ShiftController.getByCompany);
router.get("/:id", verifyToken, validateTenant, isEmployee, ShiftController.getById);
router.post("/", verifyToken, validateTenant, isAdmin, ShiftController.create);
router.put("/:id", verifyToken, validateTenant, isManager, ShiftController.update);
router.patch("/:id/deactivate", verifyToken, validateTenant, isAdmin, ShiftController.deactivate);
router.delete("/:id", verifyToken, validateTenant, isAdmin, ShiftController.delete);

// ─────────────────────────────────────────────
// ALL AUTHENTICATED — used by attendance service
// ─────────────────────────────────────────────
router.get("/:id/timing", verifyToken, validateTenant, isEmployee, ShiftController.getTiming);

module.exports = router;