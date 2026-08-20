const db = require("../../config/database");

/**
 * The read side: task_performance_daily.
 *
 * Written only by jobs/Task/taskPerformanceRollupJob.js, read only by the
 * dashboard. Nothing in the request path writes here — that separation is
 * what lets the dashboard stay fast no matter how many tasks a company runs.
 */

const TaskPerformanceModel = {
    /**
     * Upsert one employee-day. Re-running the rollup for a day must restate
     * it, not add to it — hence the explicit SET rather than an increment.
     */
    async upsertDaily(row, client = db) {
        const {
            company_id,
            employee_id,
            stat_date,
            department_id = null,
            assigned_count = 0,
            completed_count = 0,
            completed_on_time = 0,
            completed_late = 0,
            reopened_count = 0,
            cancelled_count = 0,
            open_at_eod = 0,
            overdue_at_eod = 0,
            avg_completion_hours = null,
            points_earned = 0,
        } = row;

        const result = await client.query(
            `INSERT INTO task_performance_daily (
                company_id, employee_id, stat_date, department_id,
                assigned_count, completed_count, completed_on_time, completed_late,
                reopened_count, cancelled_count, open_at_eod, overdue_at_eod,
                avg_completion_hours, points_earned, computed_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, CURRENT_TIMESTAMP)
            ON CONFLICT (company_id, employee_id, stat_date) DO UPDATE SET
                department_id        = EXCLUDED.department_id,
                assigned_count       = EXCLUDED.assigned_count,
                completed_count      = EXCLUDED.completed_count,
                completed_on_time    = EXCLUDED.completed_on_time,
                completed_late       = EXCLUDED.completed_late,
                reopened_count       = EXCLUDED.reopened_count,
                cancelled_count      = EXCLUDED.cancelled_count,
                open_at_eod          = EXCLUDED.open_at_eod,
                overdue_at_eod       = EXCLUDED.overdue_at_eod,
                avg_completion_hours = EXCLUDED.avg_completion_hours,
                points_earned        = EXCLUDED.points_earned,
                computed_at          = CURRENT_TIMESTAMP
            RETURNING *`,
            [
                company_id, employee_id, stat_date, department_id,
                assigned_count, completed_count, completed_on_time, completed_late,
                reopened_count, cancelled_count, open_at_eod, overdue_at_eod,
                avg_completion_hours, points_earned,
            ]
        );
        return result.rows[0];
    },

    /**
     * Per-employee totals across a date range — the leaderboard, and the
     * per-person card when employee_id is supplied.
     */
    async aggregateByEmployee(company_id, { from, to, department_ids = null, employee_id = null } = {}) {
        const values = [company_id, from, to];
        const where = ["p.company_id = $1", "p.stat_date >= $2", "p.stat_date <= $3"];

        if (Array.isArray(department_ids) && department_ids.length) {
            values.push(department_ids);
            where.push(`p.department_id = ANY($${values.length})`);
        }
        if (employee_id) {
            values.push(employee_id);
            where.push(`p.employee_id = $${values.length}`);
        }

        const result = await db.query(
            `SELECT
                p.employee_id,
                MAX(p.department_id::text)::uuid          AS department_id,
                e.first_name || ' ' || e.last_name        AS employee_name,
                e.employee_code,
                d.department_name,
                SUM(p.assigned_count)::int                AS assigned,
                SUM(p.completed_count)::int               AS completed,
                SUM(p.completed_on_time)::int             AS on_time,
                SUM(p.completed_late)::int                AS late,
                SUM(p.reopened_count)::int                AS reopened,
                SUM(p.cancelled_count)::int               AS cancelled,
                SUM(p.points_earned)                      AS points,
                -- Average of averages would weight a day with one task the
                -- same as a day with twenty, so weight by the completions
                -- each daily average was computed from.
                CASE WHEN SUM(p.completed_count) > 0
                     THEN ROUND(
                        SUM(COALESCE(p.avg_completion_hours, 0) * p.completed_count)
                        / SUM(p.completed_count), 2)
                END                                       AS avg_completion_hours
             FROM task_performance_daily p
             JOIN employees e ON e.id = p.employee_id
             LEFT JOIN departments d ON d.id = p.department_id
             WHERE ${where.join(" AND ")}
               AND e.deleted_at IS NULL
             GROUP BY p.employee_id, e.first_name, e.last_name, e.employee_code, d.department_name
             ORDER BY points DESC NULLS LAST, completed DESC`,
            values
        );
        return result.rows;
    },

    /** Day-by-day series for a trend chart. */
    async trend(company_id, { from, to, employee_id = null, department_ids = null } = {}) {
        const values = [company_id, from, to];
        const where = ["p.company_id = $1", "p.stat_date >= $2", "p.stat_date <= $3"];

        if (employee_id) {
            values.push(employee_id);
            where.push(`p.employee_id = $${values.length}`);
        }
        if (Array.isArray(department_ids) && department_ids.length) {
            values.push(department_ids);
            where.push(`p.department_id = ANY($${values.length})`);
        }

        const result = await db.query(
            `SELECT
                p.stat_date,
                SUM(p.assigned_count)::int    AS assigned,
                SUM(p.completed_count)::int   AS completed,
                SUM(p.completed_on_time)::int AS on_time,
                SUM(p.completed_late)::int    AS late,
                SUM(p.points_earned)          AS points
             FROM task_performance_daily p
             WHERE ${where.join(" AND ")}
             GROUP BY p.stat_date
             ORDER BY p.stat_date ASC`,
            values
        );
        return result.rows;
    },

    /** Department comparison for the admin view. */
    async aggregateByDepartment(company_id, { from, to } = {}) {
        const result = await db.query(
            `SELECT
                p.department_id,
                d.department_name,
                COUNT(DISTINCT p.employee_id)::int AS employee_count,
                SUM(p.assigned_count)::int         AS assigned,
                SUM(p.completed_count)::int        AS completed,
                SUM(p.completed_on_time)::int      AS on_time,
                SUM(p.completed_late)::int         AS late,
                SUM(p.reopened_count)::int         AS reopened,
                SUM(p.points_earned)               AS points
             FROM task_performance_daily p
             LEFT JOIN departments d ON d.id = p.department_id
             WHERE p.company_id = $1 AND p.stat_date >= $2 AND p.stat_date <= $3
             GROUP BY p.department_id, d.department_name
             ORDER BY points DESC NULLS LAST`,
            [company_id, from, to]
        );
        return result.rows;
    },

    /** The most recent day already rolled up — the job's resume point. */
    async lastComputedDate(company_id) {
        const result = await db.query(
            `SELECT MAX(stat_date) AS last_date FROM task_performance_daily WHERE company_id = $1`,
            [company_id]
        );
        return result.rows[0]?.last_date || null;
    },
};

module.exports = { TaskPerformanceModel };
