const cron = require("node-cron");
const { DateTime } = require("luxon"); // npm install luxon
const db = require("../config/database");
const NotificationService = require("../service/notificationService");

// ─────────────────────────────────────────────────────────────────────────────
// Helper: map shift's boolean day columns → a given date's day name
// Shifts table uses: monday, tuesday, wednesday, thursday, friday, saturday, sunday
// ─────────────────────────────────────────────────────────────────────────────
const DAY_COLUMNS = [
    "sunday",    // luxon weekday 7 → index 0
    "monday",    // luxon weekday 1 → index 1
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",  // luxon weekday 6 → index 6
];

// dt = a Luxon DateTime already in the employee's timezone
function getDayColumnForDate(dt) {
    // luxon weekday: 1=Monday ... 7=Sunday
    const weekday = dt.weekday;
    // Convert to JS day index: Sunday=0, Monday=1 ... Saturday=6
    const jsDay = weekday === 7 ? 0 : weekday;
    return DAY_COLUMNS[jsDay]; // e.g. "monday"
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: compute UTC ISO timestamp for a reminder
// timeStr = "08:00:00" (shift start_time or end_time from DB)
// targetDate = Luxon DateTime for the calendar day the reminder is FOR
//              (already in the employee's timezone — see runAttendanceReminderJob)
// offsetMinutes = how many minutes BEFORE that time to send the reminder
// ─────────────────────────────────────────────────────────────────────────────
function computeReminderUTC(timeStr, targetDate, offsetMinutes = 15) {
    if (!timeStr || !targetDate) return null;

    try {
        const [hours, minutes, seconds = 0] = timeStr.split(":").map(Number);

        const reminderLocal = targetDate
            .set({ hour: hours, minute: minutes, second: seconds, millisecond: 0 })
            .minus({ minutes: offsetMinutes });

        const reminderUTC = reminderLocal.toUTC();

        // If already past, skip — don't fall back to null (which = send immediately)
        if (reminderUTC <= DateTime.utc()) {
            console.warn(
                `[CRON] Skipping past reminder: ${timeStr} → ${reminderUTC.toISO()}`
            );
            return "SKIP";
        }

        return reminderUTC.toISO();
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: fetch all employees eligible for attendance reminders today
//
// Eligibility checks (all must pass):
//   ✅ Employee is active and not deleted
//   ✅ Employee has a shift assigned
//   ✅ Shift is active and not deleted
//   ✅ The TARGET day (tomorrow, in branch timezone) is a working day per shift's day columns
//   ✅ The TARGET day is NOT a public/company holiday for that branch
// ─────────────────────────────────────────────────────────────────────────────
async function fetchEligibleEmployees() {
    const { rows } = await db.query(`
        SELECT
            e.id                AS id,
            e.company_id        AS company_id,
            e.branch_id         AS branch_id,
            s.start_time        AS shift_start_time,
            s.end_time          AS shift_end_time,
            s.is_night_shift    AS is_night_shift,
            s.monday,
            s.tuesday,
            s.wednesday,
            s.thursday,
            s.friday,
            s.saturday,
            s.sunday,
            c.timezone          AS timezone   
        FROM employees e
        JOIN shifts   s ON e.shift_id  = s.id
        JOIN companies c ON e.company_id = c.id  
        WHERE e.is_active   = TRUE
          AND e.deleted_at  IS NULL
          AND e.shift_id    IS NOT NULL
          AND s.is_active   = TRUE
          AND s.deleted_at  IS NULL
    `);

    return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: fetch upcoming holidays (raw date ranges, not tied to "today").
// Eligibility is evaluated per-employee against the TARGET reminder date
// (tomorrow, in that employee's own timezone) — which can already be a
// different calendar date than the DB server's CURRENT_DATE depending on
// timezone and what time the job runs — so the actual "is this date a
// holiday" comparison happens in isHoliday() below, per employee.
// ─────────────────────────────────────────────────────────────────────────────
async function fetchHolidays() {
    const { rows } = await db.query(`
        SELECT company_id, branch_id, holiday_start_date, holiday_end_date
        FROM holidays
        WHERE is_active  = TRUE
          AND deleted_at IS NULL
          AND holiday_end_date >= CURRENT_DATE
    `);
    return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check if an employee's branch has a holiday on the given target date.
// Company-wide holiday (branch_id = null) blocks ALL branches of that company
// ─────────────────────────────────────────────────────────────────────────────
function isHoliday(holidays, company_id, branch_id, targetDate) {
    const targetISO = targetDate.toISODate();
    return holidays.some((h) => {
        if (h.company_id !== company_id) return false;
        if (h.branch_id !== null && h.branch_id !== branch_id) return false;
        const startISO = h.holiday_start_date.toISOString().slice(0, 10);
        const endISO = h.holiday_end_date.toISOString().slice(0, 10);
        return targetISO >= startISO && targetISO <= endISO;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN JOB: Schedule attendance check-in / check-out reminders
//
// Runs daily at 18:01 UTC (adjust as needed)
// Logic:
//   1. Fetch all active employees with a shift
//   2. Fetch upcoming holidays
//   3. For each employee, compute TOMORROW's date in their own timezone
//      once, then check working-day + holiday eligibility AND compute
//      reminder times against that SAME date (previously these used
//      "today" for eligibility but "tomorrow" for the reminder itself —
//      that mismatch dropped reminders on real working days and sent them
//      on real off days whenever today's/tomorrow's day-of-week differed)
//   4. Hand off to NotificationService.scheduleAttendanceReminders()
// ─────────────────────────────────────────────────────────────────────────────
async function runAttendanceReminderJob() {
    console.log(`[CRON][${new Date().toISOString()}] Attendance reminder job started`);

    try {
        // 1. Fetch all potentially eligible employees
        const allEmployees = await fetchEligibleEmployees();
        console.log(`[CRON] Total employees with shifts: ${allEmployees.length}`);

        // 2. Fetch upcoming holidays once (not per employee)
        const holidays = await fetchHolidays();
        console.log(`[CRON] Upcoming holiday entries: ${holidays.length}`);

        const CHECKIN_REMINDER_BEFORE_MINUTES = 15; // notify 15 min before shift start
        const CHECKOUT_REMINDER_BEFORE_MINUTES = 5; // notify 5 min before shift end

        // 3. Evaluate eligibility and compute reminder times against the
        //    same target date (tomorrow, in the employee's own timezone)
        const enriched = [];
        for (const emp of allEmployees) {
            const tz = emp.timezone || "UTC";
            const targetDate = DateTime.now().setZone(tz).plus({ days: 1 }).startOf("day");

            const dayColumn = getDayColumnForDate(targetDate); // e.g. "monday"
            if (emp[dayColumn] !== true) continue; // tomorrow is not a working day

            if (isHoliday(holidays, emp.company_id, emp.branch_id, targetDate)) continue; // tomorrow is a holiday

            const checkin_reminder_at = computeReminderUTC(
                emp.shift_start_time, targetDate, CHECKIN_REMINDER_BEFORE_MINUTES
            );
            const checkout_reminder_at = computeReminderUTC(
                emp.shift_end_time, targetDate, CHECKOUT_REMINDER_BEFORE_MINUTES
            );

            enriched.push({
                ...emp,
                // "SKIP" (already past) collapses to null = don't schedule
                checkin_reminder_at: checkin_reminder_at === "SKIP" ? null : checkin_reminder_at,
                checkout_reminder_at: checkout_reminder_at === "SKIP" ? null : checkout_reminder_at,
            });
        }

        console.log(`[CRON] Eligible employees for reminders tomorrow: ${enriched.length}`);

        if (!enriched.length) {
            console.log("[CRON] No reminders to schedule. Job complete.");
            return;
        }

        // 4. Hand off to notification service — it creates one queued notification per employee
        const result = await NotificationService.scheduleAttendanceReminders(
            enriched,
            CHECKIN_REMINDER_BEFORE_MINUTES
        );

        console.log(`[CRON] Reminders scheduled: ${result.scheduled}`);

        // Log any individual failures without crashing the job
        if (result.results) {
            const failed = result.results.filter((r) => !r.success);
            if (failed.length) {
                console.warn(`[CRON] ${failed.length} reminders failed to schedule:`);
                failed.forEach((f) =>
                    console.warn(`  → employee_id: ${f.employee_id} | ${f.message}`)
                );
            }
        }

        console.log(`[CRON] Attendance reminder job complete.`);
    } catch (error) {
        console.error("[CRON] Attendance reminder job FAILED:", error.message, error.stack);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPATCH JOB: Flush the notification dispatch queue every minute
//
// Picks up queued notification rows whose scheduled_at has passed
// and fans them out to notification_recipients, then retries any
// previously-failed sends whose next_retry_at has passed.
// ─────────────────────────────────────────────────────────────────────────────
async function runDispatchQueueJob() {
    try {
        const result = await NotificationService.processDispatchQueue();
        if (result.processed > 0) {
            console.log(
                `[CRON][${new Date().toISOString()}] Dispatched ${result.processed} notifications`
            );

            // Log partial failures
            const failed = result.results?.filter((r) => !r.success) || [];
            if (failed.length) {
                console.warn(`[CRON] ${failed.length} notifications partially failed:`);
                failed.forEach((f) =>
                    console.warn(`  → notification_id: ${f.notification_id} | ${f.message}`)
                );
            }
        }
    } catch (error) {
        console.error("[CRON] Dispatch queue job FAILED:", error.message);
    }

    try {
        const retryResult = await NotificationService.processRetryQueue();
        if (retryResult.processed > 0) {
            console.log(
                `[CRON][${new Date().toISOString()}] Retried ${retryResult.processed} failed deliveries`
            );

            const stillFailed = retryResult.results?.filter((r) => !r.success) || [];
            if (stillFailed.length) {
                console.warn(`[CRON] ${stillFailed.length} retries failed again:`);
                stillFailed.forEach((f) =>
                    console.warn(`  → recipient_id: ${f.recipient_id} | ${f.message}`)
                );
            }
        }
    } catch (error) {
        console.error("[CRON] Retry queue job FAILED:", error.message);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTER CRON SCHEDULES
// ─────────────────────────────────────────────────────────────────────────────

// Job 1: Schedule attendance reminders — runs once daily at 18:01 UTC
// All employees across all companies are processed in one pass
// Adjust time to run before the earliest possible shift start across all timezones
cron.schedule("1 18 * * *", runAttendanceReminderJob, {
    timezone: "UTC",
});

// Job 2: Dispatch queue flush — runs every minute
// Picks up scheduled reminders whose scheduled_at has now passed and sends them
cron.schedule("* * * * *", runDispatchQueueJob, {
    timezone: "UTC",
});

console.log("[CRON] Attendance reminder jobs registered.");

module.exports = {
    runAttendanceReminderJob,
    runDispatchQueueJob,
};