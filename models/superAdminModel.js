const db = require("../config/database");

/**
 * Super Admin data access — cross-company (platform-wide) reads plus the
 * company enable/disable controls.
 *
 * Conventions used throughout:
 *   present   → attendance.status IN ('checked-in', 'checked-out')
 *   punctual  → attendance.attendance_status IN ('on-time', 'before-time')
 *   late      → attendance.attendance_status = 'late'
 * Rates are returned as percentages (0-100), rounded to 2 decimals.
 */

// ── Shared SQL fragments ─────────────────────────────────────────────────────
const PRESENT = `status IN ('checked-in', 'checked-out')`;
const PUNCTUAL = `attendance_status IN ('on-time', 'before-time')`;

const ATTENDANCE_AGG = `
    COUNT(*)                                              AS total_records,
    COUNT(*) FILTER (WHERE ${PRESENT})                    AS present_count,
    COUNT(*) FILTER (WHERE status = 'absent')             AS absent_count,
    COUNT(*) FILTER (WHERE status = 'leave')              AS leave_count,
    COUNT(*) FILTER (WHERE status = 'holiday')            AS holiday_count,
    COUNT(*) FILTER (WHERE status = 'week-off')           AS week_off_count,
    COUNT(*) FILTER (WHERE ${PUNCTUAL})                   AS punctual_count,
    COUNT(*) FILTER (WHERE attendance_status = 'late')    AS late_count,
    COUNT(*) FILTER (WHERE attendance_status = 'before-time') AS early_count,
    COALESCE(SUM(total_hours), 0)                         AS total_hours,
    COALESCE(ROUND(AVG(total_hours) FILTER (WHERE ${PRESENT}), 2), 0) AS avg_hours_per_day
`;

// Sortable columns for the company list — whitelist guards against injection.
const COMPANY_SORT_COLUMNS = {
    company_name: "c.company_name",
    created_at: "c.created_at",
    plan: "c.plan",
    employee_count: "stats.employee_count",
    branch_count: "stats.branch_count",
    attendance_rate: "attendance_rate",
    punctuality_rate: "punctuality_rate",
    status: "c.is_active",
};

const EMPLOYEE_SORT_COLUMNS = {
    first_name: "e.first_name",
    joining_date: "e.joining_date",
    attendance_rate: "attendance_rate",
    punctuality_rate: "punctuality_rate",
    present_days: "present_days",
    late_days: "late_days",
};

