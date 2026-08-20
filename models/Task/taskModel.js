const db = require("../../config/database");

/**
 * Tasks — the work item itself.
 *
 * Every SELECT in here is company-scoped and excludes soft-deleted rows. The
 * module never reads tasks by id alone: `findById` takes the company too, so
 * a leaked uuid from one tenant cannot be opened by another.
 */

// The read shape shared by findById and list. Names are resolved here rather
// than by the app so a task list is one query instead of N.
const TASK_SELECT = `
    SELECT
        t.*,
        c.name                                          AS category_name,
        c.color_hex                                     AS category_color,
        d.department_name                               AS department_name,
        co.timezone                                     AS company_timezone,
        ae.first_name || ' ' || ae.last_name            AS assigned_to_name,
        ae.employee_code                                AS assigned_to_code,
        ae.email                                        AS assigned_to_email,
        be.first_name || ' ' || be.last_name            AS assigned_by_name,
        be.employee_code                                AS assigned_by_code,
        (t.due_at IS NOT NULL
         AND t.due_at < NOW()
         AND t.status NOT IN ('completed', 'cancelled')) AS is_overdue,
        (SELECT COUNT(*) FROM task_comments tc
          WHERE tc.task_id = t.id AND tc.deleted_at IS NULL)::int AS comment_count
    FROM tasks t
    LEFT JOIN task_categories c ON c.id  = t.category_id
    LEFT JOIN departments     d ON d.id  = t.department_id
    LEFT JOIN companies      co ON co.id = t.company_id
    LEFT JOIN employees      ae ON ae.id = t.assigned_to_employee_id
    LEFT JOIN employees      be ON be.id = t.assigned_by_employee_id
`;

// Columns an admin/HOD is allowed to edit after creation. Everything else —
// status, the lifecycle stamps, company_id — moves only through the status
// machine in taskService, never through a generic update.
const UPDATABLE_FIELDS = [
    "title",
    "description",
    "category_id",
    "priority",
    "due_at",
    "due_timezone",
    "branch_id",
    "assigned_to_employee_id",
    "department_id",
];

