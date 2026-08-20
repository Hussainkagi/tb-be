const db = require("../../config/database");

const { TaskPerformanceModel } = require("../../models/Task/taskPerformanceModel");
const { TaskModel } = require("../../models/Task/taskModel");
const { TaskStatusHistory } = require("../../models/Task/taskActivityModel");

const TaskAccessService = require("./taskAccessService");

const { TaskStatus } = require("../../enums/Task/taskStatus");
const {
    isOnTime,
    pointsFor,
    compositeScore,
    ROLLUP_BACKFILL_DAYS,
} = require("../../enums/Task/taskPerformance");
const { localDates, localDayBoundsUTC, zoneOf } = require("../../utils/Task/taskTime");

/**
 * Employee performance, built on tasks.
 *
 * Split in two halves:
 *
 *   WRITE — rollupCompanyDay(), called by the nightly job. Reads the raw
 *           transition log for one local day and writes one pre-aggregated
 *           row per employee.
 *
 *   READ  — the dashboard endpoints, which only ever touch
 *           task_performance_daily. No dashboard request scans tasks or
 *           task_status_history, which is what keeps the page fast for a
 *           company three years into using the module.
 */

// ─────────────────────────────────────────────────────────────────────────────
// WRITE
// ─────────────────────────────────────────────────────────────────────────────

/** An empty counter set for one employee-day. */
const emptyBucket = (employee_id, department_id) => ({
    employee_id,
    department_id,
    assigned_count: 0,
    completed_count: 0,
    completed_on_time: 0,
    completed_late: 0,
    reopened_count: 0,
    cancelled_count: 0,
    open_at_eod: 0,
    overdue_at_eod: 0,
    completion_hours: [],
    points_earned: 0,
});

