const DashboardModel = require("../models/dashboardModel");
const { getGratuityRule, hasGratuityPreset } = require("../enums/gratuityRules");
const { normalizeCountry } = require("../utils/bankDetailsValidator");
const { resolveCountryCode } = require("../enums/bankFieldSpecs");

/**
 * Company-admin dashboard.
 *
 * One screen, four questions:
 *   who is at work right now, what needs my attention, how do my branches
 *   compare, and what is coming up.
 *
 * The overview endpoint answers all four in a single request. Each section is
 * one aggregate query, they run in parallel, and `sections` lets the caller
 * drop the ones a given screen does not render — so a widget refresh does not
 * pay for the whole dashboard.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** "Today" as the company sees it — a Dubai admin must not get UTC's date. */
function todayInTimezone(timezone) {
    try {
        // en-CA formats as YYYY-MM-DD
        return new Intl.DateTimeFormat("en-CA", {
            timeZone: timezone || "UTC",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).format(new Date());
    } catch {
        return new Date().toISOString().slice(0, 10);
    }
}

function addDays(dateStr, days) {
    const d = new Date(dateStr + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/** pg returns NUMERIC/BIGINT as strings — coerce before doing maths on them. */
const num = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);

/** Percentage rounded to one decimal; 0 when there is nothing to divide by. */
const pct = (part, whole) => (whole > 0 ? Math.round((num(part) / num(whole)) * 1000) / 10 : 0);

const isUuid = (v) =>
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

const clamp = (v, min, max, fallback) => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(Math.max(n, min), max);
};

// ---------------------------------------------------------------------------
// Warning catalogue
//
// Severity drives ordering and the badge colour on the client:
//   critical — money or compliance is already wrong
//   warning  — will become wrong soon, or someone is blocked
//   info     — worth knowing, nothing is broken
// ---------------------------------------------------------------------------

const WARNING_CATALOG = {
    missing_salary_structure: {
        severity: "critical",
        category: "payroll",
        title: "Employees without a salary structure",
        message:
            "Payroll cannot be generated for these employees, and any gratuity accrual reads zero until a salary structure is added.",
        resource: "salary-structures",
    },
    missing_bank_account: {
        severity: "warning",
        category: "payroll",
        title: "Employees without bank details",
        message: "Salary is calculated but cannot be disbursed until a bank account is on file.",
        resource: "bank-accounts",
    },
    gratuity_pending_decision: {
        severity: "critical",
        category: "gratuity",
        title: "Gratuity undecided for cross-border employees",
        message:
            "These employees work from a different country than the company is registered in. Nothing accrues until an admin picks which country's end-of-service rules apply.",
        resource: "gratuity",
    },
    gratuity_no_scheme: {
        severity: "warning",
        category: "gratuity",
        title: "Gratuity not configured",
        message:
            "No statutory end-of-service scheme exists for these employees' country, and no rules were entered — so nothing is accruing for them.",
        resource: "gratuity",
    },
    gratuity_disabled: {
        severity: "info",
        category: "gratuity",
        title: "Gratuity switched off",
        message: "End-of-service accrual is explicitly disabled for these employees.",
        resource: "gratuity",
    },
    pending_leave_requests: {
        severity: "warning",
        category: "leave",
        title: "Leave requests awaiting approval",
        message: "Employees are waiting on a decision. Requests that start soonest are listed first.",
        resource: "leave-requests",
    },
    expiring_documents: {
        severity: "critical",
        category: "compliance",
        title: "Documents expired or expiring soon",
        message:
            "Visas, Emirates IDs, passports and work permits past or near their expiry date. Expired ones are listed first.",
        resource: "employee-documents",
    },
    missing_checkouts: {
        severity: "warning",
        category: "attendance",
        title: "Open attendance records",
        message:
            "Checked in on a past day and never checked out — working hours for those days are understated until corrected.",
        resource: "attendance",
    },
    missing_shift: {
        severity: "warning",
        category: "setup",
        title: "Employees without a shift",
        message:
            "Without a shift there is no expected start time or week-off pattern, so late marking and absence detection do not work for them.",
        resource: "employees",
    },
    missing_branch: {
        severity: "warning",
        category: "setup",
        title: "Employees not assigned to a branch",
        message: "These employees are missing from every branch-wise report.",
        resource: "employees",
    },
    pending_invites: {
        severity: "info",
        category: "access",
        title: "Invites not yet accepted",
        message: "These employees cannot log in or mark attendance until they set a password.",
        resource: "employees",
    },
    no_login_account: {
        severity: "info",
        category: "access",
        title: "Employees without a login",
        message: "No user account is linked, so they cannot use the app at all.",
        resource: "employees",
    },
    locked_accounts: {
        severity: "warning",
        category: "access",
        title: "Locked accounts",
        message: "Locked after repeated failed logins. They need an admin to unlock or reset them.",
        resource: "employees",
    },
    branch_without_geofence: {
        severity: "warning",
        category: "setup",
        title: "Branches without a geofence",
        message:
            "No latitude/longitude is set, so check-in location cannot be validated against the office.",
        resource: "branches",
    },
    branch_without_shift: {
        severity: "info",
        category: "setup",
        title: "Branches without any shift",
        message: "Employees at these branches have no shift to be assigned to.",
        resource: "shifts",
    },
    no_leave_types_configured: {
        severity: "warning",
        category: "setup",
        title: "No leave types configured",
        message: "Nobody in the company can apply for leave until at least one leave type exists.",
        resource: "leave-types",
    },
    no_holidays_this_year: {
        severity: "info",
        category: "setup",
        title: "No holidays added for this year",
        message: "Public holidays are not in the calendar, so attendance will mark those days absent.",
        resource: "holidays",
    },
};

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

/** Turn raw bucket rows into ordered, described warning cards. */
function buildWarnings(bucketRows, extraBuckets = {}) {
    const grouped = {};

    for (const row of bucketRows) {
        const key = row.bucket;
        if (!grouped[key]) grouped[key] = { count: num(row.total), sample: [] };
        grouped[key].sample.push(row.item);
    }

    for (const [key, value] of Object.entries(extraBuckets)) {
        if (value && value.count > 0) grouped[key] = value;
    }

    const items = Object.entries(grouped)
        .filter(([key, value]) => WARNING_CATALOG[key] && value.count > 0)
        .map(([key, value]) => ({
            key,
            ...WARNING_CATALOG[key],
            count: value.count,
            sample: value.sample,
        }))
        .sort(
            (a, b) =>
                SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count
        );

    const summary = { critical: 0, warning: 0, info: 0, total: 0 };
    for (const item of items) {
        summary[item.severity] += 1;
        summary.total += 1;
    }

    return { summary, items };
}

// ---------------------------------------------------------------------------
// Gratuity coverage
//
// Which rules apply is resolved exactly the way the gratuity module resolves
// it — config country → salary work_country → company country — so the
// dashboard can never disagree with the gratuity screen.
// ---------------------------------------------------------------------------

function buildGratuityBuckets(rows, sampleLimit) {
    const buckets = {
        gratuity_pending_decision: { count: 0, sample: [] },
        gratuity_no_scheme: { count: 0, sample: [] },
        gratuity_disabled: { count: 0, sample: [] },
    };

    let accruing = 0;
    let usingStatutoryDefault = 0;

    for (const row of rows) {
        const companyCountry = resolveCountryCode(row.company_country);
        const workCountry = normalizeCountry(row.work_country);
        const configured = Boolean(row.config_id);

        const ruleCountry =
            normalizeCountry(row.rule_country) || workCountry || companyCountry || null;

        const brief = {
            employee_id: row.employee_id,
            employee_code: row.employee_code,
            name: `${row.first_name} ${row.last_name}`,
            branch_id: row.branch_id,
            branch_name: row.branch_name,
            joining_date: row.joining_date,
            company_country: companyCountry,
            work_country: workCountry,
            rule_country: ruleCountry,
        };

        const push = (bucket, extra = {}) => {
            buckets[bucket].count += 1;
            if (buckets[bucket].sample.length < sampleLimit) {
                buckets[bucket].sample.push({ ...brief, ...extra });
            }
        };

        if (configured && row.is_enabled === false) {
            push("gratuity_disabled");
            continue;
        }

        if (configured) {
            accruing += 1;
            continue;
        }

        // Not configured — same fork the gratuity service takes.
        const isCrossBorder = Boolean(
            companyCountry && workCountry && companyCountry !== workCountry
        );

        if (isCrossBorder) {
            push("gratuity_pending_decision", {
                reason: `Works from ${workCountry} but employed by a ${companyCountry} company.`,
            });
            continue;
        }

        if (!hasGratuityPreset(ruleCountry)) {
            push("gratuity_no_scheme", {
                reason: ruleCountry
                    ? `No statutory scheme is built in for ${ruleCountry}.`
                    : "Country could not be determined from the salary structure or the company profile.",
            });
            continue;
        }

        usingStatutoryDefault += 1;
        accruing += 1;
    }

    const total = rows.length;
    const presetCountries = new Set(
        rows
            .map((r) =>
                normalizeCountry(r.rule_country) ||
                normalizeCountry(r.work_country) ||
                resolveCountryCode(r.company_country)
            )
            .filter((c) => hasGratuityPreset(c))
    );

    return {
        buckets,
        coverage: {
            total_employees: total,
            accruing,
            using_statutory_default: usingStatutoryDefault,
            explicitly_configured: accruing - usingStatutoryDefault,
            pending_decision: buckets.gratuity_pending_decision.count,
            no_scheme: buckets.gratuity_no_scheme.count,
            disabled: buckets.gratuity_disabled.count,
            coverage_rate: pct(accruing, total),
            schemes_in_use: [...presetCountries].map((code) => {
                const rule = getGratuityRule(code);
                return {
                    country_code: code,
                    country_name: rule.country_name,
                    scheme_name: rule.scheme_name,
                };
            }),
        },
    };
}

// ---------------------------------------------------------------------------
// Shapers
// ---------------------------------------------------------------------------

function shapeToday(snapshot) {
    const total = num(snapshot.total_employees);
    const checkedIn = num(snapshot.checked_in);
    const onLeave = num(snapshot.on_leave);
    const onHoliday = num(snapshot.on_holiday);
    const weekOff = num(snapshot.week_off);

    // Anyone not accounted for by a check-in or an approved non-working status.
    const absent = Math.max(total - checkedIn - onLeave - onHoliday - weekOff, 0);
    const expected = Math.max(total - onLeave - onHoliday - weekOff, 0);
    // Punctuality is only meaningful over people whose arrival was judged.
    const judged = num(snapshot.on_time) + num(snapshot.late);

    return {
        total_employees: total,
        present: checkedIn,
        checked_in: checkedIn,
        checked_out: num(snapshot.checked_out),
        currently_in: num(snapshot.currently_in),
        absent,
        on_leave: onLeave,
        on_holiday: onHoliday,
        week_off: weekOff,
        late: num(snapshot.late),
        on_time: num(snapshot.on_time),
        expected_today: expected,
        avg_hours: num(snapshot.avg_hours),
        attendance_rate: pct(checkedIn, expected),
        punctuality_rate: pct(snapshot.on_time, judged),
    };
}

function shapeCheckIn(row) {
    return {
        attendance_id: row.attendance_id,
        employee: {
            id: row.employee_id,
            employee_code: row.employee_code,
            name: `${row.first_name} ${row.last_name}`,
            is_remote_job: row.is_remote_job,
        },
        branch: { id: row.branch_id, name: row.branch_name },
        department_name: row.department_name,
        shift: { name: row.shift_name, start_time: row.shift_start_time },
        status: row.status,
        attendance_status: row.attendance_status,
        total_hours: row.total_hours === null ? null : num(row.total_hours),
        check_in: {
            at: row.check_in,
            latitude: row.check_in_latitude,
            longitude: row.check_in_longitude,
            address: row.check_in_address,
            selfie_url: row.check_in_selfie_url,
        },
        check_out: row.check_out
            ? {
                at: row.check_out,
                latitude: row.check_out_latitude,
                longitude: row.check_out_longitude,
                address: row.check_out_address,
            }
            : null,
    };
}

function shapeBranch(row) {
    const headcount = num(row.employee_count);
    const presentDays = num(row.present_days);
    const absentDays = num(row.absent_days);
    const leaveDays = num(row.leave_days);
    // Days the employee was expected at work — off days are excluded so a
    // branch with more week-offs is not punished in the ratio.
    const workingDays = presentDays + absentDays + leaveDays;

    return {
        branch_id: row.branch_id,
        branch_name: row.branch_name,
        branch_code: row.branch_code,
        city: row.city,
        country: row.country,
        is_head_office: row.is_head_office,
        is_active: row.is_active,

        employee_count: headcount,
        department_count: num(row.department_count),

        today: {
            checked_in: num(row.checked_in_today),
            currently_in: num(row.currently_in),
            on_leave: num(row.on_leave_today),
            late: num(row.late_today),
            absent: Math.max(headcount - num(row.checked_in_today) - num(row.on_leave_today), 0),
            check_in_rate: pct(row.checked_in_today, headcount),
        },

        range: {
            present_days: presentDays,
            absent_days: absentDays,
            leave_days: leaveDays,
            off_days: num(row.off_days),
            late_days: num(row.late_days),
            working_days: workingDays,
            total_hours: num(row.total_hours),
            attendance_rate: pct(presentDays, workingDays),
            absence_rate: pct(absentDays, workingDays),
            leave_rate: pct(leaveDays, workingDays),
            late_rate: pct(row.late_days, presentDays),
            avg_hours_per_present_day:
                presentDays > 0 ? Math.round((num(row.total_hours) / presentDays) * 100) / 100 : 0,
        },

        open_items: {
            pending_leave_requests: num(row.pending_leave_requests),
            missing_checkouts: num(row.missing_checkouts),
        },
    };
}

function groupUpcoming(rows) {
    const grouped = { holidays: [], birthdays: [], work_anniversaries: [], approved_leaves: [] };
    const keyByKind = {
        holiday: "holidays",
        birthday: "birthdays",
        work_anniversary: "work_anniversaries",
        approved_leave: "approved_leaves",
    };

    for (const row of rows) {
        const key = keyByKind[row.kind];
        if (key) grouped[key].push({ ...row.item, event_date: row.event_date });
    }
    return grouped;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const ALL_SECTIONS = ["headline", "today", "branches", "warnings", "upcoming", "trend"];

const DashboardService = {

    /**
     * Everything an admin sees on load, in one request.
     *
     * @param {String}   companyId
     * @param {String?}  branchId   scope the "today" numbers to one branch
     * @param {String[]} sections   subset of ALL_SECTIONS to compute
     * @param {Number}   rangeDays  window for branch ratios and the trend line
     * @param {Number}   upcomingDays  how far ahead the calendar looks
     */
    async getOverview({
        companyId,
        branchId = null,
        sections = ALL_SECTIONS,
        rangeDays = 30,
        upcomingDays = 30,
        sampleLimit = 5,
    }) {
        const company = await DashboardModel.getCompany(companyId);
        if (!company) return { success: false, message: "Company not found" };

        const today = todayInTimezone(company.timezone);
        const startDate = addDays(today, -(rangeDays - 1));
        const wants = (s) => sections.includes(s);

        const [
            headline,
            snapshot,
            recentCheckIns,
            branchRows,
            bucketRows,
            gratuityRows,
            upcomingRows,
            trendRows,
        ] = await Promise.all([
            wants("headline") ? DashboardModel.getHeadline(companyId, today, branchId) : null,
            wants("today") ? DashboardModel.getTodaySnapshot(companyId, today, branchId) : null,
            wants("today")
                ? DashboardModel.getTodayCheckIns(companyId, today, { branch_id: branchId, limit: sampleLimit, offset: 0 })
                : null,
            wants("branches")
                ? DashboardModel.getBranchStats(companyId, { startDate, endDate: today, today })
                : null,
            wants("warnings")
                ? DashboardModel.getWarningBuckets(companyId, today, {
                    sample_limit: sampleLimit,
                    branch_id: branchId,
                })
                : null,
            wants("warnings")
                ? DashboardModel.getGratuityCoverage(companyId, today, branchId)
                : null,
            wants("upcoming")
                ? DashboardModel.getUpcoming(companyId, today, upcomingDays, { branch_id: branchId })
                : null,
            wants("trend")
                ? DashboardModel.getAttendanceTrend(companyId, { startDate, endDate: today, branch_id: branchId })
                : null,
        ]);

        const data = {
            as_of: {
                date: today,
                timezone: company.timezone,
                generated_at: new Date().toISOString(),
                range: { start_date: startDate, end_date: today, days: rangeDays },
                // "company" until the admin picks a branch; from then on every
                // section except the branch comparison narrows to that branch.
                scope: branchId ? "branch" : "company",
                branch_id: branchId,
                branch_name: null,
            },
            company: {
                id: company.id,
                company_name: company.company_name,
                company_code: company.company_code,
                country: company.country,
                currency: company.currency,
                timezone: company.timezone,
                plan: company.plan,
                plan_expires_at: company.plan_expires_at,
            },
        };

        if (headline) {
            data.headline = {
                ...headline,
                total_employees: num(headline.active_employees),
            };
        }

        if (snapshot) {
            data.today = {
                ...shapeToday(snapshot),
                recent_check_ins: (recentCheckIns || []).map(shapeCheckIn),
            };
        }

        if (branchRows) {
            // The comparison table is never filtered — comparing one branch
            // against itself is not a comparison. The selected row is flagged
            // instead so the client can highlight it in place.
            const branches = branchRows.map((row) => ({
                ...shapeBranch(row),
                is_selected: branchId ? row.branch_id === branchId : false,
            }));

            data.branches = {
                count: branches.length,
                scope: "company",
                unassigned_employees:
                    headline && headline.unassigned_employees !== null
                        ? num(headline.unassigned_employees)
                        : null,
                items: branches,
            };

            const selected = branches.find((b) => b.is_selected);
            if (selected) data.as_of.branch_name = selected.branch_name;
        }

        if (bucketRows) {
            const gratuity = buildGratuityBuckets(gratuityRows || [], sampleLimit);
            data.warnings = buildWarnings(bucketRows, gratuity.buckets);
            data.gratuity = gratuity.coverage;
        }

        if (upcomingRows) {
            const grouped = groupUpcoming(upcomingRows);
            data.upcoming = {
                days: upcomingDays,
                counts: {
                    holidays: grouped.holidays.length,
                    birthdays: grouped.birthdays.length,
                    work_anniversaries: grouped.work_anniversaries.length,
                    approved_leaves: grouped.approved_leaves.length,
                },
                ...grouped,
            };
        }

        if (trendRows) {
            data.trend = trendRows.map((r) => ({
                date: r.date,
                present: num(r.present),
                absent: num(r.absent),
                on_leave: num(r.on_leave),
                late: num(r.late),
            }));
        }

        return { success: true, data };
    },

    /**
     * Today's check-ins with their locations, or the flip side of the same
     * question: who was expected and has not checked in.
     */
    async getTodayAttendance({
        companyId,
        branchId = null,
        departmentId = null,
        attendanceStatus = null,
        view = "checked-in",
        onlyOpen = false,
        page = 1,
        limit = 50,
        date = null,
    }) {
        const company = await DashboardModel.getCompany(companyId);
        if (!company) return { success: false, message: "Company not found" };

        const day = date || todayInTimezone(company.timezone);
        const offset = (page - 1) * limit;

        const rows =
            view === "missing"
                ? await DashboardModel.getTodayMissing(companyId, day, {
                    branch_id: branchId,
                    limit,
                    offset,
                })
                : await DashboardModel.getTodayCheckIns(companyId, day, {
                    branch_id: branchId,
                    department_id: departmentId,
                    attendance_status: attendanceStatus,
                    only_open: onlyOpen,
                    limit,
                    offset,
                });

        const total = rows.length > 0 ? num(rows[0].total_count) : 0;

        const items =
            view === "missing"
                ? rows.map((r) => ({
                    employee: {
                        id: r.employee_id,
                        employee_code: r.employee_code,
                        name: `${r.first_name} ${r.last_name}`,
                        phone: r.phone,
                    },
                    branch: { id: r.branch_id, name: r.branch_name },
                    department_name: r.department_name,
                    shift: { name: r.shift_name, start_time: r.shift_start_time },
                    status: r.status,
                }))
                : rows.map(shapeCheckIn);

        return {
            success: true,
            data: {
                as_of: { date: day, timezone: company.timezone, view, branch_id: branchId },
                items,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit) || 0,
                    hasNextPage: page * limit < total,
                    hasPrevPage: page > 1,
                },
            },
        };
    },

    /**
     * Everything that needs an admin's attention, grouped and ranked.
     *
     * branchId narrows it the same way the overview does, so the drill-down
     * always matches the card the admin clicked through from.
     */
    async getWarnings({
        companyId,
        branchId = null,
        sampleLimit = 10,
        expiryWindowDays = 60,
        severity = null,
    }) {
        const company = await DashboardModel.getCompany(companyId);
        if (!company) return { success: false, message: "Company not found" };

        const today = todayInTimezone(company.timezone);

        const [bucketRows, gratuityRows] = await Promise.all([
            DashboardModel.getWarningBuckets(companyId, today, {
                sample_limit: sampleLimit,
                expiry_window_days: expiryWindowDays,
                branch_id: branchId,
            }),
            DashboardModel.getGratuityCoverage(companyId, today, branchId),
        ]);

        const gratuity = buildGratuityBuckets(gratuityRows, sampleLimit);
        const warnings = buildWarnings(bucketRows, gratuity.buckets);

        const items = severity
            ? warnings.items.filter((w) => w.severity === severity)
            : warnings.items;

        return {
            success: true,
            data: {
                as_of: {
                    date: today,
                    timezone: company.timezone,
                    scope: branchId ? "branch" : "company",
                    branch_id: branchId,
                },
                summary: warnings.summary,
                sample_limit: sampleLimit,
                expiry_window_days: expiryWindowDays,
                gratuity: gratuity.coverage,
                items,
            },
        };
    },

    /** Branch league table — headcount, today's presence and range ratios. */
    async getBranchStats({ companyId, startDate = null, endDate = null }) {
        const company = await DashboardModel.getCompany(companyId);
        if (!company) return { success: false, message: "Company not found" };

        const today = todayInTimezone(company.timezone);
        const end = endDate || today;
        const start = startDate || addDays(end, -29);

        if (start > end) {
            return { success: false, message: "startDate must be before or equal to endDate" };
        }

        const rows = await DashboardModel.getBranchStats(companyId, {
            startDate: start,
            endDate: end,
            today,
        });

        const branches = rows.map(shapeBranch);

        // Company-level totals so the client never has to sum the array itself.
        const totals = branches.reduce(
            (acc, b) => {
                acc.employee_count += b.employee_count;
                acc.checked_in_today += b.today.checked_in;
                acc.on_leave_today += b.today.on_leave;
                acc.late_today += b.today.late;
                acc.present_days += b.range.present_days;
                acc.absent_days += b.range.absent_days;
                acc.leave_days += b.range.leave_days;
                acc.working_days += b.range.working_days;
                acc.pending_leave_requests += b.open_items.pending_leave_requests;
                return acc;
            },
            {
                employee_count: 0,
                checked_in_today: 0,
                on_leave_today: 0,
                late_today: 0,
                present_days: 0,
                absent_days: 0,
                leave_days: 0,
                working_days: 0,
                pending_leave_requests: 0,
            }
        );

        return {
            success: true,
            data: {
                as_of: {
                    date: today,
                    timezone: company.timezone,
                    range: { start_date: start, end_date: end },
                },
                totals: {
                    ...totals,
                    attendance_rate: pct(totals.present_days, totals.working_days),
                    leave_rate: pct(totals.leave_days, totals.working_days),
                    check_in_rate_today: pct(totals.checked_in_today, totals.employee_count),
                },
                branches,
            },
        };
    },

    /** Holidays, birthdays, anniversaries and approved leaves ahead. */
    async getUpcoming({ companyId, branchId = null, days = 30 }) {
        const company = await DashboardModel.getCompany(companyId);
        if (!company) return { success: false, message: "Company not found" };

        const today = todayInTimezone(company.timezone);
        const rows = await DashboardModel.getUpcoming(companyId, today, days, {
            branch_id: branchId,
        });

        const grouped = groupUpcoming(rows);

        return {
            success: true,
            data: {
                as_of: {
                    date: today,
                    timezone: company.timezone,
                    horizon: { start_date: today, end_date: addDays(today, days), days },
                    branch_id: branchId,
                },
                counts: {
                    holidays: grouped.holidays.length,
                    birthdays: grouped.birthdays.length,
                    work_anniversaries: grouped.work_anniversaries.length,
                    approved_leaves: grouped.approved_leaves.length,
                },
                ...grouped,
            },
        };
    },
};

module.exports = {
    ...DashboardService,
    // exported for the controller's input validation
    ALL_SECTIONS,
    _helpers: { todayInTimezone, addDays, pct, isUuid, isDate, clamp },
};
