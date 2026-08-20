const db = require("../../config/database");

/**
 * Everything that hangs off a task: its transition log, its remarks, and the
 * people who should hear about it.
 *
 * Grouped in one file the way notificationModel groups its five tables —
 * they are never used apart from each other.
 */

// ─────────────────────────────────────────────────────────────────────────────
// TaskStatusHistory — append-only. No update, no delete, by design: this is
// the table the performance rollup trusts.
// ─────────────────────────────────────────────────────────────────────────────
const TaskStatusHistory = {
    async create(data, client = db) {
        const {
            task_id,
            company_id,
            from_status = null,
            to_status,
            remark = null,
            changed_by_employee_id = null,
            changed_by_role = null,
            was_overdue = false,
        } = data;

        const result = await client.query(
            `INSERT INTO task_status_history (
                task_id, company_id, from_status, to_status, remark,
                changed_by_employee_id, changed_by_role, was_overdue
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [
                task_id, company_id, from_status, to_status, remark,
                changed_by_employee_id, changed_by_role, was_overdue,
            ]
        );
        return result.rows[0];
    },

    async findByTask(task_id) {
        const result = await db.query(
            `SELECT h.*,
                    e.first_name || ' ' || e.last_name AS changed_by_name,
                    e.employee_code                    AS changed_by_code
               FROM task_status_history h
               LEFT JOIN employees e ON e.id = h.changed_by_employee_id
              WHERE h.task_id = $1
              ORDER BY h.created_at ASC`,
            [task_id]
        );
        return result.rows;
    },

    /**
     * Transitions inside one UTC window, for the nightly rollup.
     *
     * Joined back to tasks for the fields the score needs (priority, due_at,
     * created_at) — the history row itself deliberately does not duplicate
     * them, except for was_overdue which is frozen at transition time.
     */
    async findForRollup(company_id, start_utc, end_utc) {
        const result = await db.query(
            `SELECT
                h.task_id,
                h.to_status,
                h.from_status,
                h.was_overdue,
                h.created_at,
                t.priority,
                t.due_at,
                t.created_at            AS task_created_at,
                t.assigned_to_employee_id,
                t.department_id
             FROM task_status_history h
             JOIN tasks t ON t.id = h.task_id
             WHERE h.company_id = $1
               AND h.created_at >= $2
               AND h.created_at <  $3
               AND t.deleted_at IS NULL
             ORDER BY h.created_at ASC`,
            [company_id, start_utc, end_utc]
        );
        return result.rows;
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// TaskComment — remarks that carry no state change
// ─────────────────────────────────────────────────────────────────────────────
const TaskComment = {
    async create(data, client = db) {
        const { task_id, company_id, employee_id, comment } = data;

        const result = await client.query(
            `INSERT INTO task_comments (task_id, company_id, employee_id, comment)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [task_id, company_id, employee_id, comment]
        );
        return result.rows[0];
    },

    async findByTask(task_id) {
        const result = await db.query(
            `SELECT c.*,
                    e.first_name || ' ' || e.last_name AS employee_name,
                    e.employee_code                    AS employee_code
               FROM task_comments c
               LEFT JOIN employees e ON e.id = c.employee_id
              WHERE c.task_id = $1 AND c.deleted_at IS NULL
              ORDER BY c.created_at ASC`,
            [task_id]
        );
        return result.rows;
    },

    async findById(id) {
        const result = await db.query(
            `SELECT * FROM task_comments WHERE id = $1 AND deleted_at IS NULL`,
            [id]
        );
        return result.rows[0] || null;
    },

    async softDelete(id) {
        const result = await db.query(
            `UPDATE task_comments
                SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
              WHERE id = $1 AND deleted_at IS NULL
              RETURNING *`,
            [id]
        );
        return result.rows[0] || null;
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// TaskWatcher — the assigner and the assignee's HOD, resolved once at
// creation so a status change does not have to re-derive the reporting line
// on every update.
// ─────────────────────────────────────────────────────────────────────────────
const TaskWatcher = {
    async addMany(task_id, employee_ids = [], client = db) {
        const unique = [...new Set(employee_ids.filter(Boolean))];
        if (!unique.length) return [];

        const values = [task_id];
        const placeholders = unique.map((id) => {
            values.push(id);
            return `($1, $${values.length})`;
        });

        const result = await client.query(
            `INSERT INTO task_watchers (task_id, employee_id)
             VALUES ${placeholders.join(", ")}
             ON CONFLICT (task_id, employee_id) DO NOTHING
             RETURNING *`,
            values
        );
        return result.rows;
    },

    async remove(task_id, employee_id) {
        const result = await db.query(
            `DELETE FROM task_watchers WHERE task_id = $1 AND employee_id = $2 RETURNING *`,
            [task_id, employee_id]
        );
        return result.rows[0] || null;
    },

    async findEmployeeIds(task_id) {
        const result = await db.query(
            `SELECT w.employee_id
               FROM task_watchers w
               JOIN employees e ON e.id = w.employee_id
              WHERE w.task_id = $1
                AND e.deleted_at IS NULL
                AND e.is_active = TRUE`,
            [task_id]
        );
        return result.rows.map((r) => r.employee_id);
    },
};

module.exports = { TaskStatusHistory, TaskComment, TaskWatcher };