const SuperAdmin = {
    // ═══════════════════════════════════════════════════════════════════════
    // PLATFORM OVERVIEW
    // ═══════════════════════════════════════════════════════════════════════

    /** Headline counters across every company on the platform. */
    async getPlatformTotals() {
        const result = await db.query(`
            SELECT
                (SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL)                       AS total_companies,
                (SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL AND is_active = true)  AS active_companies,
                (SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL AND is_active = false) AS disabled_companies,
                (SELECT COUNT(*) FROM companies WHERE deleted_at IS NULL
                    AND created_at >= date_trunc('month', CURRENT_DATE))                        AS companies_added_this_month,
                (SELECT COUNT(*) FROM employees WHERE deleted_at IS NULL)                       AS total_employees,
                (SELECT COUNT(*) FROM employees WHERE deleted_at IS NULL
                    AND is_active = true AND status = 'active')                                 AS active_employees,
                (SELECT COUNT(*) FROM branches  WHERE deleted_at IS NULL)                       AS total_branches,
                (SELECT COUNT(*) FROM departments WHERE deleted_at IS NULL)                     AS total_departments,
                (SELECT COUNT(*) FROM shifts    WHERE deleted_at IS NULL)                       AS total_shifts,
                (SELECT COUNT(*) FROM users     WHERE deleted_at IS NULL)                       AS total_users,
                (SELECT COUNT(*) FROM users     WHERE deleted_at IS NULL AND is_super_admin = true) AS total_super_admins,
                (SELECT COUNT(*) FROM user_companies uc WHERE uc.deleted_at IS NULL AND uc.role = '0') AS total_company_admins
        `);
        return result.rows[0];
    },

    /** Attendance aggregate across the whole platform for a date window. */
    async getPlatformAttendance(from, to) {
        const result = await db.query(
            `SELECT ${ATTENDANCE_AGG},
                    COUNT(DISTINCT employee_id) AS employees_with_records,
                    COUNT(DISTINCT company_id)  AS companies_with_records
             FROM attendance
             WHERE attendance_date BETWEEN $1 AND $2`,
            [from, to]
        );
        return result.rows[0];
    },

    /** Day-by-day platform attendance trend (for the overview chart). */
    async getPlatformAttendanceTrend(from, to) {
        const result = await db.query(
            `SELECT attendance_date,
                    COUNT(*) FILTER (WHERE ${PRESENT})                 AS present_count,
                    COUNT(*) FILTER (WHERE status = 'absent')          AS absent_count,
                    COUNT(*) FILTER (WHERE status = 'leave')           AS leave_count,
                    COUNT(*) FILTER (WHERE ${PUNCTUAL})                AS punctual_count,
                    COUNT(*) FILTER (WHERE attendance_status = 'late') AS late_count
             FROM attendance
             WHERE attendance_date BETWEEN $1 AND $2
             GROUP BY attendance_date
             ORDER BY attendance_date ASC`,
            [from, to]
        );
        return result.rows;
    },

    /** Company signups per month for the last N months. */
    async getCompanyGrowth(months = 12) {
        const result = await db.query(
            `SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
                    COUNT(*)                                            AS companies_added
             FROM companies
             WHERE deleted_at IS NULL
               AND created_at >= date_trunc('month', CURRENT_DATE) - ($1::int - 1) * INTERVAL '1 month'
             GROUP BY 1
             ORDER BY 1 ASC`,
            [months]
        );
        return result.rows;
    },

    /** Company count grouped by subscription plan. */
    async getPlanDistribution() {
        const result = await db.query(
            `SELECT plan,
                    COUNT(*)                                    AS company_count,
                    COUNT(*) FILTER (WHERE is_active = true)     AS active_count,
                    COUNT(*) FILTER (WHERE is_active = false)    AS disabled_count,
                    COUNT(*) FILTER (WHERE plan_expires_at IS NOT NULL
                                       AND plan_expires_at < NOW()) AS expired_count
             FROM companies
             WHERE deleted_at IS NULL
             GROUP BY plan
             ORDER BY company_count DESC`
        );
        return result.rows;
    },

    /** Companies ranked by a metric — used for the leaderboard widgets. */
    async getCompanyLeaderboard(from, to, metric = "punctuality_rate", limit = 5) {
        const orderBy =
            metric === "attendance_rate" ? "attendance_rate" : "punctuality_rate";

        const result = await db.query(
            `WITH att AS (
                SELECT company_id,
                       COUNT(*) FILTER (WHERE ${PRESENT})                 AS present_count,
                       COUNT(*) FILTER (WHERE status = 'absent')          AS absent_count,
                       COUNT(*) FILTER (WHERE ${PUNCTUAL})                AS punctual_count,
                       COUNT(*) FILTER (WHERE attendance_status = 'late') AS late_count
                FROM attendance
                WHERE attendance_date BETWEEN $1 AND $2
                GROUP BY company_id
            )
            SELECT c.id, c.company_name, c.company_code, c.logo_url, c.is_active,
                   COALESCE(a.present_count, 0)  AS present_count,
                   COALESCE(a.absent_count, 0)   AS absent_count,
                   COALESCE(a.punctual_count, 0) AS punctual_count,
                   COALESCE(a.late_count, 0)     AS late_count,
                   COALESCE(ROUND(a.present_count * 100.0
                       / NULLIF(a.present_count + a.absent_count, 0), 2), 0) AS attendance_rate,
                   COALESCE(ROUND(a.punctual_count * 100.0
                       / NULLIF(a.present_count, 0), 2), 0)                  AS punctuality_rate
            FROM companies c
            LEFT JOIN att a ON a.company_id = c.id
            WHERE c.deleted_at IS NULL
              AND COALESCE(a.present_count, 0) > 0
            ORDER BY ${orderBy} DESC, c.company_name ASC
            LIMIT $3`,
            [from, to, limit]
        );
        return result.rows;
    },

    // ═══════════════════════════════════════════════════════════════════════
    // COMPANIES
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Paginated company list with per-company counts and attendance KPIs.
     * @param {Object} opts page, limit, search, status, plan, sort_by, sort_order, from, to
     */
    async listCompanies(opts) {
        const {
            page = 1,
            limit = 20,
            search = null,
            status = null, // active | disabled
            plan = null,
            sort_by = "created_at",
            sort_order = "desc",
            from,
            to,
        } = opts;

        const offset = (page - 1) * limit;

        // The list query burns $1/$2 on the date window; the count query does not.
        // Building the filter clause per-query keeps the placeholders in sync.
        const buildWhere = (startIndex) => {
            const conds = ["c.deleted_at IS NULL"];
            const vals = [];
            let i = startIndex;

            if (search) {
                i++;
                vals.push(`%${search}%`);
                conds.push(
                    `(c.company_name ILIKE $${i} OR c.company_code ILIKE $${i} OR c.email ILIKE $${i})`
                );
            }
            if (status === "active") conds.push("c.is_active = true");
            if (status === "disabled") conds.push("c.is_active = false");
            if (plan) {
                i++;
                vals.push(plan);
                conds.push(`c.plan = $${i}`);
            }

            return { sql: conds.join(" AND "), vals, next: i };
        };

        const listWhere = buildWhere(2); // $1 = from, $2 = to
        const countWhere = buildWhere(0);

        const orderColumn = COMPANY_SORT_COLUMNS[sort_by] || "c.created_at";
        const orderDir = String(sort_order).toLowerCase() === "asc" ? "ASC" : "DESC";

        const whereSql = listWhere.sql;
        const p = listWhere.next;
        const values = [from, to, ...listWhere.vals];

        const listSql = `
            WITH att AS (
                SELECT company_id,
                       COUNT(*) FILTER (WHERE ${PRESENT})                 AS present_count,
                       COUNT(*) FILTER (WHERE status = 'absent')          AS absent_count,
                       COUNT(*) FILTER (WHERE status = 'leave')           AS leave_count,
                       COUNT(*) FILTER (WHERE ${PUNCTUAL})                AS punctual_count,
                       COUNT(*) FILTER (WHERE attendance_status = 'late') AS late_count,
                       COALESCE(SUM(total_hours), 0)                      AS total_hours
                FROM attendance
                WHERE attendance_date BETWEEN $1 AND $2
                GROUP BY company_id
            ),
            stats AS (
                SELECT c.id AS company_id,
                    (SELECT COUNT(*) FROM employees   e WHERE e.company_id   = c.id AND e.deleted_at IS NULL) AS employee_count,
                    (SELECT COUNT(*) FROM employees   e WHERE e.company_id   = c.id AND e.deleted_at IS NULL
                        AND e.is_active = true AND e.status = 'active')                                       AS active_employee_count,
                    (SELECT COUNT(*) FROM branches    b WHERE b.company_id   = c.id AND b.deleted_at IS NULL) AS branch_count,
                    (SELECT COUNT(*) FROM departments d WHERE d.company_id   = c.id AND d.deleted_at IS NULL) AS department_count,
                    (SELECT COUNT(*) FROM shifts      s WHERE s.company_id   = c.id AND s.deleted_at IS NULL) AS shift_count,
                    (SELECT COUNT(*) FROM user_companies uc WHERE uc.company_id = c.id AND uc.deleted_at IS NULL) AS user_count,
                    (SELECT COUNT(*) FROM user_companies uc WHERE uc.company_id = c.id AND uc.deleted_at IS NULL
                        AND uc.role = '0')                                                                    AS admin_count,
                    (SELECT MAX(a.attendance_date) FROM attendance a WHERE a.company_id = c.id)               AS last_attendance_date
                FROM companies c
                WHERE ${whereSql}
            )
            SELECT
                c.id, c.company_name, c.company_code, c.logo_url,
                c.email, c.phone, c.country, c.timezone, c.currency,
                c.plan, c.plan_expires_at,
                c.is_active, c.disabled_at, c.disabled_reason, c.disabled_by,
                c.created_at, c.updated_at,
                (c.is_active = false)                    AS is_disabled,
                (c.plan_expires_at IS NOT NULL
                    AND c.plan_expires_at < NOW())       AS is_plan_expired,
                stats.employee_count, stats.active_employee_count,
                stats.branch_count, stats.department_count, stats.shift_count,
                stats.user_count, stats.admin_count, stats.last_attendance_date,
                COALESCE(a.present_count, 0)   AS present_count,
                COALESCE(a.absent_count, 0)    AS absent_count,
                COALESCE(a.leave_count, 0)     AS leave_count,
                COALESCE(a.punctual_count, 0)  AS punctual_count,
                COALESCE(a.late_count, 0)      AS late_count,
                COALESCE(a.total_hours, 0)     AS total_hours,
                COALESCE(ROUND(a.present_count * 100.0
                    / NULLIF(a.present_count + a.absent_count, 0), 2), 0) AS attendance_rate,
                COALESCE(ROUND(a.punctual_count * 100.0
                    / NULLIF(a.present_count, 0), 2), 0)                  AS punctuality_rate
            FROM companies c
            JOIN stats ON stats.company_id = c.id
            LEFT JOIN att a ON a.company_id = c.id
            WHERE ${whereSql}
            ORDER BY ${orderColumn} ${orderDir} NULLS LAST
            LIMIT $${p + 1} OFFSET $${p + 2}
        `;

        const listResult = await db.query(listSql, [...values, limit, offset]);

        // Count query reuses the same filters (minus the date window params).
        const countResult = await db.query(
            `SELECT COUNT(*) AS total FROM companies c WHERE ${countWhere.sql}`,
            countWhere.vals
        );

        return {
            rows: listResult.rows,
            total: parseInt(countResult.rows[0].total, 10),
        };
    },

    /** Lightweight list for dropdowns / company switcher in the panel. */
    async listCompaniesLite() {
        const result = await db.query(
            `SELECT id, company_name, company_code, logo_url, is_active
             FROM companies
             WHERE deleted_at IS NULL
             ORDER BY company_name ASC`
        );
        return result.rows;
    },

    /** Full company record including who disabled it. */
    async getCompany(company_id) {
        const result = await db.query(
            `SELECT c.*,
                    (c.is_active = false) AS is_disabled,
                    (c.plan_expires_at IS NOT NULL AND c.plan_expires_at < NOW()) AS is_plan_expired,
                    du.first_name || ' ' || du.last_name AS disabled_by_name,
                    du.email                             AS disabled_by_email
             FROM companies c
             LEFT JOIN users du ON du.id = c.disabled_by
             WHERE c.id = $1 AND c.deleted_at IS NULL`,
            [company_id]
        );
        return result.rows[0];
    },

    /** Structural counts for one company. */
    async getCompanyCounts(company_id) {
        const result = await db.query(
            `SELECT
                (SELECT COUNT(*) FROM branches    WHERE company_id = $1 AND deleted_at IS NULL) AS branch_count,
                (SELECT COUNT(*) FROM departments WHERE company_id = $1 AND deleted_at IS NULL) AS department_count,
                (SELECT COUNT(*) FROM shifts      WHERE company_id = $1 AND deleted_at IS NULL) AS shift_count,
                (SELECT COUNT(*) FROM employees   WHERE company_id = $1 AND deleted_at IS NULL) AS employee_count,
                (SELECT COUNT(*) FROM employees   WHERE company_id = $1 AND deleted_at IS NULL
                    AND is_active = true AND status = 'active')                                 AS active_employee_count,
                (SELECT COUNT(*) FROM employees   WHERE company_id = $1 AND deleted_at IS NULL
                    AND is_remote_job = true)                                                   AS remote_employee_count,
                (SELECT COUNT(*) FROM user_companies WHERE company_id = $1 AND deleted_at IS NULL) AS user_count,
                (SELECT COUNT(*) FROM user_companies WHERE company_id = $1 AND deleted_at IS NULL
                    AND role = '0')                                                             AS admin_count,
                (SELECT COUNT(*) FROM user_companies WHERE company_id = $1 AND deleted_at IS NULL
                    AND role = '1')                                                             AS manager_count,
                (SELECT COUNT(*) FROM user_companies WHERE company_id = $1 AND deleted_at IS NULL
                    AND is_invited = true AND invite_accepted_at IS NULL)                        AS pending_invite_count,
                (SELECT COUNT(*) FROM holidays    WHERE company_id = $1 AND deleted_at IS NULL)  AS holiday_count,
                (SELECT COUNT(*) FROM leave_types WHERE company_id = $1 AND deleted_at IS NULL)  AS leave_type_count,
                (SELECT MIN(created_at) FROM employees WHERE company_id = $1)                    AS first_employee_at,
                (SELECT MAX(attendance_date) FROM attendance WHERE company_id = $1)              AS last_attendance_date`,
            [company_id]
        );
        return result.rows[0];
    },

    /** Employee headcount split by gender / employment type / status. */
    async getCompanyWorkforceBreakdown(company_id) {
        const [byType, byStatus, byGender] = await Promise.all([
            db.query(
                `SELECT COALESCE(employment_type, 'unspecified') AS employment_type, COUNT(*) AS count
                 FROM employees WHERE company_id = $1 AND deleted_at IS NULL
                 GROUP BY 1 ORDER BY count DESC`,
                [company_id]
            ),
            db.query(
                `SELECT status, COUNT(*) AS count
                 FROM employees WHERE company_id = $1 AND deleted_at IS NULL
                 GROUP BY 1 ORDER BY count DESC`,
                [company_id]
            ),
            db.query(
                `SELECT COALESCE(gender, 'unspecified') AS gender, COUNT(*) AS count
                 FROM employees WHERE company_id = $1 AND deleted_at IS NULL
                 GROUP BY 1 ORDER BY count DESC`,
                [company_id]
            ),
        ]);

        return {
            by_employment_type: byType.rows,
            by_status: byStatus.rows,
            by_gender: byGender.rows,
        };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // COMPANY SUB-RESOURCES
    // ═══════════════════════════════════════════════════════════════════════

    /** Branches with headcount and geofence info (drives the locations map). */
    async listCompanyBranches(company_id) {
        const result = await db.query(
            `SELECT b.*,
                    (SELECT COUNT(*) FROM employees   e WHERE e.branch_id = b.id AND e.deleted_at IS NULL) AS employee_count,
                    (SELECT COUNT(*) FROM departments d WHERE d.branch_id = b.id AND d.deleted_at IS NULL) AS department_count,
                    (SELECT COUNT(*) FROM shifts      s WHERE s.branch_id = b.id AND s.deleted_at IS NULL) AS shift_count
             FROM branches b
             WHERE b.company_id = $1 AND b.deleted_at IS NULL
             ORDER BY b.is_head_office DESC, b.branch_name ASC`,
            [company_id]
        );
        return result.rows;
    },

    async listCompanyShifts(company_id) {
        const result = await db.query(
            `SELECT s.*,
                    b.branch_name,
                    (SELECT COUNT(*) FROM employees e WHERE e.shift_id = s.id AND e.deleted_at IS NULL) AS employee_count
             FROM shifts s
             LEFT JOIN branches b ON b.id = s.branch_id
             WHERE s.company_id = $1 AND s.deleted_at IS NULL
             ORDER BY b.branch_name ASC, s.start_time ASC`,
            [company_id]
        );
        return result.rows;
    },

    async listCompanyDepartments(company_id) {
        const result = await db.query(
            `SELECT d.*,
                    b.branch_name,
                    (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id AND e.deleted_at IS NULL) AS employee_count
             FROM departments d
             LEFT JOIN branches b ON b.id = d.branch_id
             WHERE d.company_id = $1 AND d.deleted_at IS NULL
             ORDER BY b.branch_name ASC, d.department_name ASC`,
            [company_id]
        );
        return result.rows;
    },

    /** Admin / manager accounts of a company — who to contact about it. */
    async listCompanyAdmins(company_id) {
        const result = await db.query(
            `SELECT uc.id AS user_company_id, uc.username, uc.role, uc.is_active,
                    uc.is_invited, uc.invite_accepted_at, uc.locked_at, uc.created_at,
                    u.id AS user_id, u.first_name, u.last_name, u.email, u.phone,
                    u.last_login_at, u.is_super_admin
             FROM user_companies uc
             JOIN users u ON u.id = uc.user_id
             WHERE uc.company_id = $1
               AND uc.deleted_at IS NULL
               AND u.deleted_at IS NULL
               AND uc.role IN ('0', '1')
             ORDER BY uc.role ASC, u.first_name ASC`,
            [company_id]
        );
        return result.rows;
    },

    /**
     * Paginated employee list for one company, each row carrying its own
     * attendance frequency + punctuality figures for the window.
     */
    async listCompanyEmployees(company_id, opts) {
        const {
            page = 1,
            limit = 20,
            search = null,
            branch_id = null,
            department_id = null,
            status = null,
            sort_by = "first_name",
            sort_order = "asc",
            from,
            to,
        } = opts;

        const offset = (page - 1) * limit;

        // $1/$2 hold the date window in the list query only — see listCompanies.
        const buildWhere = (startIndex) => {
            const conds = ["e.deleted_at IS NULL"];
            const vals = [];
            let i = startIndex;

            i++;
            vals.push(company_id);
            conds.push(`e.company_id = $${i}`);

            if (search) {
                i++;
                vals.push(`%${search}%`);
                conds.push(
                    `(e.first_name ILIKE $${i} OR e.last_name ILIKE $${i} OR e.email ILIKE $${i} OR e.employee_code ILIKE $${i})`
                );
            }
            if (branch_id) {
                i++;
                vals.push(branch_id);
                conds.push(`e.branch_id = $${i}`);
            }
            if (department_id) {
                i++;
                vals.push(department_id);
                conds.push(`e.department_id = $${i}`);
            }
            if (status) {
                i++;
                vals.push(status);
                conds.push(`e.status = $${i}`);
            }

            return { sql: conds.join(" AND "), vals, next: i };
        };

        const listWhere = buildWhere(2); // $1 = from, $2 = to, $3 = company_id
        const countWhere = buildWhere(0);

        const whereSql = listWhere.sql;
        const p = listWhere.next;
        const values = [from, to, ...listWhere.vals];
        const orderColumn = EMPLOYEE_SORT_COLUMNS[sort_by] || "e.first_name";
        const orderDir = String(sort_order).toLowerCase() === "desc" ? "DESC" : "ASC";

        const listResult = await db.query(
            `WITH att AS (
                SELECT employee_id,
                       COUNT(*) FILTER (WHERE ${PRESENT})                     AS present_days,
                       COUNT(*) FILTER (WHERE status = 'absent')              AS absent_days,
                       COUNT(*) FILTER (WHERE status = 'leave')               AS leave_days,
                       COUNT(*) FILTER (WHERE ${PUNCTUAL})                    AS punctual_days,
                       COUNT(*) FILTER (WHERE attendance_status = 'late')     AS late_days,
                       COUNT(*) FILTER (WHERE attendance_status = 'before-time') AS early_days,
                       COALESCE(SUM(total_hours), 0)                          AS total_hours,
                       COALESCE(ROUND(AVG(total_hours) FILTER (WHERE ${PRESENT}), 2), 0) AS avg_hours_per_day,
                       MAX(attendance_date) FILTER (WHERE ${PRESENT})         AS last_present_date
                FROM attendance
                WHERE company_id = $3 AND attendance_date BETWEEN $1 AND $2
                GROUP BY employee_id
            )
            SELECT e.id, e.employee_code, e.first_name, e.last_name, e.email, e.phone,
                   e.gender, e.status, e.employment_type, e.joining_date,
                   e.is_active, e.is_remote_job,
                   e.branch_id, b.branch_name,
                   e.department_id, d.department_name,
                   e.shift_id, s.shift_name, s.start_time, s.end_time,
                   uc.username, uc.role, u.last_login_at,
                   COALESCE(a.present_days, 0)      AS present_days,
                   COALESCE(a.absent_days, 0)       AS absent_days,
                   COALESCE(a.leave_days, 0)        AS leave_days,
                   COALESCE(a.punctual_days, 0)     AS punctual_days,
                   COALESCE(a.late_days, 0)         AS late_days,
                   COALESCE(a.early_days, 0)        AS early_days,
                   COALESCE(a.total_hours, 0)       AS total_hours,
                   COALESCE(a.avg_hours_per_day, 0) AS avg_hours_per_day,
                   a.last_present_date,
                   COALESCE(ROUND(a.present_days * 100.0
                       / NULLIF(a.present_days + a.absent_days, 0), 2), 0) AS attendance_rate,
                   COALESCE(ROUND(a.punctual_days * 100.0
                       / NULLIF(a.present_days, 0), 2), 0)                 AS punctuality_rate
            FROM employees e
            LEFT JOIN branches    b  ON b.id = e.branch_id
            LEFT JOIN departments d  ON d.id = e.department_id
            LEFT JOIN shifts      s  ON s.id = e.shift_id
            LEFT JOIN users       u  ON u.id = e.user_id
            LEFT JOIN user_companies uc ON uc.user_id = e.user_id AND uc.company_id = e.company_id AND uc.deleted_at IS NULL
            LEFT JOIN att a ON a.employee_id = e.id
            WHERE ${whereSql}
            ORDER BY ${orderColumn} ${orderDir} NULLS LAST
            LIMIT $${p + 1} OFFSET $${p + 2}`,
            [...values, limit, offset]
        );

        const countResult = await db.query(
            `SELECT COUNT(*) AS total FROM employees e WHERE ${countWhere.sql}`,
            countWhere.vals
        );

        return {
            rows: listResult.rows,
            total: parseInt(countResult.rows[0].total, 10),
        };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // ATTENDANCE ANALYTICS (per company)
    // ═══════════════════════════════════════════════════════════════════════

    async getCompanyAttendanceSummary(company_id, from, to) {
        const result = await db.query(
            `SELECT ${ATTENDANCE_AGG},
                    COUNT(DISTINCT employee_id) AS employees_with_records
             FROM attendance
             WHERE company_id = $1 AND attendance_date BETWEEN $2 AND $3`,
            [company_id, from, to]
        );
        return result.rows[0];
    },

    async getCompanyAttendanceTrend(company_id, from, to) {
        const result = await db.query(
            `SELECT attendance_date,
                    COUNT(*) FILTER (WHERE ${PRESENT})                 AS present_count,
                    COUNT(*) FILTER (WHERE status = 'absent')          AS absent_count,
                    COUNT(*) FILTER (WHERE status = 'leave')           AS leave_count,
                    COUNT(*) FILTER (WHERE ${PUNCTUAL})                AS punctual_count,
                    COUNT(*) FILTER (WHERE attendance_status = 'late') AS late_count,
                    COALESCE(SUM(total_hours), 0)                      AS total_hours
             FROM attendance
             WHERE company_id = $1 AND attendance_date BETWEEN $2 AND $3
             GROUP BY attendance_date
             ORDER BY attendance_date ASC`,
            [company_id, from, to]
        );
        return result.rows;
    },

    /** Check-in volume by hour of day — shows when people actually arrive. */
    async getCompanyCheckInHistogram(company_id, from, to) {
        const result = await db.query(
            `SELECT EXTRACT(HOUR FROM check_in)::int AS hour, COUNT(*) AS count
             FROM attendance
             WHERE company_id = $1
               AND attendance_date BETWEEN $2 AND $3
               AND check_in IS NOT NULL
             GROUP BY 1
             ORDER BY 1 ASC`,
            [company_id, from, to]
        );
        return result.rows;
    },

    /** Attendance rolled up per branch. */
    async getCompanyAttendanceByBranch(company_id, from, to) {
        const result = await db.query(
            `SELECT b.id AS branch_id, b.branch_name, b.city, b.country,
                    b.latitude, b.longitude, b.attendance_radius,
                    (SELECT COUNT(*) FROM employees e WHERE e.branch_id = b.id AND e.deleted_at IS NULL) AS employee_count,
                    COUNT(a.id) FILTER (WHERE a.${PRESENT})                 AS present_count,
                    COUNT(a.id) FILTER (WHERE a.status = 'absent')          AS absent_count,
                    COUNT(a.id) FILTER (WHERE a.${PUNCTUAL})                AS punctual_count,
                    COUNT(a.id) FILTER (WHERE a.attendance_status = 'late') AS late_count,
                    COALESCE(ROUND(COUNT(a.id) FILTER (WHERE a.${PRESENT}) * 100.0
                        / NULLIF(COUNT(a.id) FILTER (WHERE a.${PRESENT} OR a.status = 'absent'), 0), 2), 0) AS attendance_rate,
                    COALESCE(ROUND(COUNT(a.id) FILTER (WHERE a.${PUNCTUAL}) * 100.0
                        / NULLIF(COUNT(a.id) FILTER (WHERE a.${PRESENT}), 0), 2), 0)                        AS punctuality_rate
             FROM branches b
             LEFT JOIN attendance a
                    ON a.branch_id = b.id
                   AND a.attendance_date BETWEEN $2 AND $3
             WHERE b.company_id = $1 AND b.deleted_at IS NULL
             GROUP BY b.id
             ORDER BY b.is_head_office DESC, b.branch_name ASC`,
            [company_id, from, to]
        );
        return result.rows;
    },

    /**
     * Geo points for the map: every branch geofence plus recent check-in
     * coordinates (capped so the payload stays small).
     */
    async getCompanyCheckInLocations(company_id, from, to, limit = 500) {
        const result = await db.query(
            `SELECT a.id, a.attendance_date, a.check_in, a.check_out,
                    a.check_in_latitude, a.check_in_longitude, a.check_in_address,
                    a.check_out_latitude, a.check_out_longitude, a.check_out_address,
                    a.attendance_status, a.status,
                    e.id AS employee_id, e.first_name, e.last_name, e.employee_code,
                    e.is_remote_job,
                    b.id AS branch_id, b.branch_name, b.latitude AS branch_latitude,
                    b.longitude AS branch_longitude, b.attendance_radius
             FROM attendance a
             JOIN employees e ON e.id = a.employee_id
             LEFT JOIN branches b ON b.id = a.branch_id
             WHERE a.company_id = $1
               AND a.attendance_date BETWEEN $2 AND $3
               AND a.check_in_latitude IS NOT NULL
               AND a.check_in_longitude IS NOT NULL
             ORDER BY a.attendance_date DESC, a.check_in DESC
             LIMIT $4`,
            [company_id, from, to, limit]
        );
        return result.rows;
    },

    /** Best / worst performers inside one company. */
    async getCompanyEmployeeRanking(company_id, from, to, direction = "top", limit = 5) {
        const order = direction === "bottom" ? "ASC" : "DESC";
        const result = await db.query(
            `WITH att AS (
                SELECT employee_id,
                       COUNT(*) FILTER (WHERE ${PRESENT})                 AS present_days,
                       COUNT(*) FILTER (WHERE status = 'absent')          AS absent_days,
                       COUNT(*) FILTER (WHERE ${PUNCTUAL})                AS punctual_days,
                       COUNT(*) FILTER (WHERE attendance_status = 'late') AS late_days
                FROM attendance
                WHERE company_id = $1 AND attendance_date BETWEEN $2 AND $3
                GROUP BY employee_id
            )
            SELECT e.id, e.first_name, e.last_name, e.employee_code, b.branch_name,
                   a.present_days, a.absent_days, a.punctual_days, a.late_days,
                   COALESCE(ROUND(a.punctual_days * 100.0 / NULLIF(a.present_days, 0), 2), 0) AS punctuality_rate,
                   COALESCE(ROUND(a.present_days * 100.0
                       / NULLIF(a.present_days + a.absent_days, 0), 2), 0)                    AS attendance_rate
            FROM att a
            JOIN employees e ON e.id = a.employee_id AND e.deleted_at IS NULL
            LEFT JOIN branches b ON b.id = e.branch_id
            WHERE a.present_days + a.absent_days > 0
            ORDER BY punctuality_rate ${order}, attendance_rate ${order}, e.first_name ASC
            LIMIT $4`,
            [company_id, from, to, limit]
        );
        return result.rows;
    },

    // ═══════════════════════════════════════════════════════════════════════
    // LEAVE ANALYTICS (per company)
    // ═══════════════════════════════════════════════════════════════════════

    async getCompanyLeaveStats(company_id, from, to) {
        const [summary, byType] = await Promise.all([
            db.query(
                `SELECT COUNT(*)                                          AS total_requests,
                        COUNT(*) FILTER (WHERE status = 'pending')        AS pending_count,
                        COUNT(*) FILTER (WHERE status = 'approved')       AS approved_count,
                        COUNT(*) FILTER (WHERE status = 'rejected')       AS rejected_count,
                        COUNT(*) FILTER (WHERE status = 'cancelled')      AS cancelled_count,
                        COALESCE(SUM(total_days) FILTER (WHERE status = 'approved'), 0) AS approved_days
                 FROM leave_requests
                 WHERE company_id = $1
                   AND deleted_at IS NULL
                   AND from_date <= $3 AND to_date >= $2`,
                [company_id, from, to]
            ),
            db.query(
                `SELECT lt.id, lt.leave_name, COUNT(lr.id) AS request_count,
                        COALESCE(SUM(lr.total_days), 0) AS total_days
                 FROM leave_types lt
                 LEFT JOIN leave_requests lr
                        ON lr.leave_type_id = lt.id
                       AND lr.deleted_at IS NULL
                       AND lr.from_date <= $3 AND lr.to_date >= $2
                 WHERE lt.company_id = $1 AND lt.deleted_at IS NULL
                 GROUP BY lt.id, lt.leave_name
                 ORDER BY request_count DESC`,
                [company_id, from, to]
            ),
        ]);

        return { summary: summary.rows[0], by_type: byType.rows };
    },

    // ═══════════════════════════════════════════════════════════════════════
    // COMPANY ENABLE / DISABLE
    // ═══════════════════════════════════════════════════════════════════════

    async disableCompany(company_id, actor_user_id, reason) {
        const result = await db.query(
            `UPDATE companies
             SET is_active = false,
                 disabled_at = NOW(),
                 disabled_reason = $2,
                 disabled_by = $3
             WHERE id = $1 AND deleted_at IS NULL
             RETURNING *`,
            [company_id, reason || null, actor_user_id]
        );
        return result.rows[0];
    },

    async enableCompany(company_id) {
        const result = await db.query(
            `UPDATE companies
             SET is_active = true,
                 disabled_at = NULL,
                 disabled_reason = NULL,
                 disabled_by = NULL
             WHERE id = $1 AND deleted_at IS NULL
             RETURNING *`,
            [company_id]
        );
        return result.rows[0];
    },

    async updateCompanyPlan(company_id, plan, plan_expires_at) {
        const result = await db.query(
            `UPDATE companies
             SET plan = $2, plan_expires_at = $3
             WHERE id = $1 AND deleted_at IS NULL
             RETURNING *`,
            [company_id, plan, plan_expires_at || null]
        );
        return result.rows[0];
    },

    // ═══════════════════════════════════════════════════════════════════════
    // SUPER ADMIN MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    async listSuperAdmins() {
        const result = await db.query(
            `SELECT u.id, u.first_name, u.last_name, u.email, u.phone,
                    u.is_active, u.last_login_at, u.created_at,
                    COALESCE(
                        json_agg(
                            json_build_object(
                                'company_id',   c.id,
                                'company_name', c.company_name,
                                'username',     uc.username,
                                'role',         uc.role
                            ) ORDER BY c.company_name
                        ) FILTER (WHERE c.id IS NOT NULL),
                        '[]'
                    ) AS companies
             FROM users u
             LEFT JOIN user_companies uc ON uc.user_id = u.id AND uc.deleted_at IS NULL
             LEFT JOIN companies c ON c.id = uc.company_id AND c.deleted_at IS NULL
             WHERE u.is_super_admin = true AND u.deleted_at IS NULL
             GROUP BY u.id
             ORDER BY u.first_name ASC`
        );
        return result.rows;
    },

    async setSuperAdminFlag(user_id, is_super_admin) {
        const result = await db.query(
            `UPDATE users SET is_super_admin = $2
             WHERE id = $1 AND deleted_at IS NULL
             RETURNING id, first_name, last_name, email, is_super_admin`,
            [user_id, is_super_admin]
        );
        return result.rows[0];
    },

    async countSuperAdmins() {
        const result = await db.query(
            `SELECT COUNT(*) AS total FROM users
             WHERE is_super_admin = true AND deleted_at IS NULL`
        );
        return parseInt(result.rows[0].total, 10);
    },

    // ═══════════════════════════════════════════════════════════════════════
    // AUDIT LOG
    // ═══════════════════════════════════════════════════════════════════════

    async createAuditLog(data) {
        const {
            actor_user_id,
            action,
            target_company_id = null,
            target_user_id = null,
            reason = null,
            metadata = {},
            ip_address = null,
        } = data;

        const result = await db.query(
            `INSERT INTO super_admin_audit_logs
                (actor_user_id, action, target_company_id, target_user_id, reason, metadata, ip_address)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [
                actor_user_id,
                action,
                target_company_id,
                target_user_id,
                reason,
                JSON.stringify(metadata),
                ip_address,
            ]
        );
        return result.rows[0];
    },

    async listAuditLogs({ page = 1, limit = 20, action = null, company_id = null }) {
        const offset = (page - 1) * limit;
        const where = ["1 = 1"];
        const values = [];
        let p = 0;

        if (action) {
            p++;
            values.push(action);
            where.push(`l.action = $${p}`);
        }
        if (company_id) {
            p++;
            values.push(company_id);
            where.push(`l.target_company_id = $${p}`);
        }

        const whereSql = where.join(" AND ");

        const listResult = await db.query(
            `SELECT l.*,
                    au.first_name || ' ' || au.last_name AS actor_name,
                    au.email                             AS actor_email,
                    c.company_name                       AS target_company_name,
                    tu.first_name || ' ' || tu.last_name AS target_user_name
             FROM super_admin_audit_logs l
             JOIN users au ON au.id = l.actor_user_id
             LEFT JOIN companies c ON c.id = l.target_company_id
             LEFT JOIN users tu ON tu.id = l.target_user_id
             WHERE ${whereSql}
             ORDER BY l.created_at DESC
             LIMIT $${p + 1} OFFSET $${p + 2}`,
            [...values, limit, offset]
        );

        const countResult = await db.query(
            `SELECT COUNT(*) AS total FROM super_admin_audit_logs l WHERE ${whereSql}`,
            values
        );

        return {
            rows: listResult.rows,
            total: parseInt(countResult.rows[0].total, 10),
        };
    },
};

module.exports = SuperAdmin;
