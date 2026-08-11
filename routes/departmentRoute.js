const express = require("express");
const router = express.Router({ mergeParams: true });

const DepartmentController = require("../controller/departmentController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// All routes scoped under /api/companies/:company_id/branches/:branch_id/departments

// ─────────────────────────────────────────────
// ADMIN + MANAGER
// ─────────────────────────────────────────────
router.get("/", verifyToken, validateTenant, isManager, DepartmentController.getByBranch);
router.get("/company", verifyToken, validateTenant, isManager, DepartmentController.getByCompany);
// Departments that have employees but no head — must come before "/:id"
router.get("/missing-heads", verifyToken, validateTenant, isManager, DepartmentController.getMissingHeads);
router.get("/:id", verifyToken, validateTenant, isManager, DepartmentController.getById);
router.get("/:id/head-status", verifyToken, validateTenant, isManager, DepartmentController.getHeadStatus);
router.put("/:id/head", verifyToken, validateTenant, isAdmin, DepartmentController.setHead);
router.delete("/:id/head", verifyToken, validateTenant, isAdmin, DepartmentController.removeHead);
router.post("/", verifyToken, validateTenant, isAdmin, DepartmentController.create);
router.put("/:id", verifyToken, validateTenant, isManager, DepartmentController.update);
router.patch("/:id/deactivate", verifyToken, validateTenant, isAdmin, DepartmentController.deactivate);
router.delete("/:id", verifyToken, validateTenant, isAdmin, DepartmentController.delete);

module.exports = router;