const TaskModel = {
    // --------------------------------------------------------
    // CREATE
    // --------------------------------------------------------

    async create(data, client = db) {
        const {
            company_id,
            branch_id = null,
            category_id = null,
            department_id = null,
            assigned_to_employee_id,
            assigned_by_employee_id = null,
            title,
            description = null,
            priority,
            status,
            due_at = null,
            due_timezone = null,
            created_by_user_id = null,
        } = data;

        const result = await client.query(
            `INSERT INTO tasks (
                company_id, branch_id, category_id, department_id,
                assigned_to_employee_id, assigned_by_employee_id,
                title, description, priority, status,
                due_at, due_timezone, created_by_user_id
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            RETURNING *`,
            [
                company_id, branch_id, category_id, department_id,
                assigned_to_employee_id, assigned_by_employee_id,
                title, description, priority, status,
                due_at, due_timezone, created_by_user_id,
            ]
        );
        return result.rows[0];
    },

    // --------------------------------------------------------
    // READ
    // --------------------------------------------------------

    /** Company-scoped by design — see the note at the top of this file. */
    async findById(id, company_id) {
        const result = await db.query(
            `${TASK_SELECT} WHERE t.id = $1 AND t.company_id = $2 AND t.deleted_at IS NULL`,
            [id, company_id]
        );
        return result.rows[0] || null;
    },

    /** The bare row, without the joins — for internal checks and updates. */
    async findRawById(id, client = db) {
        const result = await client.query(
            `SELECT * FROM tasks WHERE id = $1 AND deleted_at IS NULL`,
            [id]
        );
        return result.rows[0] || null;
    },

    /**
     * The list endpoint.
     *
     * `scope` is the access decision already made by taskAccessService and
     * handed down as data: an admin passes nothing, an HOD passes the
     * departments they head, an employee passes their own employee id. The
     * model does not decide who may see what — it only applies what it is told.
     */
    async list(company_id, filters = {}) {
        const {
            status,
            priority,
            category_id,
            assigned_to_employee_id,
            assigned_by_employee_id,
            department_id,
            branch_id,
            search,
            due_from,
            due_to,
            overdue_only = false,
            include_completed = true,
            scope = {},
            sort_by = "created_at",
            sort_dir = "desc",
            page = 1,
            limit = 20,
        } = filters;

        const where = ["t.company_id = $1", "t.deleted_at IS NULL"];
        const values = [company_id];

        const add = (sql, value) => {
            values.push(value);
            where.push(sql.replace("$?", `$${values.length}`));
        };

        // ── Access scope ────────────────────────────────────────────────
        if (scope.employee_id) {
            // Employees see what is theirs — assigned to them, or raised by them.
            values.push(scope.employee_id);
            const p = `$${values.length}`;
            where.push(`(t.assigned_to_employee_id = ${p} OR t.assigned_by_employee_id = ${p})`);
        } else if (Array.isArray(scope.department_ids) && scope.department_ids.length) {
            // HODs see their departments, plus anything they raised themselves
            // (an HOD can be handed a task by the admin like anyone else).
            values.push(scope.department_ids);
            const deptParam = `$${values.length}`;
            if (scope.self_employee_id) {
                values.push(scope.self_employee_id);
                const selfParam = `$${values.length}`;
                where.push(
                    `(t.department_id = ANY(${deptParam})
                      OR t.assigned_to_employee_id = ${selfParam}
                      OR t.assigned_by_employee_id = ${selfParam})`
                );
            } else {
                where.push(`t.department_id = ANY(${deptParam})`);
            }
        }

        // ── Filters ─────────────────────────────────────────────────────
        if (status) add("t.status = ANY($?)", Array.isArray(status) ? status : [status]);
        if (priority) add("t.priority = ANY($?)", Array.isArray(priority) ? priority : [priority]);
        if (category_id) add("t.category_id = $?", category_id);
        if (assigned_to_employee_id) add("t.assigned_to_employee_id = $?", assigned_to_employee_id);
        if (assigned_by_employee_id) add("t.assigned_by_employee_id = $?", assigned_by_employee_id);
        if (department_id) add("t.department_id = $?", department_id);
        if (branch_id) add("t.branch_id = $?", branch_id);
        if (due_from) add("t.due_at >= $?", due_from);
        if (due_to) add("t.due_at <= $?", due_to);
        if (search) {
            // One value, two placeholders — `add` only rewrites the first.
            values.push(`%${search}%`);
            const p = `$${values.length}`;
            where.push(`(t.title ILIKE ${p} OR t.description ILIKE ${p})`);
        }

        if (!include_completed) {
            where.push(`t.status NOT IN ('completed', 'cancelled')`);
        }
        if (overdue_only) {
            where.push(`t.due_at IS NOT NULL AND t.due_at < NOW()`);
            where.push(`t.status NOT IN ('completed', 'cancelled')`);
        }

        const whereSql = where.join(" AND ");

        // Whitelisted — these two land in the SQL text, so they can never come
        // straight from the query string.
        const SORTABLE = {
            created_at: "t.created_at",
            due_at: "t.due_at",
            priority: "CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END",
            status: "t.status",
            updated_at: "t.updated_at",
        };
        const orderCol = SORTABLE[sort_by] || SORTABLE.created_at;
        const orderDir = String(sort_dir).toLowerCase() === "asc" ? "ASC" : "DESC";

        const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
        const safePage = Math.max(parseInt(page, 10) || 1, 1);
        const offset = (safePage - 1) * safeLimit;

        values.push(safeLimit, offset);

        const rows = await db.query(
            `${TASK_SELECT}
             WHERE ${whereSql}
             ORDER BY ${orderCol} ${orderDir} NULLS LAST, t.created_at DESC
             LIMIT $${values.length - 1} OFFSET $${values.length}`,
            values
        );

        const total = await db.query(
            `SELECT COUNT(*)::int AS count FROM tasks t WHERE ${whereSql}`,
            values.slice(0, values.length - 2)
        );

        return {
            tasks: rows.rows,
            total: total.rows[0].count,
            page: safePage,
            limit: safeLimit,
        };
    },

    /** Status counters for a scope — powers the board header and the summary card. */
    async countsByStatus(company_id, scope = {}) {
        const values = [company_id];
        const where = ["t.company_id = $1", "t.deleted_at IS NULL"];

        // Same scope shape as list() — an HOD's counters have to agree with
        // the board they sit above, including the tasks they were handed
        // themselves outside the department they head.
        if (scope.employee_id) {
            values.push(scope.employee_id);
            where.push(`t.assigned_to_employee_id = $${values.length}`);
        } else if (Array.isArray(scope.department_ids) && scope.department_ids.length) {
            values.push(scope.department_ids);
            const deptParam = `$${values.length}`;

            if (scope.self_employee_id) {
                values.push(scope.self_employee_id);
                const selfParam = `$${values.length}`;
                where.push(
                    `(t.department_id = ANY(${deptParam})
                      OR t.assigned_to_employee_id = ${selfParam}
                      OR t.assigned_by_employee_id = ${selfParam})`
                );
            } else {
                where.push(`t.department_id = ANY(${deptParam})`);
            }
        }

        const result = await db.query(
            `SELECT
                t.status,
                COUNT(*)::int AS count,
                COUNT(*) FILTER (
                    WHERE t.due_at IS NOT NULL
                      AND t.due_at < NOW()
                      AND t.status NOT IN ('completed', 'cancelled')
                )::int AS overdue_count
             FROM tasks t
             WHERE ${where.join(" AND ")}
             GROUP BY t.status`,
            values
        );
        return result.rows;
    },

    // --------------------------------------------------------
    // UPDATE
    // --------------------------------------------------------

    async update(id, data, client = db) {
        const sets = [];
        const values = [];

        for (const field of UPDATABLE_FIELDS) {
            if (data[field] !== undefined) {
                values.push(data[field]);
                sets.push(`${field} = $${values.length}`);
            }
        }

        if (!sets.length) return TaskModel.findRawById(id, client);

        values.push(id);
        const result = await client.query(
            `UPDATE tasks
                SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP
              WHERE id = $${values.length} AND deleted_at IS NULL
              RETURNING *`,
            values
        );
        return result.rows[0] || null;
    },

    /**
     * Move a task to a new status and stamp the matching lifecycle column.
     *
     * The stamps are set here, never by the caller — that is what keeps
     * completed_at honest for the performance rollup. started_at uses COALESCE
     * so a task that goes in_progress → open → in_progress keeps the first
     * time work actually began.
     */
    async applyStatus(id, status, client = db) {
        const STAMP = {
            in_progress: "started_at   = COALESCE(started_at, CURRENT_TIMESTAMP)",
            submitted:   "submitted_at = CURRENT_TIMESTAMP",
            completed:   "completed_at = CURRENT_TIMESTAMP",
            cancelled:   "cancelled_at = CURRENT_TIMESTAMP",
            // Reopening clears the completion stamp: the task is not done, and
            // a stale completed_at would have the rollup counting it twice.
            reopened:    "completed_at = NULL",
            open:        null,
        };

        const stamp = STAMP[status];

        const result = await client.query(
            `UPDATE tasks
                SET status = $1,
                    ${stamp ? `${stamp},` : ""}
                    updated_at = CURRENT_TIMESTAMP
              WHERE id = $2 AND deleted_at IS NULL
              RETURNING *`,
            [status, id]
        );
        return result.rows[0] || null;
    },

    // --------------------------------------------------------
    // DELETE — soft
    // --------------------------------------------------------

    async softDelete(id, client = db) {
        const result = await client.query(
            `UPDATE tasks
                SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
              WHERE id = $1 AND deleted_at IS NULL
              RETURNING *`,
            [id]
        );
        return result.rows[0] || null;
    },

    // --------------------------------------------------------
    // JOBS
    // --------------------------------------------------------

    /**
     * End-of-day snapshot: how much live work each employee is sitting on,
     * and how much of it is already past its deadline.
     *
     * `as_of` is the end of the local day being rolled up, so a day computed
     * late (a catch-up pass, a restarted worker) reports what was true then
     * rather than what is true now. Tasks created after the window are
     * excluded for the same reason.
     */
    async snapshotOpenCounts(company_id, as_of) {
        const result = await db.query(
            `SELECT
                t.assigned_to_employee_id                       AS employee_id,
                MAX(t.department_id::text)::uuid                AS department_id,
                COUNT(*)::int                                   AS open_count,
                COUNT(*) FILTER (WHERE t.due_at IS NOT NULL AND t.due_at < $2)::int AS overdue_count
             FROM tasks t
             WHERE t.company_id = $1
               AND t.deleted_at IS NULL
               AND t.created_at <= $2
               AND t.status IN ('open', 'in_progress', 'submitted', 'reopened')
             GROUP BY t.assigned_to_employee_id`,
            [company_id, as_of]
        );
        return result.rows;
    },

    /**
     * Every live task that carries a deadline, with the company timezone the
     * deadline has to be judged in.
     *
     * The job filters by local date in JS rather than in SQL: "due tomorrow"
     * is a different instant for every company, and expressing that as a
     * WHERE clause means a per-timezone AT TIME ZONE expression that cannot
     * use the index. The partial index (idx_tasks_due_at_live) already cuts
     * this to live, dated tasks, and the horizon below keeps it bounded.
     */
    async findLiveWithDeadlines({ horizon_days = 3 } = {}) {
        const result = await db.query(
            `SELECT
                t.id, t.company_id, t.title, t.priority, t.status,
                t.due_at, t.due_timezone, t.assigned_to_employee_id,
                t.department_id,
                co.timezone                          AS company_timezone,
                c.name                               AS category_name,
                ae.first_name || ' ' || ae.last_name AS assigned_to_name
             FROM tasks t
             JOIN companies       co ON co.id = t.company_id
             LEFT JOIN task_categories c ON c.id = t.category_id
             LEFT JOIN employees  ae ON ae.id = t.assigned_to_employee_id
             WHERE t.deleted_at IS NULL
               AND t.due_at IS NOT NULL
               AND t.status IN ('open', 'in_progress', 'submitted', 'reopened')
               AND co.deleted_at IS NULL
               AND ae.deleted_at IS NULL
               AND ae.is_active = TRUE
               AND t.due_at BETWEEN NOW() - INTERVAL '2 days'
                               AND NOW() + INTERVAL '1 day' * $1`,
            [horizon_days]
        );
        return result.rows;
    },
};

module.exports = { TaskModel, UPDATABLE_FIELDS };
