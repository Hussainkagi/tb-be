const express = require("express");
const router = express.Router({ mergeParams: true });

const ActivityLogController = require("../controller/activityLogController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// ─────────────────────────────────────────────
// COMPANY ADMIN ONLY — a company's own activity trail
// Mounted at /api/companies/:company_id/activity-logs
// Super Admins read every company via /api/super-admin/activity-logs.
// ─────────────────────────────────────────────

// ?page&limit&user_id&action&entity_type&entity_id&method&status=success|failure&search&from&to
router.get("/", verifyToken, validateTenant, isAdmin, ActivityLogController.list);

// ?from&to — summary, top actions, top actors, daily volume
router.get("/stats", verifyToken, validateTenant, isAdmin, ActivityLogController.stats);

// Distinct action names present in this company's logs (filter dropdown)
router.get("/actions", verifyToken, validateTenant, isAdmin, ActivityLogController.actionCatalog);

// Full history of one record, e.g. /history/employee/<uuid>
router.get(
    "/history/:entity_type/:entity_id",
    verifyToken,
    validateTenant,
    isAdmin,
    ActivityLogController.entityHistory
);

module.exports = router;
