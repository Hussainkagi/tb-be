const cron = require("node-cron");
const { DateTime } = require("luxon"); // npm install luxon
const db = require("../config/database");
const NotificationService = require("../service/notificationService");

// ─────────────────────────────────────────────────────────────────────────────
// Helper: map shift's boolean day columns → today's day name
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

function getTodayDayColumn(timezone) {
    // luxon weekday: 1=Monday ... 7=Sunday
    const weekday = DateTime.now().setZone(timezone).weekday;
    // Convert to JS day index: Sunday=0, Monday=1 ... Saturday=6
    const jsDay = weekday === 7 ? 0 : weekday;
    return DAY_COLUMNS[jsDay]; // e.g. "monday"
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: compute UTC ISO timestamp for a reminder
// timeStr = "08:00:00" (shift start_time or end_time from DB)
// timezone = "Asia/Dubai"
// offsetMinutes = how many minutes BEFORE that time to send the reminder
// ─────────────────────────────────────────────────────────────────────────────
function computeReminderUTC(timeStr, timezone, offsetMinutes = 15) {
    if (!timeStr || !timezone) return null;

    try {
        const [hours, minutes, seconds = 0] = timeStr.split(":").map(Number);

        const reminderLocal = DateTime.now()
            .setZone(timezone)
            .plus({ days: 1 })
            .set({ hour: hours, minute: minutes, second: seconds, millisecond: 0 })
            .minus({ minutes: offsetMinutes });

        const reminderUTC = reminderLocal.toUTC();

        // If already past, skip — don't fall back to null (which = send immediately)
        if (reminderUTC <= DateTime.utc()) {
            console.warn(
                `[CRON] Skipping past reminder: ${timeStr} in ${timezone} → ${reminderUTC.toISO()}`
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
//   ✅ Today (in branch timezone) is a working day per shift's day columns
//   ✅ Today is NOT a public/company holiday for that branch
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
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: check if today is a holiday for a given company+branch
// Returns a Set of company_id+branch_id keys that have a holiday today
// ─────────────────────────────────────────────────────────────────────────────
async function fetchHolidayKeys() {
    const { rows } = await db.query(`
        SELECT DISTINCT
            company_id,
            branch_id   -- NULL means company-wide holiday
        FROM holidays
        WHERE CURRENT_DATE BETWEEN holiday_start_date AND holiday_end_date
          AND is_active  = TRUE
          AND deleted_at IS NULL
    `);

    // Build a quick lookup set
    // Key format: "companyId:branchId" or "companyId:null" for company-wide
    const keys = new Set();
    for (const row of rows) {
        keys.add(`${row.company_id}:${row.branch_id ?? "null"}`);
    }
    return keys;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check if an employee's branch has a holiday today
// Company-wide holiday (branch_id = null) blocks ALL branches of that company
// ─────────────────────────────────────────────────────────────────────────────
function isHoliday(holidayKeys, company_id, branch_id) {
    // Check branch-specific holiday
    if (holidayKeys.has(`${company_id}:${branch_id}`)) return true;
    // Check company-wide holiday
    if (holidayKeys.has(`${company_id}:null`)) return true;
    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check if today is a working day for this employee based on shift day columns
// e.g. if today is Monday → checks shift.monday === true
// ─────────────────────────────────────────────────────────────────────────────
function isTodayWorkingDay(emp) {
    const dayColumn = getTodayDayColumn(emp.timezone); // e.g. "monday"
    return emp[dayColumn] === true;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN JOB: Schedule attendance check-in / check-out reminders
//
// Runs daily at 00:01 AM UTC (adjust as needed)
// Logic:
//   1. Fetch all active employees with a shift
//   2. Fetch today's holidays
//   3. Filter out: holidays + non-working days
//   4. Compute reminder UTC timestamps per employee
//   5. Hand off to NotificationService.scheduleAttendanceReminders()
// ─────────────────────────────────────────────────────────────────────────────
async function runAttendanceReminderJob() {
    console.log(`[CRON][${new Date().toISOString()}] Attendance reminder job started`);

    try {
        // 1. Fetch all potentially eligible employees
        const allEmployees = await fetchEligibleEmployees();
        console.log(`[CRON] Total employees with shifts: ${allEmployees.length}`);

        // 2. Fetch today's holiday keys once (not per employee)
        const holidayKeys = await fetchHolidayKeys();
        console.log(`[CRON] Holiday entries today: ${holidayKeys.size}`);

        // 3. Filter to employees who actually need reminders today
        const eligible = allEmployees.filter((emp) => {
            // Skip if today is a holiday for their branch/company
            if (isHoliday(holidayKeys, emp.company_id, emp.branch_id)) {
                return false;
            }
            // Skip if today is not a working day per their shift
            if (!isTodayWorkingDay(emp)) {
                return false;
            }
            return true;
        });

        console.log(`[CRON] Eligible employees for reminders today: ${eligible.length}`);

        if (!eligible.length) {
            console.log("[CRON] No reminders to schedule. Job complete.");
            return;
        }

        // 4. Enrich each employee with pre-computed UTC reminder timestamps
        const CHECKIN_REMINDER_BEFORE_MINUTES = 15; // notify 15 min before shift start
        const CHECKOUT_REMINDER_BEFORE_MINUTES = 5; // notify 5 min before shift end

        const enriched = eligible
            .map((emp) => ({
                ...emp,
                checkin_reminder_at: computeReminderUTC(
                    emp.shift_start_time, emp.timezone, CHECKIN_REMINDER_BEFORE_MINUTES
                ),
                checkout_reminder_at: computeReminderUTC(
                    emp.shift_end_time, emp.timezone, CHECKOUT_REMINDER_BEFORE_MINUTES
                ),
            }))
            .filter((emp) => {
                // Drop employees where BOTH reminders are in the past
                const skipCheckin = !emp.shift_start_time || emp.checkin_reminder_at === "SKIP";
                const skipCheckout = !emp.shift_end_time || emp.checkout_reminder_at === "SKIP";
                if (skipCheckin) emp.checkin_reminder_at = null; // null = don't schedule
                if (skipCheckout) emp.checkout_reminder_at = null;
                return true; // keep all — individual nulls are handled in scheduleAttendanceReminders
            });

        // 5. Hand off to notification service — it creates one queued notification per employee
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
// and fans them out to notification_recipients
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
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTER CRON SCHEDULES
// ─────────────────────────────────────────────────────────────────────────────

// Job 1: Schedule attendance reminders — runs once daily at 00:01 AM UTC
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