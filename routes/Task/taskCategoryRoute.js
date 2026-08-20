const express = require("express");
const router = express.Router({ mergeParams: true });

const TaskCategoryController = require("../../controller/Task/taskCategoryController");
const verifyToken = require("../../middleware/verifyToken");
const { isAdmin, isEmployee } = require("../../middleware/authorizeRoles");
const validateTenant = require("../../middleware/validateTenant");
const { requireFeature } = require("../../middleware/enforceEntitlement");
const { Feature } = require("../../enums/features");

/**
 * Task categories — /api/companies/:company_id/task-categories
 *
 * Authoring categories is the gated part (Feature.TASK_CATEGORIES); reading
 * them is not. A company on a plan without custom categories still files
 * work under the six seeded defaults, exactly the way leaveTypeRoute leaves
 * /seed-defaults and every GET open while gating the writes.
 *
 * Categories are company configuration, so these ARE role-gated: an HOD
 * assigns work, an admin decides what the buckets are.
 */
const requireCategoryConfig = requireFeature(Feature.TASK_CATEGORIES);

// ─────────────────────────────────────────────
// ADMIN — onboarding
// ─────────────────────────────────────────────

// GET /api/companies/:company_id/task-categories/has-defaults
router.get("/has-defaults", verifyToken, validateTenant, isAdmin, TaskCategoryController.checkCategoriesExist);

// GET /api/companies/:company_id/task-categories/defaults
router.get("/defaults", verifyToken, validateTenant, isAdmin, TaskCategoryController.listDefaults);

// POST /api/companies/:company_id/task-categories/seed-defaults
router.post("/seed-defaults", verifyToken, validateTenant, isAdmin, TaskCategoryController.seedDefaults);

// ─────────────────────────────────────────────
// ADMIN — author custom categories
// ─────────────────────────────────────────────

// POST /api/companies/:company_id/task-categories
router.post("/", verifyToken, validateTenant, isAdmin, requireCategoryConfig, TaskCategoryController.create);

// ─────────────────────────────────────────────
// READ — anyone assigning or filtering tasks needs the list
// ─────────────────────────────────────────────

// GET /api/companies/:company_id/task-categories
router.get("/", verifyToken, validateTenant, isEmployee, TaskCategoryController.getAll);

// GET /api/companies/:company_id/task-categories/:id
router.get("/:id", verifyToken, validateTenant, isEmployee, TaskCategoryController.getById);

// ─────────────────────────────────────────────
// ADMIN — edit / remove
// ─────────────────────────────────────────────

// PUT /api/companies/:company_id/task-categories/:id
router.put("/:id", verifyToken, validateTenant, isAdmin, requireCategoryConfig, TaskCategoryController.update);

// DELETE /api/companies/:company_id/task-categories/:id
router.delete("/:id", verifyToken, validateTenant, isAdmin, requireCategoryConfig, TaskCategoryController.delete);

module.exports = router;