const TaskPerformanceService = {
    /**
     * Roll up one company's local calendar day.
     *
     * Safe to run repeatedly for the same day — the upsert restates the row
     * rather than adding to it, so a catch-up pass, a redeploy or two workers
     * racing all converge on the same numbers.
     */
    async rollupCompanyDay(company_id, timezone, isoDate) {
        try {
            // The caller (the job) already knows the timezone; the admin-
            // triggered rebuild does not, so fall back to the company's own
            // rather than silently rolling up a UTC day for a Gulf company.
            let resolvedTimezone = timezone;
            if (!resolvedTimezone) {
                const company = await db.query(`SELECT timezone FROM companies WHERE id = $1`, [company_id]);
                resolvedTimezone = company.rows[0]?.timezone;
            }

            const zone = zoneOf(resolvedTimezone);
            const bounds = localDayBoundsUTC(isoDate, zone);
            if (!bounds) return { success: false, message: `Invalid date ${isoDate}` };

            const transitions = await TaskStatusHistory.findForRollup(
                company_id, bounds.start_utc, bounds.end_utc
            );
            const snapshot = await TaskModel.snapshotOpenCounts(company_id, bounds.end_utc);

            const buckets = new Map();
            const bucketFor = (employee_id, department_id) => {
                if (!employee_id) return null;
                if (!buckets.has(employee_id)) {
                    buckets.set(employee_id, emptyBucket(employee_id, department_id));
                }
                const bucket = buckets.get(employee_id);
                if (!bucket.department_id && department_id) bucket.department_id = department_id;
                return bucket;
            };

            for (const row of transitions) {
                // Credited to the person the task belongs to now. A task
                // reassigned mid-flight credits its current owner — attributing
                // half a task to someone who has moved on produces numbers
                // nobody can reconcile against the board they are looking at.
                const bucket = bucketFor(row.assigned_to_employee_id, row.department_id);
                if (!bucket) continue;

                if (row.from_status === null) {
                    bucket.assigned_count += 1;
                    continue;
                }

                switch (row.to_status) {
                    case TaskStatus.COMPLETED: {
                        // was_overdue is frozen on the history row; isOnTime is
                        // the fallback for rows written before it meant
                        // anything, and applies the grace period.
                        const onTime = row.was_overdue ? false : isOnTime(row.created_at, row.due_at);

                        bucket.completed_count += 1;
                        if (onTime) bucket.completed_on_time += 1;
                        else bucket.completed_late += 1;

                        bucket.points_earned += pointsFor(row.priority, onTime);

                        if (row.task_created_at) {
                            const hours =
                                (new Date(row.created_at).getTime() -
                                    new Date(row.task_created_at).getTime()) / 3600000;
                            if (hours >= 0) bucket.completion_hours.push(hours);
                        }
                        break;
                    }
                    case TaskStatus.REOPENED:
                        bucket.reopened_count += 1;
                        break;
                    case TaskStatus.CANCELLED:
                        bucket.cancelled_count += 1;
                        break;
                    default:
                        break;
                }
            }

            for (const row of snapshot) {
                const bucket = bucketFor(row.employee_id, row.department_id);
                if (!bucket) continue;
                bucket.open_at_eod = row.open_count;
                bucket.overdue_at_eod = row.overdue_count;
            }

            const written = [];
            for (const bucket of buckets.values()) {
                const { completion_hours, ...rest } = bucket;

                written.push(await TaskPerformanceModel.upsertDaily({
                    ...rest,
                    company_id,
                    stat_date: isoDate,
                    avg_completion_hours: completion_hours.length
                        ? Math.round(
                            (completion_hours.reduce((a, b) => a + b, 0) / completion_hours.length) * 100
                        ) / 100
                        : null,
                    points_earned: Math.round(bucket.points_earned * 100) / 100,
                }));
            }

            return { success: true, date: isoDate, employees: written.length };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * Every company that has tasks, with the timezone its days are measured in.
     * Companies with no tasks are skipped rather than written as empty rows.
     */
    async companiesToRollup() {
        const result = await db.query(
            `SELECT DISTINCT c.id, c.timezone
               FROM companies c
               JOIN tasks t ON t.company_id = c.id AND t.deleted_at IS NULL
              WHERE c.deleted_at IS NULL`
        );
        return result.rows;
    },

    /**
     * The job's entry point: roll up yesterday for every company, plus a
     * short backfill window.
     *
     * The backfill is not paranoia — a task completed at 23:58 local can be
     * followed by a reopen the next morning, and a worker that was down for a
     * day would otherwise leave a permanent hole in the chart.
     */
    async rollupAll({ backfillDays = ROLLUP_BACKFILL_DAYS } = {}) {
        const companies = await TaskPerformanceService.companiesToRollup();
        const results = [];

        for (const company of companies) {
            const { zone, previous } = localDates(company.timezone);

            for (let i = 0; i < Math.max(1, backfillDays); i += 1) {
                const date = new Date(`${previous}T00:00:00Z`);
                date.setUTCDate(date.getUTCDate() - i);
                const isoDate = date.toISOString().slice(0, 10);

                const result = await TaskPerformanceService.rollupCompanyDay(company.id, zone, isoDate);
                results.push({ company_id: company.id, ...result });
            }
        }

        return {
            success: true,
            companies: companies.length,
            days_written: results.filter((r) => r.success).length,
            failures: results.filter((r) => !r.success),
        };
    },

    // ─────────────────────────────────────────────────────────────────────
    // READ — the dashboard
    // ─────────────────────────────────────────────────────────────────────

    /**
     * Narrow the request to what this actor may see, and reject outright
     * anything they may not. An employee gets their own numbers and nobody
     * else's — a leaderboard is a management tool, not a public ranking.
     */
    async _scopeFor(user, company_id, requested_employee_id = null, cachedActor = null) {
        const resolved = await TaskAccessService.ensureActor(user, company_id, cachedActor);
        if (!resolved.success) return { success: false, message: resolved.message };
        const { actor } = resolved;

        if (actor.is_admin) {
            return { success: true, actor, filter: { employee_id: requested_employee_id || null } };
        }

        if (actor.is_hod) {
            return {
                success: true,
                actor,
                filter: {
                    department_ids: actor.headed_department_ids,
                    employee_id: requested_employee_id || null,
                },
            };
        }

        if (requested_employee_id && requested_employee_id !== actor.employee_id) {
            return {
                success: false,
                status: 403,
                message: "You can only view your own task performance.",
            };
        }

        return { success: true, actor, filter: { employee_id: actor.employee_id } };
    },

    /** Default window: the last 30 complete days. */
    _range({ from, to }, timezone) {
        const { today } = localDates(timezone);
        const end = to || today;

        if (from) return { from, to: end };

        const start = new Date(`${end}T00:00:00Z`);
        start.setUTCDate(start.getUTCDate() - 29);
        return { from: start.toISOString().slice(0, 10), to: end };
    },

    async getEmployeeReport({ company_id, user, employee_id = null, from, to, actor = null }) {
        try {
            const scoped = await TaskPerformanceService._scopeFor(user, company_id, employee_id, actor);
            if (!scoped.success) return scoped;

            const company = await db.query(`SELECT timezone FROM companies WHERE id = $1`, [company_id]);
            const range = TaskPerformanceService._range({ from, to }, company.rows[0]?.timezone);

            const rows = await TaskPerformanceModel.aggregateByEmployee(company_id, {
                ...range,
                ...scoped.filter,
            });

            const withScores = rows.map((row) => ({
                ...row,
                points: Number(row.points ?? 0),
                score: compositeScore({
                    assigned: row.assigned,
                    completed: row.completed,
                    on_time: row.on_time,
                    reopened: row.reopened,
                }),
                on_time_rate: row.completed ? Math.round((row.on_time / row.completed) * 1000) / 10 : null,
                completion_rate: row.assigned ? Math.round((row.completed / row.assigned) * 1000) / 10 : null,
            }));

            return {
                success: true,
                data: {
                    range,
                    scope: scoped.actor.scope,
                    employees: withScores,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Same numbers, ordered and trimmed — the "top performers" card. */
    async getLeaderboard({ company_id, user, from, to, limit = 10, actor = null }) {
        const report = await TaskPerformanceService.getEmployeeReport({ company_id, user, from, to, actor });
        if (!report.success) return report;

        const ranked = [...report.data.employees]
            // Nobody with nothing assigned belongs on a leaderboard — their
            // score is null, and null sorts unhelpfully.
            .filter((e) => e.assigned > 0)
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.points - a.points)
            .slice(0, Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50));

        return { success: true, data: { ...report.data, employees: ranked } };
    },

    async getTrend({ company_id, user, employee_id = null, from, to, actor = null }) {
        try {
            const scoped = await TaskPerformanceService._scopeFor(user, company_id, employee_id, actor);
            if (!scoped.success) return scoped;

            const company = await db.query(`SELECT timezone FROM companies WHERE id = $1`, [company_id]);
            const range = TaskPerformanceService._range({ from, to }, company.rows[0]?.timezone);

            const series = await TaskPerformanceModel.trend(company_id, { ...range, ...scoped.filter });

            return { success: true, data: { range, series } };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Department comparison — admin only; an HOD comparing departments is a politics feature. */
    async getDepartmentComparison({ company_id, user, from, to, actor = null }) {
        try {
            const resolved = await TaskAccessService.ensureActor(user, company_id, actor);
            if (!resolved.success) return { success: false, message: resolved.message };
            if (!resolved.actor.is_admin) {
                return { success: false, status: 403, message: "Admin access required." };
            }

            const company = await db.query(`SELECT timezone FROM companies WHERE id = $1`, [company_id]);
            const range = TaskPerformanceService._range({ from, to }, company.rows[0]?.timezone);

            const rows = await TaskPerformanceModel.aggregateByDepartment(company_id, range);

            return {
                success: true,
                data: {
                    range,
                    departments: rows.map((row) => ({
                        ...row,
                        points: Number(row.points ?? 0),
                        score: compositeScore({
                            assigned: row.assigned,
                            completed: row.completed,
                            on_time: row.on_time,
                            reopened: row.reopened,
                        }),
                    })),
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = TaskPerformanceService;
