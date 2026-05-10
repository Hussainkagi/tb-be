const express = require("express");
const router = express.Router();

const UserController = require("../controller/userController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isEmployee } = require("../middleware/authorizeRoles");
const isSelfOrAdmin = require("../middleware/isSelfOrAdmin");

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
router.get("/", verifyToken, isAdmin, UserController.getAll);
router.delete("/:id", verifyToken, isAdmin, UserController.delete);

module.exports = router;