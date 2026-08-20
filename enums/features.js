/**
 * HRMS Feature Keys
 *
 * The single source of truth for every gateable capability. These strings are
 * the contract between code and the `plan_features` catalog seeded in
 * database/migration/34_plans_and_entitlements.sql.
 *
 * Rules:
 *   1. Never inline a raw string in a route — always reference Feature.*.
 *      A typo in a literal silently denies (or worse, silently allows).
 *   2. Adding a capability means adding it here AND in a migration. Only then
 *      does it appear in the Super Admin grid, where it starts switched off
 *      for every plan until someone ticks it on.
 *   3. Keys are permanent. Rename the label from the panel; never the key.
 *
 * Naming: <domain>.<capability>, and `limit.<countable>` for numeric caps.
 */

const Feature = Object.freeze({
    // ── Access ───────────────────────────────────────────────────────────────
    WEB_PORTAL:              "access.web_portal",
    MOBILE_APP:              "access.mobile_app",
    ROLE_BASED_ACCESS:       "access.role_based",
    COMPANY_SETTINGS:        "access.company_settings",

    // ── Attendance ───────────────────────────────────────────────────────────
    ATTENDANCE_CHECK_IN_OUT: "attendance.check_in_out",
    ATTENDANCE_GPS:          "attendance.gps_capture",
    ATTENDANCE_PHOTO:        "attendance.photo_verification",
    ATTENDANCE_SELF_HISTORY: "attendance.self_history",
    ATTENDANCE_BRANCH_MAP:   "attendance.branch_map",

    // ── Leave & Holidays ─────────────────────────────────────────────────────
    LEAVE_WORKFLOW:          "leave.workflow",
    HOLIDAY_CALENDAR:        "leave.holiday_calendar",
    LEAVE_POLICY_CONFIG:     "leave.balance_policy_config",
    LEAVE_MULTI_APPROVAL:    "leave.multi_level_approval",

    // ── Notifications ────────────────────────────────────────────────────────
    PUSH_NOTIFICATIONS:      "notifications.push",
    LEAVE_NOTIFICATIONS:     "notifications.leave_status",
    ANNOUNCEMENTS:           "notifications.announcements",

    // ── Payroll & Gratuity ───────────────────────────────────────────────────
    PAYROLL_GENERATE:        "payroll.generate",
    PAYSLIP_PDF:             "payroll.payslip_pdf",
    GRATUITY_CALCULATE:      "gratuity.calculate",
    GRATUITY_CROSS_BORDER:   "gratuity.cross_border",
    GRATUITY_PRESETS:        "gratuity.statutory_presets",

    // ── Leave Salary ─────────────────────────────────────────────────────────
    LEAVE_SALARY:            "leave_salary.manage",
    LEAVE_SALARY_ADVANCE:    "leave_salary.advance_payment",
    LEAVE_SALARY_ENCASHMENT: "leave_salary.encashment",

    // ── Offboarding ──────────────────────────────────────────────────────────
    RESIGNATION:             "offboarding.resignation",
    TERMINATION:             "offboarding.termination",
    FINAL_SETTLEMENT:        "offboarding.settlement",

    // ── Tasks ────────────────────────────────────────────────────────────────
    TASK_MANAGEMENT:         "tasks.manage",
    TASK_CATEGORIES:         "tasks.categories",
    TASK_NOTIFICATIONS:      "notifications.task",
    TASK_PERFORMANCE:        "reporting.task_performance",

    // ── Reporting ────────────────────────────────────────────────────────────
    DASHBOARD:               "reporting.dashboard",
    DASHBOARD_ALERTS:        "reporting.dashboard_alerts",
    REPORTS:                 "reporting.reports",          // enum — see ReportKey
    ACTIVITY_LOG:            "reporting.activity_log",
    ENTITY_HISTORY:          "reporting.entity_history",

    // ── Data & Storage ───────────────────────────────────────────────────────
    IMAGE_STORAGE:           "data.image_storage",
    SELF_SERVICE_EXPORT:     "data.self_service_export",
    EXTENDED_RETENTION:      "data.extended_retention",

    // ── Support & SLA (advertised, not enforced in code) ──────────────────────
    SUPPORT_EMAIL:           "support.email",
    SUPPORT_PRIORITY:        "support.priority",
    SUPPORT_ONBOARDING:      "support.onboarding",
    SUPPORT_SLA:             "support.sla",
});

/**
 * Numeric caps. Each maps to a live COUNT(*) in entitlementModel.countUsage()
 * and is checked on CREATE only — never on read, and never retroactively.
 */
const Limit = Object.freeze({
    EMPLOYEES:   "limit.employees",
    BRANCHES:    "limit.branches",
    DEPARTMENTS: "limit.departments",
    SHIFTS:      "limit.shifts",
});

/**
 * Sub-keys of the `reporting.reports` enum feature. The value stored against a
 * plan is a JSON array of these.
 */
const ReportKey = Object.freeze({
    CASUAL:             "casual",
    DETAILED:           "detailed",
    WORKING_HOURS:      "working_hours",
    HEADCOUNT:          "headcount",
    CHECK_IN_OUT_RATIO: "check_in_out_ratio",
    PUNCTUALITY:        "punctuality",
    PAYROLL_BREAKDOWN:  "payroll_breakdown",
});

/** Human-readable noun per limit, used in the 403 body the frontend renders. */
const LimitLabel = Object.freeze({
    [Limit.EMPLOYEES]:   "employees",
    [Limit.BRANCHES]:    "branches",
    [Limit.DEPARTMENTS]: "departments",
    [Limit.SHIFTS]:      "shifts",
});

module.exports = { Feature, Limit, ReportKey, LimitLabel };
