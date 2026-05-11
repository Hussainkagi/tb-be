const express = require("express");
const router = express.Router({ mergeParams: true });

const BranchController = require("../controller/branchController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// All routes scoped under /api/companies/:company_id/branches

// ─────────────────────────────────────────────
// ADMIN + MANAGER
// ─────────────────────────────────────────────
router.get("/", verifyToken, validateTenant, isManager, BranchController.getByCompany);
router.get("/:id", verifyToken, validateTenant, isManager, BranchController.getById);
router.post("/", verifyToken, validateTenant, isAdmin, BranchController.create);
router.put("/:id", verifyToken, validateTenant, isManager, BranchController.update);
router.patch("/:id/deactivate", verifyToken, validateTenant, isAdmin, BranchController.deactivate);
router.delete("/:id", verifyToken, validateTenant, isAdmin, BranchController.delete);

// ─────────────────────────────────────────────
// ALL AUTHENTICATED — used by attendance service
// ─────────────────────────────────────────────
router.get("/:id/geofence", verifyToken, validateTenant, isEmployee, BranchController.getGeofence);

module.exports = router;