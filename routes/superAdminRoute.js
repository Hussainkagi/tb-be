const express = require("express");
const router = express.Router();

const SuperAdminController = require("../controller/superAdminController");
const verifyToken = require("../middleware/verifyToken");
const { requireSuperAdmin } = require("../middleware/isSuperAdmin");

// Every route below is platform-level: the caller must be authenticated AND
// carry users.is_super_admin = TRUE (re-checked against the DB per request).
router.use(verifyToken, requireSuperAdmin);

// ─────────────────────────────────────────────
// BOOTSTRAP
// ─────────────────────────────────────────────
router.get("/me", SuperAdminController.me);

// ─────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────
// ?from=YYYY-MM-DD&to=YYYY-MM-DD  (defaults to the last 30 days)
router.get("/overview", SuperAdminController.overview);

// ─────────────────────────────────────────────
// COMPANIES
// ─────────────────────────────────────────────
// ?page&limit&search&status=active|disabled&plan&sort_by&sort_order&from&to
router.get("/companies", SuperAdminController.listCompanies);
router.get("/companies/lite", SuperAdminController.listCompaniesLite);
router.get("/companies/:company_id", SuperAdminController.getCompany);

// Company sub-resources
router.get("/companies/:company_id/employees", SuperAdminController.listCompanyEmployees);
router.get("/companies/:company_id/branches", SuperAdminController.listCompanyBranches);
router.get("/companies/:company_id/shifts", SuperAdminController.listCompanyShifts);
router.get("/companies/:company_id/departments", SuperAdminController.listCompanyDepartments);
router.get("/companies/:company_id/admins", SuperAdminController.listCompanyAdmins);

// Analytics
router.get("/companies/:company_id/attendance-stats", SuperAdminController.companyAttendanceStats);
router.get("/companies/:company_id/locations", SuperAdminController.companyLocations);
router.get("/companies/:company_id/leave-stats", SuperAdminController.companyLeaveStats);

// ─────────────────────────────────────────────
// COMPANY CONTROLS
// ─────────────────────────────────────────────
router.patch("/companies/:company_id/disable", SuperAdminController.disableCompany);
router.patch("/companies/:company_id/enable", SuperAdminController.enableCompany);
router.patch("/companies/:company_id/plan", SuperAdminController.updateCompanyPlan);

// ─────────────────────────────────────────────
// SUPER ADMIN MANAGEMENT
// ─────────────────────────────────────────────
router.get("/super-admins", SuperAdminController.listSuperAdmins);
router.patch("/super-admins/:user_id/grant", SuperAdminController.grantSuperAdmin);
router.patch("/super-admins/:user_id/revoke", SuperAdminController.revokeSuperAdmin);

// ─────────────────────────────────────────────
// ACTIVITY LOG — every company's day-to-day actions
// ─────────────────────────────────────────────
// Platform-wide feed. ?company_id filters to one tenant; omit for all.
// ?page&limit&company_id&user_id&action&entity_type&entity_id&method
//  &status=success|failure&search&from&to
router.get("/activity-logs", SuperAdminController.listActivityLogs);

// Rollup: summary, top actions, top actors, daily volume, per-company volume
router.get("/activity-logs/stats", SuperAdminController.activityStats);

// Distinct action names, for filter dropdowns
router.get("/activity-logs/actions", SuperAdminController.activityActionCatalog);

// Full history of a single record, e.g. /activity-logs/history/employee/<uuid>
router.get(
    "/activity-logs/history/:entity_type/:entity_id",
    SuperAdminController.entityHistory
);

// Per-company shortcuts (same data, scoped by path instead of query)
router.get("/companies/:company_id/activity-logs", SuperAdminController.companyActivityLogs);
router.get("/companies/:company_id/activity-stats", SuperAdminController.companyActivityStats);

// ─────────────────────────────────────────────
// AUDIT LOG — the super admin's own platform actions
// ─────────────────────────────────────────────
// ?page&limit&action&company_id
router.get("/audit-logs", SuperAdminController.listAuditLogs);

module.exports = router;
