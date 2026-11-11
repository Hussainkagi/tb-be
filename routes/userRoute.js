const express = require("express");
const router = express.Router();

const UserController = require("../controller/userController");
const verifyToken = require("../middleware/verifyToken");
const isSelfOrAdmin = require("../middleware/isSelfOrAdmin");
const { requireSuperAdmin } = require("../middleware/isSuperAdmin");

// ─────────────────────────────────────────────
// PUBLIC
// ─────────────────────────────────────────────
// No direct user creation — handled via /auth/register
// Password reset flows live in userCompanyRoutes under /auth

// ─────────────────────────────────────────────
// AUTHENTICATED — SELF OR ADMIN
// ─────────────────────────────────────────────
router.get("/:id", verifyToken, isSelfOrAdmin, UserController.getById);
router.put("/:id", verifyToken, isSelfOrAdmin, UserController.update);

// ─────────────────────────────────────────────
// ADMIN ONLY
// ─────────────────────────────────────────────
// Users span every company, so listing or deleting them is a platform action.
router.get("/", verifyToken, requireSuperAdmin, UserController.getAll);
router.delete("/:id", verifyToken, requireSuperAdmin, UserController.delete);

module.exports = router;