const express = require("express");
const router = express.Router();

const SuperAdminController = require("../controller/superAdminController");
const PlanController = require("../controller/planController");
const PolicyController = require("../controller/policyController");
const verifyToken = require("../middleware/verifyToken");
const { requireSuperAdmin } = require("../middleware/isSuperAdmin");
const {
    uploadPolicyDocument,
    handlePolicyUploadError,
} = require("../middleware/uploadPolicyDocument");

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
// PLANS & FEATURE GRID
// ─────────────────────────────────────────────
//
// The feature CATALOG is read-only: rows are created by migrations, because a
// key that no code enforces is dead config. What IS editable here is the grid —
// which plans get which features — so adding a module to Gold next month is a
// checkbox, not a deploy.

// The catalog, grouped by category. Renders the rows of the grid screen.
router.get("/plan-features", PlanController.listFeatures);

// ?include_inactive=true
router.get("/plans", PlanController.listPlans);
router.post("/plans", PlanController.createPlan);
router.get("/plans/:plan_id", PlanController.getPlan);
router.put("/plans/:plan_id", PlanController.updatePlan);
router.delete("/plans/:plan_id", PlanController.deletePlan);

// The grid for one plan. PUT saves the whole screen in one transaction;
// PATCH toggles a single cell.
router.get("/plans/:plan_id/grid", PlanController.getPlanGrid);
router.put("/plans/:plan_id/grid", PlanController.savePlanGrid);
router.patch("/plans/:plan_id/features/:feature_key", PlanController.setPlanFeature);

// ─────────────────────────────────────────────
// PER-COMPANY ENTITLEMENTS & OVERRIDES
// ─────────────────────────────────────────────
//
// Overrides answer "Pro, but 150 employees" without minting a private plan per
// customer. The resolved view is what support reads when a tenant asks why
// they cannot add an employee.
router.get("/companies/:company_id/entitlements", PlanController.getCompanyEntitlements);
router.get("/companies/:company_id/overrides", PlanController.listCompanyOverrides);
router.put("/companies/:company_id/overrides", PlanController.upsertCompanyOverride);
router.delete("/companies/:company_id/overrides/:feature_key", PlanController.removeCompanyOverride);

// ─────────────────────────────────────────────
// UPGRADE COUPONS
// ─────────────────────────────────────────────
//
// Payment happens off-platform: the customer mails us, we invoice, they pay,
// then we mint a code here and send it over. Each code is bound to one company
// and is single-use.
//
// ?page&limit&company_id&status=active|redeemed|revoked&search
router.get("/coupons", PlanController.listCoupons);
router.post("/coupons", PlanController.createCoupon);
router.get("/coupons/:coupon_id", PlanController.getCoupon);
router.patch("/coupons/:coupon_id/revoke", PlanController.revokeCoupon);

// ─────────────────────────────────────────────
// LEGAL POLICIES — TERMS & CONDITIONS, PRIVACY POLICY
// ─────────────────────────────────────────────
//
// Documents are country-scoped and versioned. Publishing never edits: it
// uploads a new .docx, extracts the text, files it as the next version, and
// retires the incumbent. Every superseded version stays readable HERE and
// nowhere else — a company sees the terms it is bound by today, while Legal
// keeps the archive an old agreement will be argued against.
//
// A blank `country` means the global default, served to every country that has
// no document of its own.

// Index: one row per (policy_type, country) lane, with version counts.
router.get("/policies", PolicyController.listLanes);

// Every live document across all countries. ?policy_type&country
router.get("/policies/current", PolicyController.listCurrent);

// The archive for one lane. ?policy_type=terms&country=AE&page&limit
router.get("/policies/versions", PolicyController.listVersions);

// Publish a new version — multipart/form-data.
//   file (.docx, required) | policy_type | country | title | change_note
//   effective_from | requires_reacceptance | notify
//
// On success every company admin in the affected country receives an in-app
// notification and an email pointing at their company profile.
router.post(
    "/policies",
    uploadPolicyDocument.single("file"),   // must run before the controller
    PolicyController.publishPolicy
);

// Static paths above, parameterised ones below — otherwise "current" and
// "versions" would be captured as document ids.
router.get("/policies/:id", PolicyController.getDocument);
router.get("/policies/:id/acceptances", PolicyController.listDocumentAcceptances);

// Rejected uploads (wrong type, too large) become 400s instead of 500s.
router.use(handlePolicyUploadError);

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
