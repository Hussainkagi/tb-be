const db = require("../config/database");

/**
 * Dashboard aggregation queries.
 *
 * Everything here is read-only and deliberately shaped so that one screen
 * costs a handful of queries instead of one query per widget:
 *
 *   • counts come back pre-aggregated from Postgres (never "fetch rows, count
 *     in JS") so payload size does not grow with headcount
 *   • list widgets return a capped sample plus the true total, using
 *     COUNT(*) OVER () so the total costs no extra round trip
 *   • the warnings screen is a single UNION ALL query — one trip for every
 *     bucket — with each bucket carrying its own total and its own top-N rows
 *
 * "Active employee" means the same thing everywhere: not soft-deleted,
 * is_active, and not terminated. Kept in ACTIVE_EMPLOYEE so a change to that
 * definition cannot drift between widgets.
 */

const ACTIVE_EMPLOYEE = `e.deleted_at IS NULL AND e.is_active = TRUE AND e.status <> 'terminated'`;

// Attendance is always attributed to the employee's own branch (not
// attendance.branch_id) so headcount and attendance numbers add up per branch
// even when someone checks in while visiting another site.

const Dashboard = {

    // -----------------------------------------------------------------------
    // Company context — timezone drives what "today" means for this tenant
    // -----------------------------------------------------------------------
    async getCompany(company_id) {
        const result = await db.query(
            `SELECT id, company_name, company_code, country, timezone, currency,
                    plan, plan_expires_at, is_active
             FROM companies
             WHERE id = $1 AND deleted_at IS NULL`,
            [company_id]
        );
        return result.rows[0];
    },

    // -----------------------------------------------------------------------
    // Headline counters (org size, movement, open items)
    //
    // With no branch selected these are company-wide. Once the admin picks a
    // branch, every counter that CAN be branch-scoped is — otherwise the card
    // row would contradict the panels below it on the same screen.
    //
    // Two deliberately stay company-wide:
    //   branches             — the org's shape, not a property of one branch
    //   unassigned_employees — means "branch_id IS NULL", so it is meaningless
    //                          inside a branch; returned as NULL to hide it
    // -----------------------------------------------------------------------
    async getHeadline(company_id, today, branch_id = null) {
        const inBranch = `($3::uuid IS NULL OR e.branch_id = $3::uuid)`;

        const result = await db.query(
            `SELECT
                $3::uuid                                                                AS branch_id,

                (SELECT COUNT(*)::int FROM employees e
                  WHERE e.company_id = $1 AND ${ACTIVE_EMPLOYEE}
                    AND ${inBranch})                                                    AS active_employees,

                (SELECT COUNT(*)::int FROM employees e
                  WHERE e.company_id = $1 AND e.deleted_at IS NULL
                    AND (e.is_active = FALSE OR e.status = 'terminated')
                    AND ${inBranch})                                                    AS inactive_employees,

                (SELECT CASE WHEN $3::uuid IS NULL THEN COUNT(*)::int END
                   FROM employees e
                  WHERE e.company_id = $1 AND ${ACTIVE_EMPLOYEE}
                    AND e.branch_id IS NULL)                                            AS unassigned_employees,

                (SELECT COUNT(*)::int FROM employees e
                  WHERE e.company_id = $1 AND ${ACTIVE_EMPLOYEE}
                    AND ${inBranch}
                    AND e.joining_date >= DATE_TRUNC('month', $2::date))                AS joined_this_month,

                (SELECT COUNT(*)::int FROM employees e
                  WHERE e.company_id = $1 AND ${ACTIVE_EMPLOYEE}
                    AND ${inBranch}
                    AND e.joining_date > $2::date)                                      AS joining_later,

                (SELECT COUNT(*)::int FROM employees e
                  WHERE e.company_id = $1 AND ${ACTIVE_EMPLOYEE}
                    AND ${inBranch}
                    AND e.is_remote_job = TRUE)                                         AS remote_employees,

                (SELECT COUNT(*)::int FROM branches b
                  WHERE b.company_id = $1 AND b.deleted_at IS NULL)                     AS branches,

                (SELECT COUNT(*)::int FROM departments d
                  WHERE d.company_id = $1 AND d.deleted_at IS NULL
                    AND ($3::uuid IS NULL OR d.branch_id = $3::uuid))                   AS departments,

                (SELECT COUNT(*)::int FROM leave_requests lr
                  WHERE lr.company_id = $1 AND lr.deleted_at IS NULL
                    AND lr.status = 'pending'
                    AND ($3::uuid IS NULL OR lr.branch_id = $3::uuid))                  AS pending_leave_requests`,
            [company_id, today, branch_id]
        );
        return result.rows[0];
    },

    // -----------------------------------------------------------------------
    // Today at a glance — one pass over today's attendance rows
    // -----------------------------------------------------------------------
    async getTodaySnapshot(company_id, today, branch_id = null) {
        const result = await db.query(
            `WITH emp AS (
                SELECT e.id
                FROM employees e
                WHERE e.company_id = $1 AND ${ACTIVE_EMPLOYEE}
                  AND ($3::uuid IS NULL OR e.branch_id = $3::uuid)
             ),
             today_att AS (
                SELECT a.status, a.attendance_status, a.check_in, a.check_out, a.total_hours
                FROM attendance a
                JOIN emp ON emp.id = a.employee_id
                WHERE a.company_id = $1 AND a.attendance_date = $2::date
             )
             SELECT
                (SELECT COUNT(*)::int FROM emp)                                              AS total_employees,
                COUNT(*)::int                                                                AS marked_records,
                (COUNT(*) FILTER (WHERE t.check_in IS NOT NULL))::int                          AS checked_in,
                (COUNT(*) FILTER (WHERE t.check_out IS NOT NULL))::int                         AS checked_out,
                (COUNT(*) FILTER (WHERE t.check_in IS NOT NULL
                                   AND t.check_out IS NULL))::int                             AS currently_in,
                (COUNT(*) FILTER (WHERE t.status = 'leave'))::int                              AS on_leave,
                (COUNT(*) FILTER (WHERE t.status = 'holiday'))::int                            AS on_holiday,
                (COUNT(*) FILTER (WHERE t.status IN ('week-off', 'comp-off')))::int            AS week_off,
                (COUNT(*) FILTER (WHERE t.attendance_status = 'late'))::int                    AS late,
                (COUNT(*) FILTER (WHERE t.attendance_status IN ('on-time', 'before-time')))::int AS on_time,
                COALESCE(ROUND(AVG(t.total_hours) FILTER (WHERE t.total_hours IS NOT NULL), 2), 0) AS avg_hours
             FROM today_att t`,
            [company_id, today, branch_id]
        );
        return result.rows[0];
    },

    // -----------------------------------------------------------------------
    // Today's check-ins with locations (paginated; total comes free via
    // COUNT(*) OVER () instead of a second COUNT query)
    // -----------------------------------------------------------------------
    async getTodayCheckIns(company_id, today, {
        branch_id = null,
        department_id = null,
        attendance_status = null,
        only_open = false,          // still checked in (no check-out yet)
        limit = 50,
        offset = 0,
    } = {}) {
        const result = await db.query(
            `SELECT
                a.id                        AS attendance_id,
                a.employee_id,
                e.employee_code,
                e.first_name,
                e.last_name,
                e.is_remote_job,
                e.branch_id,
                b.branch_name,
                d.department_name,
                s.shift_name,
                s.start_time                AS shift_start_time,
                a.check_in,
                a.check_in_latitude,
                a.check_in_longitude,
                a.check_in_address,
                a.check_in_selfie_url,
                a.check_out,
                a.check_out_latitude,
                a.check_out_longitude,
                a.check_out_address,
                a.total_hours,
                a.attendance_status,
                a.status,
                (COUNT(*) OVER ())::int       AS total_count
             FROM attendance a
             JOIN employees e
               ON e.id = a.employee_id AND ${ACTIVE_EMPLOYEE}
             LEFT JOIN branches b    ON b.id = e.branch_id
             LEFT JOIN departments d ON d.id = e.department_id
             LEFT JOIN shifts s      ON s.id = e.shift_id
             WHERE a.company_id = $1
               AND a.attendance_date = $2::date
               AND a.check_in IS NOT NULL
               AND ($3::uuid IS NULL OR e.branch_id = $3::uuid)
               AND ($4::uuid IS NULL OR e.department_id = $4::uuid)
               AND ($5::text IS NULL OR a.attendance_status = $5::text)
               AND ($6::boolean IS NOT TRUE OR a.check_out IS NULL)
             ORDER BY a.check_in DESC
             LIMIT $7 OFFSET $8`,
            [company_id, today, branch_id, department_id, attendance_status, only_open, limit, offset]
        );
        return result.rows;
    },

    // -----------------------------------------------------------------------
    // Who has NOT checked in today and was expected to (absent list).
    // Expected = has an attendance row that is not a leave/holiday/week-off,
    // or has no row at all while their shift marks today as a working day.
    // -----------------------------------------------------------------------
    async getTodayMissing(company_id, today, { branch_id = null, limit = 50, offset = 0 } = {}) {
        const result = await db.query(
            `SELECT
                e.id                        AS employee_id,
                e.employee_code,
                e.first_name,
                e.last_name,
                e.phone,
                e.branch_id,
                b.branch_name,
                d.department_name,
                s.shift_name,
                s.start_time                AS shift_start_time,
                COALESCE(a.status, 'absent') AS status,
                (COUNT(*) OVER ())::int       AS total_count
             FROM employees e
             LEFT JOIN attendance a
               ON a.employee_id = e.id AND a.attendance_date = $2::date
             LEFT JOIN branches b    ON b.id = e.branch_id
             LEFT JOIN departments d ON d.id = e.department_id
             LEFT JOIN shifts s      ON s.id = e.shift_id
             WHERE e.company_id = $1
               AND ${ACTIVE_EMPLOYEE}
               AND (e.joining_date IS NULL OR e.joining_date <= $2::date)
               AND ($3::uuid IS NULL OR e.branch_id = $3::uuid)
               AND (a.check_in IS NULL)
               AND (a.status IS NULL OR a.status NOT IN ('leave', 'holiday', 'week-off', 'comp-off'))
               AND (
                    s.id IS NULL
                 OR CASE EXTRACT(DOW FROM $2::date)::int
                        WHEN 0 THEN s.sunday
                        WHEN 1 THEN s.monday
                        WHEN 2 THEN s.tuesday
                        WHEN 3 THEN s.wednesday
                        WHEN 4 THEN s.thursday
                        WHEN 5 THEN s.friday
                        WHEN 6 THEN s.saturday
                    END
               )
             ORDER BY b.branch_name NULLS LAST, e.first_name
             LIMIT $4 OFFSET $5`,
            [company_id, today, branch_id, limit, offset]
        );
        return result.rows;
    },

    // -----------------------------------------------------------------------
    // Branch-wise comparison over a date range (+ today's live numbers)
    // -----------------------------------------------------------------------
    async getBranchStats(company_id, { startDate, endDate, today }) {
        const result = await db.query(
            `WITH emp AS (
                SELECT e.id, e.branch_id
                FROM employees e
                WHERE e.company_id = $1 AND ${ACTIVE_EMPLOYEE}
             ),
             headcount AS (
                SELECT branch_id, COUNT(*)::int AS employee_count
                FROM emp GROUP BY branch_id
             ),
             range_att AS (
                SELECT
                    emp.branch_id,
                    (COUNT(*) FILTER (WHERE a.check_in IS NOT NULL))::int                   AS present_days,
                    (COUNT(*) FILTER (WHERE a.check_in IS NULL
                                       AND a.status = 'absent'))::int                      AS absent_days,
                    (COUNT(*) FILTER (WHERE a.status = 'leave'))::int                       AS leave_days,
                    (COUNT(*) FILTER (WHERE a.status IN ('week-off','comp-off','holiday')))::int AS off_days,
                    (COUNT(*) FILTER (WHERE a.attendance_status = 'late'))::int             AS late_days,
                    -- Today's open check-ins are people still at work, not
                    -- mistakes — only past days count as a missing check-out.
                    (COUNT(*) FILTER (WHERE a.check_in IS NOT NULL
                                       AND a.check_out IS NULL
                                       AND a.attendance_date < $4::date))::int             AS missing_checkouts,
                    COALESCE(SUM(a.total_hours), 0)                                       AS total_hours
                FROM attendance a
                JOIN emp ON emp.id = a.employee_id
                WHERE a.company_id = $1
                  AND a.attendance_date BETWEEN $2::date AND $3::date
                GROUP BY emp.branch_id
             ),
             today_att AS (
                SELECT
                    emp.branch_id,
                    (COUNT(*) FILTER (WHERE a.check_in IS NOT NULL))::int                   AS checked_in_today,
                    (COUNT(*) FILTER (WHERE a.check_in IS NOT NULL
                                       AND a.check_out IS NULL))::int                      AS currently_in,
                    (COUNT(*) FILTER (WHERE a.status = 'leave'))::int                       AS on_leave_today,
                    (COUNT(*) FILTER (WHERE a.attendance_status = 'late'))::int             AS late_today
                FROM attendance a
                JOIN emp ON emp.id = a.employee_id
                WHERE a.company_id = $1 AND a.attendance_date = $4::date
                GROUP BY emp.branch_id
             ),
             pending_leaves AS (
                SELECT lr.branch_id, COUNT(*)::int AS pending_leave_requests
                FROM leave_requests lr
                WHERE lr.company_id = $1 AND lr.deleted_at IS NULL AND lr.status = 'pending'
                GROUP BY lr.branch_id
             ),
             dept AS (
                SELECT branch_id, COUNT(*)::int AS department_count
                FROM departments
                WHERE company_id = $1 AND deleted_at IS NULL
                GROUP BY branch_id
             )
             SELECT
                b.id                AS branch_id,
                b.branch_name,
                b.branch_code,
                b.city,
                b.country,
                b.is_head_office,
                b.is_active,
                COALESCE(h.employee_count, 0)            AS employee_count,
                COALESCE(dp.department_count, 0)         AS department_count,
                COALESCE(t.checked_in_today, 0)          AS checked_in_today,
                COALESCE(t.currently_in, 0)              AS currently_in,
                COALESCE(t.on_leave_today, 0)            AS on_leave_today,
                COALESCE(t.late_today, 0)                AS late_today,
                COALESCE(r.present_days, 0)              AS present_days,
                COALESCE(r.absent_days, 0)               AS absent_days,
                COALESCE(r.leave_days, 0)                AS leave_days,
                COALESCE(r.off_days, 0)                  AS off_days,
                COALESCE(r.late_days, 0)                 AS late_days,
                COALESCE(r.missing_checkouts, 0)         AS missing_checkouts,
                COALESCE(r.total_hours, 0)               AS total_hours,
                COALESCE(pl.pending_leave_requests, 0)   AS pending_leave_requests
             FROM branches b
             LEFT JOIN headcount      h  ON h.branch_id  = b.id
             LEFT JOIN range_att      r  ON r.branch_id  = b.id
             LEFT JOIN today_att      t  ON t.branch_id  = b.id
             LEFT JOIN pending_leaves pl ON pl.branch_id = b.id
             LEFT JOIN dept           dp ON dp.branch_id = b.id
             WHERE b.company_id = $1 AND b.deleted_at IS NULL
             ORDER BY b.is_head_office DESC, b.branch_name`,
            [company_id, startDate, endDate, today]
        );
        return result.rows;
    },

    // -----------------------------------------------------------------------
    // Daily attendance trend (sparkline / bar chart source)
    // -----------------------------------------------------------------------
    async getAttendanceTrend(company_id, { startDate, endDate, branch_id = null }) {
        const result = await db.query(
            `SELECT
                TO_CHAR(a.attendance_date, 'YYYY-MM-DD')                            AS date,
                (COUNT(*) FILTER (WHERE a.check_in IS NOT NULL))::int                 AS present,
                (COUNT(*) FILTER (WHERE a.check_in IS NULL AND a.status = 'absent'))::int AS absent,
                (COUNT(*) FILTER (WHERE a.status = 'leave'))::int                     AS on_leave,
                (COUNT(*) FILTER (WHERE a.attendance_status = 'late'))::int           AS late
             FROM attendance a
             JOIN employees e ON e.id = a.employee_id AND ${ACTIVE_EMPLOYEE}
             WHERE a.company_id = $1
               AND a.attendance_date BETWEEN $2::date AND $3::date
               AND ($4::uuid IS NULL OR e.branch_id = $4::uuid)
             GROUP BY a.attendance_date
             ORDER BY a.attendance_date`,
            [company_id, startDate, endDate, branch_id]
        );
        return result.rows;
    },

    // -----------------------------------------------------------------------
    // Warnings — every bucket in ONE round trip.
    //
    // Each branch of the UNION carries its own COUNT(*) OVER () (the true
    // total for that bucket) and its own row_number, so the outer WHERE can
    // cap how many example rows travel over the wire without losing the count.
    //
    // When branch_id is set, every employee-level bucket narrows with the emp
    // CTE and the branch-level ones narrow to that branch. The last two
    // buckets stay company-wide on purpose: missing leave types and an empty
    // holiday calendar break the selected branch just as much as any other.
    // -----------------------------------------------------------------------
    async getWarningBuckets(company_id, today, {
        sample_limit = 5,
        expiry_window_days = 60,
        branch_id = null,
    } = {}) {
        const result = await db.query(
            `WITH emp AS (
                SELECT e.id, e.user_id, e.employee_code, e.first_name, e.last_name,
                       e.email, e.branch_id, e.department_id, e.shift_id,
                       e.joining_date, b.branch_name
                FROM employees e
                LEFT JOIN branches b ON b.id = e.branch_id AND b.deleted_at IS NULL
                WHERE e.company_id = $1 AND ${ACTIVE_EMPLOYEE}
                  AND ($5::uuid IS NULL OR e.branch_id = $5::uuid)
             ),
             active_salary AS (
                SELECT DISTINCT ON (employee_id) employee_id
                FROM employee_salary_structures
                WHERE company_id = $1
                  AND is_active = TRUE
                  AND effective_from <= $2::date
                  AND (effective_to IS NULL OR effective_to >= $2::date)
                ORDER BY employee_id, effective_from DESC
             ),

             -- No active salary structure → payroll cannot run for them
             b_salary AS (
                SELECT
                    'missing_salary_structure'::text AS bucket,
                    (COUNT(*) OVER ())::int      AS total,
                    ROW_NUMBER() OVER (ORDER BY e.joining_date NULLS LAST, e.first_name) AS rn,
                    JSONB_BUILD_OBJECT(
                        'employee_id',   e.id,
                        'employee_code', e.employee_code,
                        'name',          e.first_name || ' ' || e.last_name,
                        'branch_id',     e.branch_id,
                        'branch_name',   e.branch_name,
                        'joining_date',  e.joining_date
                    ) AS item
                FROM emp e
                LEFT JOIN active_salary s ON s.employee_id = e.id
                WHERE s.employee_id IS NULL
             ),

             -- No bank account → salary cannot be disbursed
             b_bank AS (
                SELECT
                    'missing_bank_account',
                    (COUNT(*) OVER ())::int,
                    ROW_NUMBER() OVER (ORDER BY e.first_name),
                    JSONB_BUILD_OBJECT(
                        'employee_id',   e.id,
                        'employee_code', e.employee_code,
                        'name',          e.first_name || ' ' || e.last_name,
                        'branch_id',     e.branch_id,
                        'branch_name',   e.branch_name
                    )
                FROM emp e
                WHERE NOT EXISTS (
                    SELECT 1 FROM employee_bank_accounts ba
                    WHERE ba.employee_id = e.id
                      AND ba.deleted_at IS NULL
                      AND ba.is_active = TRUE
                )
             ),

             -- No shift → attendance cannot judge late / week-off
             b_shift AS (
                SELECT
                    'missing_shift',
                    (COUNT(*) OVER ())::int,
                    ROW_NUMBER() OVER (ORDER BY e.first_name),
                    JSONB_BUILD_OBJECT(
                        'employee_id',   e.id,
                        'employee_code', e.employee_code,
                        'name',          e.first_name || ' ' || e.last_name,
                        'branch_id',     e.branch_id,
                        'branch_name',   e.branch_name
                    )
                FROM emp e
                WHERE e.shift_id IS NULL
             ),

             -- No branch → excluded from every branch-wise report
             b_branch AS (
                SELECT
                    'missing_branch',
                    (COUNT(*) OVER ())::int,
                    ROW_NUMBER() OVER (ORDER BY e.first_name),
                    JSONB_BUILD_OBJECT(
                        'employee_id',   e.id,
                        'employee_code', e.employee_code,
                        'name',          e.first_name || ' ' || e.last_name
                    )
                FROM emp e
                WHERE e.branch_id IS NULL
             ),

             -- Pending leave requests waiting on this admin
             b_leave AS (
                SELECT
                    'pending_leave_requests',
                    (COUNT(*) OVER ())::int,
                    ROW_NUMBER() OVER (ORDER BY lr.from_date, lr.created_at),
                    JSONB_BUILD_OBJECT(
                        'leave_request_id', lr.id,
                        'employee_id',      e.id,
                        'employee_code',    e.employee_code,
                        'name',             e.first_name || ' ' || e.last_name,
                        'branch_id',        e.branch_id,
                        'branch_name',      e.branch_name,
                        'leave_name',       lt.leave_name,
                        'from_date',        lr.from_date,
                        'to_date',          lr.to_date,
                        'total_days',       lr.total_days,
                        'requested_on',     lr.created_at,
                        'waiting_days',     ($2::date - lr.created_at::date),
                        'starts_in_days',   (lr.from_date - $2::date)
                    )
                FROM leave_requests lr
                JOIN emp e ON e.id = lr.employee_id
                LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
                WHERE lr.company_id = $1 AND lr.deleted_at IS NULL AND lr.status = 'pending'
             ),

             -- Identity documents expired or expiring soon (visa, EID, passport…)
             b_docs AS (
                SELECT
                    'expiring_documents',
                    (COUNT(*) OVER ())::int,
                    ROW_NUMBER() OVER (ORDER BY ed.expiry_date),
                    JSONB_BUILD_OBJECT(
                        'document_id',     ed.id,
                        'employee_id',     e.id,
                        'employee_code',   e.employee_code,
                        'name',            e.first_name || ' ' || e.last_name,
                        'branch_id',       e.branch_id,
                        'branch_name',     e.branch_name,
                        'document_type',   ed.document_type,
                        'expiry_date',     ed.expiry_date,
                        'days_to_expiry',  (ed.expiry_date - $2::date),
                        'is_expired',      (ed.expiry_date < $2::date)
                    )
                FROM employee_documents ed
                JOIN emp e ON e.id = ed.employee_id
                WHERE ed.deleted_at IS NULL
                  AND ed.is_active = TRUE
                  AND ed.expiry_date IS NOT NULL
                  AND ed.expiry_date <= $2::date + $4::int
             ),

             -- Invited but never signed in → they cannot mark attendance
             b_invite AS (
                SELECT
                    'pending_invites',
                    (COUNT(*) OVER ())::int,
                    ROW_NUMBER() OVER (ORDER BY uc.created_at),
                    JSONB_BUILD_OBJECT(
                        'employee_id',   e.id,
                        'employee_code', e.employee_code,
                        'name',          e.first_name || ' ' || e.last_name,
                        'email',         e.email,
                        'branch_id',     e.branch_id,
                        'branch_name',   e.branch_name,
                        'invited_on',    uc.created_at,
                        'waiting_days',  ($2::date - uc.created_at::date)
                    )
                FROM emp e
                JOIN user_companies uc
                  ON uc.user_id = e.user_id
                 AND uc.company_id = $1
                 AND uc.deleted_at IS NULL
                WHERE uc.invite_accepted_at IS NULL
                  AND (uc.is_invited = TRUE OR uc.password_hash IS NULL)
             ),

             -- No login account at all
             b_no_account AS (
                SELECT
                    'no_login_account',
                    (COUNT(*) OVER ())::int,
                    ROW_NUMBER() OVER (ORDER BY e.first_name),
                    JSONB_BUILD_OBJECT(
                        'employee_id',   e.id,
                        'employee_code', e.employee_code,
                        'name',          e.first_name || ' ' || e.last_name,
                        'branch_id',     e.branch_id,
                        'branch_name',   e.branch_name
                    )
                FROM emp e
                WHERE e.user_id IS NULL
             ),

             -- Checked in on a past day and never checked out (payroll hours
             -- for those days are wrong until someone fixes them)
             b_open_shift AS (
                SELECT
                    'missing_checkouts',
                    (COUNT(*) OVER ())::int,
                    ROW_NUMBER() OVER (ORDER BY a.attendance_date DESC),
                    JSONB_BUILD_OBJECT(
                        'attendance_id',   a.id,
                        'employee_id',     e.id,
                        'employee_code',   e.employee_code,
                        'name',            e.first_name || ' ' || e.last_name,
                        'branch_id',       e.branch_id,
                        'branch_name',     e.branch_name,
                        'attendance_date', a.attendance_date,
                        'check_in',        a.check_in
                    )
                FROM attendance a
                JOIN emp e ON e.id = a.employee_id
                WHERE a.company_id = $1
                  AND a.attendance_date <  $2::date
                  AND a.attendance_date >= $2::date - 30
                  AND a.check_in  IS NOT NULL
                  AND a.check_out IS NULL
             ),

             -- Locked out after too many failed logins
             b_locked AS (
                SELECT
                    'locked_accounts',
                    (COUNT(*) OVER ())::int,
                    ROW_NUMBER() OVER (ORDER BY uc.locked_at DESC),
                    JSONB_BUILD_OBJECT(
                        'employee_id',   e.id,
                        'employee_code', e.employee_code,
                        'name',          e.first_name || ' ' || e.last_name,
                        'branch_id',     e.branch_id,
                        'branch_name',   e.branch_name,
                        'locked_at',     uc.locked_at
                    )
                FROM emp e
                JOIN user_companies uc
                  ON uc.user_id = e.user_id
                 AND uc.company_id = $1
                 AND uc.deleted_at IS NULL
                WHERE uc.locked_at IS NOT NULL
             ),

             -- Branches without a geofence → check-in location cannot be validated
             b_geofence AS (
                SELECT
                    'branch_without_geofence',
                    (COUNT(*) OVER ())::int,
                    ROW_NUMBER() OVER (ORDER BY b.branch_name),
                    JSONB_BUILD_OBJECT(
                        'branch_id',   b.id,
                        'branch_name', b.branch_name,
                        'branch_code', b.branch_code,
                        'city',        b.city
                    )
                FROM branches b
                WHERE b.company_id = $1 AND b.deleted_at IS NULL
                  AND ($5::uuid IS NULL OR b.id = $5::uuid)
                  AND (b.latitude IS NULL OR b.longitude IS NULL)
             ),

             -- Branches with employees but no shift defined
             b_branch_no_shift AS (
                SELECT
                    'branch_without_shift',
                    (COUNT(*) OVER ())::int,
                    ROW_NUMBER() OVER (ORDER BY b.branch_name),
                    JSONB_BUILD_OBJECT(
                        'branch_id',   b.id,
                        'branch_name', b.branch_name,
                        'branch_code', b.branch_code
                    )
                FROM branches b
                WHERE b.company_id = $1 AND b.deleted_at IS NULL
                  AND ($5::uuid IS NULL OR b.id = $5::uuid)
                  AND NOT EXISTS (
                        SELECT 1 FROM shifts s
                        WHERE s.branch_id = b.id AND s.deleted_at IS NULL AND s.is_active = TRUE
                  )
             ),

             -- No leave types configured → nobody can apply for leave
             b_no_leave_type AS (
                SELECT
                    'no_leave_types_configured',
                    1::int,
                    1::bigint,
                    JSONB_BUILD_OBJECT('company_id', $1::uuid)
                WHERE NOT EXISTS (
                    SELECT 1 FROM leave_types lt
                    WHERE lt.company_id = $1 AND lt.deleted_at IS NULL AND lt.is_active = TRUE
                )
             ),

             -- No holidays recorded for the current year
             b_no_holidays AS (
                SELECT
                    'no_holidays_this_year',
                    1::int,
                    1::bigint,
                    JSONB_BUILD_OBJECT('year', EXTRACT(YEAR FROM $2::date)::int)
                WHERE NOT EXISTS (
                    SELECT 1 FROM holidays h
                    WHERE h.company_id = $1 AND h.deleted_at IS NULL AND h.is_active = TRUE
                      AND h.holiday_start_date >= DATE_TRUNC('year', $2::date)::date
                      AND h.holiday_start_date <  (DATE_TRUNC('year', $2::date) + INTERVAL '1 year')::date
                )
             )

             SELECT bucket, total, item
             FROM (
                SELECT * FROM b_salary
                UNION ALL SELECT * FROM b_bank
                UNION ALL SELECT * FROM b_shift
                UNION ALL SELECT * FROM b_branch
                UNION ALL SELECT * FROM b_leave
                UNION ALL SELECT * FROM b_docs
                UNION ALL SELECT * FROM b_invite
                UNION ALL SELECT * FROM b_no_account
                UNION ALL SELECT * FROM b_open_shift
                UNION ALL SELECT * FROM b_locked
                UNION ALL SELECT * FROM b_geofence
                UNION ALL SELECT * FROM b_branch_no_shift
                UNION ALL SELECT * FROM b_no_leave_type
                UNION ALL SELECT * FROM b_no_holidays
             ) z
             WHERE z.rn <= $3::int`,
            [company_id, today, sample_limit, expiry_window_days, branch_id]
        );
        return result.rows;
    },

    // -----------------------------------------------------------------------
    // Gratuity coverage.
    //
    // Which rule set applies to an employee is resolved in JS (config country
    // → salary work_country → company country, via the same helpers the
    // gratuity module uses), so this query only fetches the raw inputs.
    // -----------------------------------------------------------------------
    async getGratuityCoverage(company_id, today, branch_id = null) {
        const result = await db.query(
            `WITH active_salary AS (
                SELECT DISTINCT ON (employee_id) employee_id, work_country
                FROM employee_salary_structures
                WHERE company_id = $1
                  AND is_active = TRUE
                  AND effective_from <= $2::date
                  AND (effective_to IS NULL OR effective_to >= $2::date)
                ORDER BY employee_id, effective_from DESC
             )
             SELECT
                e.id                AS employee_id,
                e.employee_code,
                e.first_name,
                e.last_name,
                e.branch_id,
                b.branch_name,
                e.joining_date,
                c.country           AS company_country,
                s.work_country,
                g.id                AS config_id,
                g.is_enabled,
                g.rule_country
             FROM employees e
             JOIN companies c ON c.id = e.company_id
             LEFT JOIN branches b ON b.id = e.branch_id AND b.deleted_at IS NULL
             LEFT JOIN active_salary s ON s.employee_id = e.id
             LEFT JOIN employee_gratuity_configs g
                    ON g.employee_id = e.id AND g.deleted_at IS NULL
             WHERE e.company_id = $1 AND ${ACTIVE_EMPLOYEE}
               AND ($3::uuid IS NULL OR e.branch_id = $3::uuid)`,
            [company_id, today, branch_id]
        );
        return result.rows;
    },

    // -----------------------------------------------------------------------
    // Upcoming calendar — holidays, birthdays, work anniversaries and
    // approved leaves, in one query, already sorted by date.
    //
    // Birthdays/anniversaries project this year's (or next year's) occurrence;
    // 29 Feb is normalised to 28 Feb so make_date() never fails on a non-leap
    // year.
    // -----------------------------------------------------------------------
    async getUpcoming(company_id, today, days = 30, { branch_id = null } = {}) {
        const result = await db.query(
            `WITH horizon AS (
                SELECT $2::date AS d0, ($2::date + $3::int) AS d1
             ),
             emp AS (
                SELECT e.id, e.employee_code, e.first_name, e.last_name,
                       e.date_of_birth, e.joining_date, e.branch_id, b.branch_name
                FROM employees e
                LEFT JOIN branches b ON b.id = e.branch_id AND b.deleted_at IS NULL
                WHERE e.company_id = $1 AND ${ACTIVE_EMPLOYEE}
                  AND ($4::uuid IS NULL OR e.branch_id = $4::uuid)
             ),
             -- Next occurrence of a recurring day (birthday / joining date)
             recur AS (
                SELECT
                    e.*,
                    NEXT_OCCURRENCE(e.date_of_birth, h.d0) AS next_birthday,
                    NEXT_OCCURRENCE(e.joining_date,  h.d0) AS next_anniversary
                FROM emp e CROSS JOIN horizon h
             ),
             holidays_u AS (
                SELECT
                    'holiday'::text AS kind,
                    GREATEST(h.holiday_start_date, hz.d0) AS event_date,
                    JSONB_BUILD_OBJECT(
                        'holiday_id',   h.id,
                        'title',        h.holiday_name,
                        'holiday_type', h.holiday_type,
                        'start_date',   h.holiday_start_date,
                        'end_date',     h.holiday_end_date,
                        'is_company_wide', h.is_company_wide,
                        'branch_id',    h.branch_id,
                        'days_away',    (h.holiday_start_date - hz.d0)
                    ) AS item
                FROM holidays h CROSS JOIN horizon hz
                WHERE h.company_id = $1 AND h.deleted_at IS NULL AND h.is_active = TRUE
                  AND h.holiday_end_date   >= hz.d0
                  AND h.holiday_start_date <= hz.d1
                  AND ($4::uuid IS NULL OR h.is_company_wide = TRUE OR h.branch_id = $4::uuid)
             ),
             birthdays_u AS (
                SELECT
                    'birthday'::text,
                    r.next_birthday,
                    JSONB_BUILD_OBJECT(
                        'employee_id',   r.id,
                        'employee_code', r.employee_code,
                        'title',         r.first_name || ' ' || r.last_name,
                        'branch_id',     r.branch_id,
                        'branch_name',   r.branch_name,
                        'date',          r.next_birthday,
                        'turns',         EXTRACT(YEAR FROM AGE(r.next_birthday, r.date_of_birth))::int,
                        'days_away',     (r.next_birthday - $2::date)
                    )
                FROM recur r CROSS JOIN horizon hz
                WHERE r.next_birthday IS NOT NULL AND r.next_birthday BETWEEN hz.d0 AND hz.d1
             ),
             anniversaries_u AS (
                SELECT
                    'work_anniversary'::text,
                    r.next_anniversary,
                    JSONB_BUILD_OBJECT(
                        'employee_id',   r.id,
                        'employee_code', r.employee_code,
                        'title',         r.first_name || ' ' || r.last_name,
                        'branch_id',     r.branch_id,
                        'branch_name',   r.branch_name,
                        'date',          r.next_anniversary,
                        'years',         EXTRACT(YEAR FROM AGE(r.next_anniversary, r.joining_date))::int,
                        'days_away',     (r.next_anniversary - $2::date)
                    )
                FROM recur r CROSS JOIN horizon hz
                WHERE r.next_anniversary IS NOT NULL
                  AND r.next_anniversary BETWEEN hz.d0 AND hz.d1
                  AND r.joining_date < $2::date
             ),
             leaves_u AS (
                SELECT
                    'approved_leave'::text,
                    lr.from_date,
                    JSONB_BUILD_OBJECT(
                        'leave_request_id', lr.id,
                        'employee_id',      e.id,
                        'employee_code',    e.employee_code,
                        'title',            e.first_name || ' ' || e.last_name,
                        'branch_id',        e.branch_id,
                        'branch_name',      e.branch_name,
                        'leave_name',       lt.leave_name,
                        'from_date',        lr.from_date,
                        'to_date',          lr.to_date,
                        'total_days',       lr.total_days,
                        'days_away',        (lr.from_date - $2::date)
                    )
                FROM leave_requests lr
                JOIN emp e ON e.id = lr.employee_id
                LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
                CROSS JOIN horizon hz
                WHERE lr.company_id = $1 AND lr.deleted_at IS NULL
                  AND lr.status = 'approved'
                  AND lr.to_date   >= hz.d0
                  AND lr.from_date <= hz.d1
             )
             SELECT kind, TO_CHAR(event_date, 'YYYY-MM-DD') AS event_date, item
             FROM (
                SELECT * FROM holidays_u
                UNION ALL SELECT * FROM birthdays_u
                UNION ALL SELECT * FROM anniversaries_u
                UNION ALL SELECT * FROM leaves_u
             ) u
             ORDER BY event_date, kind`,
            [company_id, today, days, branch_id]
        );
        return result.rows;
    },
};

module.exports = Dashboard;
