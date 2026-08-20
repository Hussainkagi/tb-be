const express = require("express");
const router = express.Router({ mergeParams: true });

const TaskPerformanceController = require("../../controller/Task/taskPerformanceController");
const verifyToken = require("../../middleware/verifyToken");
const { isAdmin, isEmployee } = require("../../middleware/authorizeRoles");
const validateTenant = require("../../middleware/validateTenant");
const loadTaskActor = require("../../middleware/Task/loadTaskActor");

/**
 * Task performance dashboard — /api/companies/:company_id/task-performance
 *
 * Mounted behind Feature.TASK_PERFORMANCE in server.js.
 *
 * `isEmployee` again, for the same reason as taskRoute: an HOD needs their
 * department's numbers and an employee needs their own, and neither is
 * expressible as a role. taskPerformanceService._scopeFor() narrows every
 * query — an employee asking for someone else's report gets a 403, not a
 * quietly empty result.
 *
 * Two exceptions are genuinely admin-only and say so at the route: the
 * cross-department comparison, and the manual rollup rebuild.
 */

// GET /api/companies/:company_id/task-performance/employees
router.get("/employees", verifyToken, validateTenant, isEmployee, loadTaskActor, TaskPerformanceController.employees);

// GET /api/companies/:company_id/task-performance/leaderboard
router.get("/leaderboard", verifyToken, validateTenant, isEmployee, loadTaskActor, TaskPerformanceController.leaderboard);

// GET /api/companies/:company_id/task-performance/trend
router.get("/trend", verifyToken, validateTenant, isEmployee, loadTaskActor, TaskPerformanceController.trend);

// GET /api/companies/:company_id/task-performance/departments
router.get("/departments", verifyToken, validateTenant, isAdmin, loadTaskActor, TaskPerformanceController.departments);

// POST /api/companies/:company_id/task-performance/rebuild
router.post("/rebuild", verifyToken, validateTenant, isAdmin, loadTaskActor, TaskPerformanceController.rebuild);

module.exports = router;
