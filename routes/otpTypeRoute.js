const express = require("express");
const router = express.Router();

const OtpController = require("../controller/otpTypeController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin } = require("../middleware/authorizeRoles");

// ─────────────────────────────────────────────
// ADMIN ONLY
// ─────────────────────────────────────────────

// Cleanup expired OTP records — call via cron or manual admin trigger
router.delete("/otp/expired", verifyToken, isAdmin, OtpController.deleteExpired);

module.exports = router;