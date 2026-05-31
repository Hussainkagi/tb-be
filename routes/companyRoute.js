const express = require("express");
const router = express.Router();

const CompanyController = require("../controller/companyController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager, isEmployee } = require("../middleware/authorizeRoles");

// ─────────────────────────────────────────────
// PUBLIC
// ─────────────────────────────────────────────
// None — companies are created via /auth/register (userCompanyRoutes)

// ─────────────────────────────────────────────
// ADMIN ONLY
// ─────────────────────────────────────────────
router.get("/", verifyToken, isAdmin, CompanyController.getAll);
router.get("/:id", verifyToken, isEmployee, CompanyController.getById);
router.get("/code/:code", verifyToken, isAdmin, CompanyController.getByCode);
router.put("/:id", verifyToken, isAdmin, CompanyController.update);
router.patch("/:id/plan", verifyToken, isAdmin, CompanyController.updatePlan);
router.patch("/:id/deactivate", verifyToken, isAdmin, CompanyController.deactivate);
router.delete("/:id", verifyToken, isAdmin, CompanyController.delete);

module.exports = router;