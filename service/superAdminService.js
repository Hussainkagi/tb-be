const SuperAdminModel = require("../models/superAdminModel");
const CompanyModel = require("../models/companyModel");
const UserModel = require("../models/userModel");
const { invalidateCompanyCache } = require("../middleware/enforceCompanyActive");
const { invalidateSuperAdminCache } = require("../middleware/isSuperAdmin");

/**
 * Super Admin service — platform-level analytics and controls.
 *
 * Every method returns the { success, message?, data? } envelope used by the
 * rest of the codebase so controllers stay uniform.
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_DAYS = 30;
const MAX_PAGE_SIZE = 100;

const toDateString = (d) => d.toISOString().slice(0, 10);

/** Resolves ?from / ?to into a validated [from, to] pair of YYYY-MM-DD strings. */
function resolveDateRange(from, to, days = DEFAULT_WINDOW_DAYS) {
    const isValid = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

    const end = isValid(to) ? to : toDateString(new Date());
    let start;

    if (isValid(from)) {
        start = from;
    } else {
        const d = new Date(`${end}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - (days - 1));
        start = toDateString(d);
    }

    // Guard against a reversed range
    if (start > end) [start] = [end];

    return { from: start, to: end };
}

function resolvePaging(query) {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const rawLimit = parseInt(query.limit, 10) || 20;
    const limit = Math.min(Math.max(rawLimit, 1), MAX_PAGE_SIZE);
    return { page, limit };
}

/** Postgres returns COUNT/SUM as strings — normalise for the frontend. */
function toNumbers(row, keys) {
    if (!row) return row;
    const out = { ...row };
    for (const k of keys) {
        if (out[k] !== undefined && out[k] !== null) out[k] = Number(out[k]);
    }
    return out;
}

const ATT_NUMERIC_KEYS = [
    "total_records", "present_count", "absent_count", "leave_count",
    "holiday_count", "week_off_count", "punctual_count", "late_count",
    "early_count", "total_hours", "avg_hours_per_day",
    "employees_with_records", "companies_with_records",
];

/** Adds derived rates so the frontend never has to compute them. */
function withRates(att) {
    const a = toNumbers(att, ATT_NUMERIC_KEYS) || {};
    const present = a.present_count || 0;
    const absent = a.absent_count || 0;
    const marked = present + absent;

    return {
        ...a,
        attendance_rate: marked ? Number(((present / marked) * 100).toFixed(2)) : 0,
        punctuality_rate: present
            ? Number((((a.punctual_count || 0) / present) * 100).toFixed(2))
            : 0,
        late_rate: present
            ? Number((((a.late_count || 0) / present) * 100).toFixed(2))
            : 0,
        absenteeism_rate: marked ? Number(((absent / marked) * 100).toFixed(2)) : 0,
    };
}

/**
 * Bucket a punctuality percentage into a label the UI can badge.
 * `sample` is the number of present-days behind the rate — with none, the
 * company/employee has simply not been measured yet, which is not "poor".
 */
function punctualityBand(rate, sample = 1) {
    if (!sample) return "no_data";
    if (rate >= 95) return "excellent";
    if (rate >= 85) return "good";
    if (rate >= 70) return "fair";
    return "poor";
}

const SuperAdminService = {
    // ═══════════════════════════════════════════════════════════════════════
    // DASHBOARD
    // ═══════════════════════════════════════════════════════════════════════

    /** Everything the super admin landing page needs, in one call. */
    async getOverview(query = {}) {
        try {
            const { from, to } = resolveDateRange(query.from, query.to);

            const [totals, attendance, trend, growth, plans, topCompanies, bottomCompanies] =
                await Promise.all([
                    SuperAdminModel.getPlatformTotals(),
                    SuperAdminModel.getPlatformAttendance(from, to),
                    SuperAdminModel.getPlatformAttendanceTrend(from, to),
                    SuperAdminModel.getCompanyGrowth(12),
                    SuperAdminModel.getPlanDistribution(),
                    SuperAdminModel.getCompanyLeaderboard(from, to, "punctuality_rate", 5),
                    SuperAdminModel.getCompanyLeaderboard(from, to, "attendance_rate", 5),
                ]);

            const numericTotals = toNumbers(totals, Object.keys(totals));

            return {
                success: true,
                data: {
                    date_range: { from, to },
                    totals: numericTotals,
                    attendance: withRates(attendance),
                    attendance_trend: trend.map((r) =>
                        toNumbers(r, [
                            "present_count", "absent_count", "leave_count",
                            "punctual_count", "late_count",
                        ])
                    ),
                    company_growth: growth.map((r) => toNumbers(r, ["companies_added"])),
                    plan_distribution: plans.map((r) =>
                        toNumbers(r, [
                            "company_count", "active_count",
                            "disabled_count", "expired_count",
                        ])
                    ),
                    most_punctual_companies: topCompanies.map((c) => ({
                        ...toNumbers(c, [
                            "present_count", "absent_count", "punctual_count",
                            "late_count", "attendance_rate", "punctuality_rate",
                        ]),
                        punctuality_band: punctualityBand(Number(c.punctuality_rate), Number(c.present_count)),
                    })),
                    best_attendance_companies: bottomCompanies.map((c) =>
                        toNumbers(c, [
                            "present_count", "absent_count", "punctual_count",
                            "late_count", "attendance_rate", "punctuality_rate",
                        ])
                    ),
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // COMPANIES
    // ═══════════════════════════════════════════════════════════════════════

    async listCompanies(query = {}) {
        try {
            const { from, to } = resolveDateRange(query.from, query.to);
            const { page, limit } = resolvePaging(query);

            const { rows, total } = await SuperAdminModel.listCompanies({
                page,
                limit,
                search: query.search || null,
                status: query.status || null,
                plan: query.plan || null,
                sort_by: query.sort_by || "created_at",
                sort_order: query.sort_order || "desc",
                from,
                to,
            });

            const data = rows.map((c) => ({
                ...toNumbers(c, [
                    "employee_count", "active_employee_count", "branch_count",
                    "department_count", "shift_count", "user_count", "admin_count",
                    "present_count", "absent_count", "leave_count", "punctual_count",
                    "late_count", "total_hours", "attendance_rate", "punctuality_rate",
                ]),
                punctuality_band: punctualityBand(Number(c.punctuality_rate), Number(c.present_count)),
            }));

            return {
                success: true,
                data,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasNextPage: page * limit < total,
                    hasPrevPage: page > 1,
                },
                meta: { date_range: { from, to } },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async listCompaniesLite() {
        try {
            const rows = await SuperAdminModel.listCompaniesLite();
            return { success: true, data: rows };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Deep-dive view for a single company. */
    async getCompanyDetail(company_id, query = {}) {
        try {
            const { from, to } = resolveDateRange(query.from, query.to);

            const company = await SuperAdminModel.getCompany(company_id);
            if (!company) {
                return { success: false, message: "Company not found" };
            }

            const [
                counts,
                workforce,
                attendance,
                trend,
                byBranch,
                branches,
                shifts,
                departments,
                admins,
                topEmployees,
                bottomEmployees,
                leave,
            ] = await Promise.all([
                SuperAdminModel.getCompanyCounts(company_id),
                SuperAdminModel.getCompanyWorkforceBreakdown(company_id),
                SuperAdminModel.getCompanyAttendanceSummary(company_id, from, to),
                SuperAdminModel.getCompanyAttendanceTrend(company_id, from, to),
                SuperAdminModel.getCompanyAttendanceByBranch(company_id, from, to),
                SuperAdminModel.listCompanyBranches(company_id),
                SuperAdminModel.listCompanyShifts(company_id),
                SuperAdminModel.listCompanyDepartments(company_id),
                SuperAdminModel.listCompanyAdmins(company_id),
                SuperAdminModel.getCompanyEmployeeRanking(company_id, from, to, "top", 5),
                SuperAdminModel.getCompanyEmployeeRanking(company_id, from, to, "bottom", 5),
                SuperAdminModel.getCompanyLeaveStats(company_id, from, to),
            ]);

            const attendanceWithRates = withRates(attendance);

            return {
                success: true,
                data: {
                    date_range: { from, to },
                    company,
                    counts: toNumbers(counts, Object.keys(counts)),
                    workforce,
                    attendance: {
                        ...attendanceWithRates,
                        punctuality_band: punctualityBand(attendanceWithRates.punctuality_rate, attendanceWithRates.present_count),
                    },
                    attendance_trend: trend.map((r) =>
                        toNumbers(r, [
                            "present_count", "absent_count", "leave_count",
                            "punctual_count", "late_count", "total_hours",
                        ])
                    ),
                    attendance_by_branch: byBranch.map((r) =>
                        toNumbers(r, [
                            "employee_count", "present_count", "absent_count",
                            "punctual_count", "late_count",
                            "attendance_rate", "punctuality_rate",
                        ])
                    ),
                    branches,
                    shifts,
                    departments,
                    admins,
                    top_employees: topEmployees,
                    needs_attention_employees: bottomEmployees,
                    leave: {
                        summary: toNumbers(leave.summary, Object.keys(leave.summary)),
                        by_type: leave.by_type,
                    },
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async listCompanyEmployees(company_id, query = {}) {
        try {
            const company = await CompanyModel.findById(company_id);
            if (!company) return { success: false, message: "Company not found" };

            const { from, to } = resolveDateRange(query.from, query.to);
            const { page, limit } = resolvePaging(query);

            const { rows, total } = await SuperAdminModel.listCompanyEmployees(company_id, {
                page,
                limit,
                search: query.search || null,
                branch_id: query.branch_id || null,
                department_id: query.department_id || null,
                status: query.status || null,
                sort_by: query.sort_by || "first_name",
                sort_order: query.sort_order || "asc",
                from,
                to,
            });

            const data = rows.map((e) => {
                const row = toNumbers(e, [
                    "present_days", "absent_days", "leave_days", "punctual_days",
                    "late_days", "early_days", "total_hours", "avg_hours_per_day",
                    "attendance_rate", "punctuality_rate",
                ]);
                return {
                    ...row,
                    full_name: `${e.first_name} ${e.last_name}`,
                    punctuality_band: punctualityBand(row.punctuality_rate, row.present_days),
                };
            });

            return {
                success: true,
                data,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasNextPage: page * limit < total,
                    hasPrevPage: page > 1,
                },
                meta: {
                    date_range: { from, to },
                    company: {
                        id: company.id,
                        company_name: company.company_name,
                        is_active: company.is_active,
                    },
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async listCompanyBranches(company_id) {
        try {
            const rows = await SuperAdminModel.listCompanyBranches(company_id);
            return {
                success: true,
                data: rows.map((r) =>
                    toNumbers(r, ["employee_count", "department_count", "shift_count"])
                ),
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async listCompanyShifts(company_id) {
        try {
            const rows = await SuperAdminModel.listCompanyShifts(company_id);
            return { success: true, data: rows.map((r) => toNumbers(r, ["employee_count"])) };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async listCompanyDepartments(company_id) {
        try {
            const rows = await SuperAdminModel.listCompanyDepartments(company_id);
            return { success: true, data: rows.map((r) => toNumbers(r, ["employee_count"])) };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async listCompanyAdmins(company_id) {
        try {
            const rows = await SuperAdminModel.listCompanyAdmins(company_id);
            return { success: true, data: rows };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // ANALYTICS
    // ═══════════════════════════════════════════════════════════════════════

    async getCompanyAttendanceStats(company_id, query = {}) {
        try {
            const company = await CompanyModel.findById(company_id);
            if (!company) return { success: false, message: "Company not found" };

            const { from, to } = resolveDateRange(query.from, query.to);

            const [summary, trend, byBranch, histogram, top, bottom] = await Promise.all([
                SuperAdminModel.getCompanyAttendanceSummary(company_id, from, to),
                SuperAdminModel.getCompanyAttendanceTrend(company_id, from, to),
                SuperAdminModel.getCompanyAttendanceByBranch(company_id, from, to),
                SuperAdminModel.getCompanyCheckInHistogram(company_id, from, to),
                SuperAdminModel.getCompanyEmployeeRanking(company_id, from, to, "top", 10),
                SuperAdminModel.getCompanyEmployeeRanking(company_id, from, to, "bottom", 10),
            ]);

            const summaryWithRates = withRates(summary);

            return {
                success: true,
                data: {
                    date_range: { from, to },
                    summary: {
                        ...summaryWithRates,
                        punctuality_band: punctualityBand(summaryWithRates.punctuality_rate, summaryWithRates.present_count),
                    },
                    trend: trend.map((r) =>
                        toNumbers(r, [
                            "present_count", "absent_count", "leave_count",
                            "punctual_count", "late_count", "total_hours",
                        ])
                    ),
                    by_branch: byBranch.map((r) =>
                        toNumbers(r, [
                            "employee_count", "present_count", "absent_count",
                            "punctual_count", "late_count",
                            "attendance_rate", "punctuality_rate",
                        ])
                    ),
                    check_in_by_hour: histogram.map((r) => toNumbers(r, ["hour", "count"])),
                    most_punctual_employees: top,
                    least_punctual_employees: bottom,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Branch geofences + recent check-in pins for the map view. */
    async getCompanyLocations(company_id, query = {}) {
        try {
            const company = await CompanyModel.findById(company_id);
            if (!company) return { success: false, message: "Company not found" };

            const { from, to } = resolveDateRange(query.from, query.to, 7);
            const limit = Math.min(parseInt(query.limit, 10) || 500, 2000);

            const [branches, checkIns] = await Promise.all([
                SuperAdminModel.listCompanyBranches(company_id),
                SuperAdminModel.getCompanyCheckInLocations(company_id, from, to, limit),
            ]);

            return {
                success: true,
                data: {
                    date_range: { from, to },
                    branches: branches
                        .filter((b) => b.latitude !== null && b.longitude !== null)
                        .map((b) => ({
                            id: b.id,
                            branch_name: b.branch_name,
                            branch_code: b.branch_code,
                            is_head_office: b.is_head_office,
                            city: b.city,
                            state: b.state,
                            country: b.country,
                            address: b.address,
                            latitude: Number(b.latitude),
                            longitude: Number(b.longitude),
                            attendance_radius: Number(b.attendance_radius),
                            employee_count: Number(b.employee_count),
                        })),
                    branches_without_geofence: branches
                        .filter((b) => b.latitude === null || b.longitude === null)
                        .map((b) => ({ id: b.id, branch_name: b.branch_name })),
                    check_ins: checkIns.map((r) => ({
                        ...r,
                        check_in_latitude: r.check_in_latitude !== null ? Number(r.check_in_latitude) : null,
                        check_in_longitude: r.check_in_longitude !== null ? Number(r.check_in_longitude) : null,
                        check_out_latitude: r.check_out_latitude !== null ? Number(r.check_out_latitude) : null,
                        check_out_longitude: r.check_out_longitude !== null ? Number(r.check_out_longitude) : null,
                        branch_latitude: r.branch_latitude !== null ? Number(r.branch_latitude) : null,
                        branch_longitude: r.branch_longitude !== null ? Number(r.branch_longitude) : null,
                        full_name: `${r.first_name} ${r.last_name}`,
                    })),
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getCompanyLeaveStats(company_id, query = {}) {
        try {
            const { from, to } = resolveDateRange(query.from, query.to);
            const leave = await SuperAdminModel.getCompanyLeaveStats(company_id, from, to);
            return {
                success: true,
                data: {
                    date_range: { from, to },
                    summary: toNumbers(leave.summary, Object.keys(leave.summary)),
                    by_type: leave.by_type.map((r) =>
                        toNumbers(r, ["request_count", "total_days"])
                    ),
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // COMPANY ENABLE / DISABLE
    // ═══════════════════════════════════════════════════════════════════════

    async disableCompany(company_id, actor, { reason, ip_address }) {
        try {
            const company = await SuperAdminModel.getCompany(company_id);
            if (!company) return { success: false, message: "Company not found" };

            if (company.is_active === false) {
                return { success: false, message: "Company is already disabled" };
            }

            // A super admin must not lock themselves out of their own tenant.
            if (String(company_id) === String(actor.company_id)) {
                return {
                    success: false,
                    message: "You cannot disable the company you are currently logged into",
                };
            }

            const updated = await SuperAdminModel.disableCompany(
                company_id,
                actor.user_id,
                reason
            );

            invalidateCompanyCache(company_id);

            await SuperAdminModel.createAuditLog({
                actor_user_id: actor.user_id,
                action: "company.disable",
                target_company_id: company_id,
                reason: reason || null,
                metadata: { company_name: company.company_name },
                ip_address,
            });

            return {
                success: true,
                message: `Company "${company.company_name}" has been disabled`,
                data: updated,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async enableCompany(company_id, actor, { ip_address }) {
        try {
            const company = await SuperAdminModel.getCompany(company_id);
            if (!company) return { success: false, message: "Company not found" };

            if (company.is_active === true) {
                return { success: false, message: "Company is already active" };
            }

            const updated = await SuperAdminModel.enableCompany(company_id);

            invalidateCompanyCache(company_id);

            await SuperAdminModel.createAuditLog({
                actor_user_id: actor.user_id,
                action: "company.enable",
                target_company_id: company_id,
                metadata: {
                    company_name: company.company_name,
                    previous_reason: company.disabled_reason,
                },
                ip_address,
            });

            return {
                success: true,
                message: `Company "${company.company_name}" has been re-enabled`,
                data: updated,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async updateCompanyPlan(company_id, { plan, plan_expires_at }, actor, { ip_address }) {
        try {
            const VALID_PLANS = ["trial", "basic", "pro", "enterprise"];
            if (!plan || !VALID_PLANS.includes(plan)) {
                return {
                    success: false,
                    message: `Invalid plan. Must be one of: ${VALID_PLANS.join(", ")}`,
                };
            }

            const company = await SuperAdminModel.getCompany(company_id);
            if (!company) return { success: false, message: "Company not found" };

            const updated = await SuperAdminModel.updateCompanyPlan(
                company_id,
                plan,
                plan_expires_at
            );

            await SuperAdminModel.createAuditLog({
                actor_user_id: actor.user_id,
                action: "company.plan_update",
                target_company_id: company_id,
                metadata: {
                    from_plan: company.plan,
                    to_plan: plan,
                    plan_expires_at: plan_expires_at || null,
                },
                ip_address,
            });

            return { success: true, message: "Plan updated successfully", data: updated };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // SUPER ADMIN MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    async listSuperAdmins() {
        try {
            const rows = await SuperAdminModel.listSuperAdmins();
            return { success: true, data: rows };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async setSuperAdmin(user_id, grant, actor, { ip_address }) {
        try {
            const user = await UserModel.findById(user_id);
            if (!user) return { success: false, message: "User not found" };

            if (user.is_super_admin === grant) {
                return {
                    success: false,
                    message: grant
                        ? "User is already a Super Admin"
                        : "User is not a Super Admin",
                };
            }

            if (!grant) {
                if (String(user_id) === String(actor.user_id)) {
                    return {
                        success: false,
                        message: "You cannot revoke your own Super Admin access",
                    };
                }
                const remaining = await SuperAdminModel.countSuperAdmins();
                if (remaining <= 1) {
                    return {
                        success: false,
                        message: "Cannot revoke the last remaining Super Admin",
                    };
                }
            }

            const updated = await SuperAdminModel.setSuperAdminFlag(user_id, grant);

            invalidateSuperAdminCache(user_id);

            await SuperAdminModel.createAuditLog({
                actor_user_id: actor.user_id,
                action: grant ? "super_admin.grant" : "super_admin.revoke",
                target_user_id: user_id,
                metadata: { email: user.email },
                ip_address,
            });

            return {
                success: true,
                message: grant
                    ? "Super Admin access granted"
                    : "Super Admin access revoked",
                data: updated,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Identity + capabilities of the logged-in super admin (panel bootstrap). */
    async getMe(actor) {
        try {
            const user = await UserModel.findById(actor.user_id);
            if (!user) return { success: false, message: "User not found" };

            const ownCompany = actor.company_id
                ? await CompanyModel.findById(actor.company_id)
                : null;

            return {
                success: true,
                data: {
                    user_id: user.id,
                    first_name: user.first_name,
                    last_name: user.last_name,
                    email: user.email,
                    phone: user.phone,
                    is_super_admin: user.is_super_admin === true,
                    active_company: ownCompany
                        ? {
                              id: ownCompany.id,
                              company_name: ownCompany.company_name,
                              company_code: ownCompany.company_code,
                              logo_url: ownCompany.logo_url,
                              is_active: ownCompany.is_active,
                          }
                        : null,
                    company_role: actor.role,
                    permissions: [
                        "companies.read_all",
                        "companies.disable",
                        "companies.enable",
                        "companies.plan_update",
                        "employees.read_all",
                        "analytics.read_all",
                        "audit_logs.read",
                        "super_admins.manage",
                    ],
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ═══════════════════════════════════════════════════════════════════════
    // AUDIT LOG
    // ═══════════════════════════════════════════════════════════════════════

    async listAuditLogs(query = {}) {
        try {
            const { page, limit } = resolvePaging(query);
            const { rows, total } = await SuperAdminModel.listAuditLogs({
                page,
                limit,
                action: query.action || null,
                company_id: query.company_id || null,
            });

            return {
                success: true,
                data: rows,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasNextPage: page * limit < total,
                    hasPrevPage: page > 1,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = SuperAdminService;
