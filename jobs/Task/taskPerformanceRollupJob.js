const { scheduleJob } = require("../scheduler");

const TaskPerformanceService = require("../../service/Task/taskPerformanceService");
const { ROLLUP_BACKFILL_DAYS } = require("../../enums/Task/taskPerformance");

// ─────────────────────────────────────────────────────────────────────────────
// TASK PERFORMANCE ROLLUP
//
// Turns the raw transition log into task_performance_daily — one
// pre-aggregated row per employee per local day. The dashboard reads only
// that table, which is what keeps it fast for a company with years of tasks
// behind it (see the header of 42_task_performance.sql).
//
// Why hourly for a "nightly" rollup
// ---------------------------------
// There is no single midnight. The job runs every hour and, for each company,
// rolls up the day that has just finished WHERE THAT COMPANY IS. A company in
// Asia/Dubai closes its books eight hours before one in America/New_York.
//
// Re-running is free: TaskPerformanceModel.upsertDaily restates a day rather
// than adding to it, so the repeated hourly passes over the same local day
// converge on identical numbers.
//
// The backfill window (ROLLUP_BACKFILL_DAYS) covers the ragged edges — a task
// completed at 23:58 and reopened the next morning, or a worker that was down
// for a day and would otherwise leave a permanent hole in the chart.
// ─────────────────────────────────────────────────────────────────────────────

async function runTaskPerformanceRollupJob() {
    console.log("[CRON] Task performance rollup starting...");

    try {
        const result = await TaskPerformanceService.rollupAll({
            backfillDays: ROLLUP_BACKFILL_DAYS,
        });

        console.log(
            `[CRON] Task performance rollup — companies: ${result.companies}, ` +
            `employee-days written: ${result.days_written}`
        );

        if (result.failures?.length) {
            console.warn(`[CRON] ${result.failures.length} rollup days failed:`);
            result.failures.forEach((f) =>
                console.warn(`  → company_id: ${f.company_id} | ${f.message}`)
            );
        }

        return result;
    } catch (error) {
        console.error("[CRON] Task performance rollup FAILED:", error.message, error.stack);
        return { success: false, message: error.message };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTER SCHEDULE
//
// Hourly at minute 20 — after the deadline sweep (minute 10), and offset from
// the other jobs so the three never start on the same tick.
// ─────────────────────────────────────────────────────────────────────────────
scheduleJob("task-performance-rollup", "20 * * * *", runTaskPerformanceRollupJob, { timezone: "UTC" });

module.exports = { runTaskPerformanceRollupJob };
