const { scheduleJob } = require("../scheduler");

const { TaskModel } = require("../../models/Task/taskModel");
const { TaskWatcher } = require("../../models/Task/taskActivityModel");
const TaskNotificationService = require("../../service/Task/taskNotificationService");

const { REMINDER_LEAD_DAYS, TaskPriority } = require("../../enums/Task/taskPriority");
const {
    zoneOf,
    isDueInLocalDays,
    isOverdue,
    computeReminderAt,
} = require("../../utils/Task/taskTime");

// ─────────────────────────────────────────────────────────────────────────────
// TASK DEADLINE REMINDERS
//
// Two notifications come out of this job:
//   1. task_due_reminder → the assignee, the day before the deadline
//                          (two days as well, for urgent work)
//   2. task_overdue      → the assignee AND the task's watchers, once a day,
//                          while the deadline is behind them and the work is
//                          not finished
//
// Timezone handling
// -----------------
// "One day before the deadline" is not a subtraction. A deadline belongs to
// the place the work happens, so the job runs HOURLY and evaluates each task
// against the current date in its company's timezone — the same approach
// jobs/attendanceReminderJob.js and jobs/birthdayNotificationJob.js take.
// Notifications are scheduled for 09:00 local (utils/Task/taskTime.js)
// rather than sent the moment the cron fires, so nobody is woken at 3 AM by
// a deadline reminder.
//
// Idempotency
// -----------
// Running hourly means each task is evaluated ~24 times a day. Every
// reminder is tagged entity_type='tasks' + entity_id=<task id>, and
// uq_task_reminder_once_per_day (41_task_notifications.sql) makes a second
// insert for the same task/type/channel/day a unique violation, which
// NotificationService.send() reports as `skipped` rather than an error.
// Restarts, redeploys and multiple instances are therefore harmless.
//
// This is also why scheduled_at is always a real timestamp and never null:
// the index keys on scheduled_at::date, and NULL collides with nothing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How many days ahead this task should be warned about.
 *
 * Urgent work gets two warnings — two days out and one day out. A single
 * day's notice on something critical often arrives too late to change the
 * outcome, and the two land on different local dates, so the dedup index
 * treats them as the separate reminders they are.
 */
function reminderLeadsFor(priority) {
    const lead = REMINDER_LEAD_DAYS[priority] ?? 1;
    return lead > 1 ? [lead, 1] : [lead];
}

/**
 * The moment a reminder should be delivered.
 *
 * Normally 09:00 local, `leadDays` before the deadline. If that has already
 * passed — the task was created the evening before it is due, or the worker
 * was down — the reminder goes out now rather than being dropped: a late
 * warning still beats none, and the deadline is imminent by definition.
 */
function deliveryTimeFor(task, zone, leadDays) {
    const planned = computeReminderAt(task.due_at, zone, leadDays);
    if (!planned) return null;
    return planned.getTime() > Date.now() ? planned : new Date();
}

// ─────────────────────────────────────────────────────────────────────────────
// Core
// ─────────────────────────────────────────────────────────────────────────────
async function runTaskDeadlineJob() {
    console.log("[CRON] Task deadline job starting...");

    try {
        // The horizon covers the longest lead (2 days for urgent) plus the
        // overdue tail. Anything outside it cannot produce a notification on
        // this pass, and fetching it would only make the sweep heavier.
        const tasks = await TaskModel.findLiveWithDeadlines({ horizon_days: 3 });

        if (!tasks.length) {
            console.log("[CRON] Task deadline job — no live tasks with deadlines.");
            return { success: true, due_soon: 0, overdue: 0, skipped: 0 };
        }

        let dueSoon = 0;
        let overdue = 0;
        let skipped = 0;
        const failures = [];

        for (const task of tasks) {
            // The deadline's own zone wins when one was recorded — an admin in
            // head office can set a deadline in a branch's local time.
            const zone = zoneOf(task.due_timezone || task.company_timezone);

            try {
                // ── Overdue ────────────────────────────────────────────────
                if (isOverdue(task.due_at)) {
                    const watchers = await TaskWatcher.findEmployeeIds(task.id);

                    const result = await TaskNotificationService.notifyOverdue({
                        task,
                        // Now, not a local hour: the deadline has already been
                        // missed, and the dedup index still holds it to one
                        // notification per calendar day.
                        scheduled_at: new Date(),
                        timezone: zone,
                        notify_employee_ids: watchers,
                    });

                    if (result.success) overdue += 1;
                    else skipped += 1;
                    continue;
                }

                // ── Due soon ───────────────────────────────────────────────
                for (const leadDays of reminderLeadsFor(task.priority)) {
                    if (!isDueInLocalDays(task.due_at, zone, leadDays)) continue;

                    const scheduled_at = deliveryTimeFor(task, zone, leadDays);
                    if (!scheduled_at) continue;

                    const result = await TaskNotificationService.notifyDueSoon({
                        task,
                        scheduled_at,
                        timezone: zone,
                    });

                    if (result.success) dueSoon += 1;
                    else skipped += 1;
                }
            } catch (error) {
                failures.push({ task_id: task.id, message: error.message });
            }
        }

        console.log(
            `[CRON] Task deadline job — due-soon: ${dueSoon}, overdue: ${overdue}, ` +
            `already handled/skipped: ${skipped}, examined: ${tasks.length}`
        );

        if (failures.length) {
            console.warn(`[CRON] ${failures.length} task reminders failed:`);
            failures.forEach((f) => console.warn(`  → task_id: ${f.task_id} | ${f.message}`));
        }

        return { success: true, due_soon: dueSoon, overdue, skipped, failures };
    } catch (error) {
        console.error("[CRON] Task deadline job FAILED:", error.message, error.stack);
        return { success: false, message: error.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTER SCHEDULE
//
// Hourly at minute 10 — offset from the birthday job (minute 5) so the two
// sweeps do not contend for the pool on the same tick. Every company's local
// 09:00 falls inside some hour, so an hourly pass reaches every timezone.
// ─────────────────────────────────────────────────────────────────────────────
scheduleJob("task-deadline-sweep", "10 * * * *", runTaskDeadlineJob, { timezone: "UTC" });

module.exports = {
    runTaskDeadlineJob,
    reminderLeadsFor,
    deliveryTimeFor,
};
