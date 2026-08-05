const cron = require("node-cron");
const { DateTime } = require("luxon");
const db = require("../config/database");
const NotificationService = require("../service/notificationService");

// ─────────────────────────────────────────────────────────────────────────────
// EMPLOYEE BIRTHDAY NOTIFICATIONS
//
// Two notifications go out on an employee's birthday:
//   1. birthday_wish         → the employee ("Happy Birthday!")
//   2. birthday_announcement → everyone else in their branch
//
// Timezone handling
// -----------------
// "Today" is not a single global date. A company in Asia/Dubai rolls over to
// the next day 5.5 hours before one in America/New_York. So the job runs
// HOURLY and evaluates each employee against the current date in their own
// company's timezone, rather than the server's.
//
// Idempotency
// -----------
// Running hourly means each birthday is evaluated ~24 times a day. Every
// notification is tagged entity_type = 'employee_birthday' + entity_id =
// employee id, and uq_birthday_notification_once_per_day makes a second
// insert for the same employee/day a unique violation, which
// NotificationService.send() reports as `skipped` rather than an error.
// So repeats — restarts, redeploys, multiple instances — are harmless.
// ─────────────────────────────────────────────────────────────────────────────

// Local hour at which birthday notifications should land.
const BIRTHDAY_SEND_HOUR = 9; // 09:00 in the company's timezone

// ─────────────────────────────────────────────────────────────────────────────
// Fetch every active employee who has a date of birth recorded.
// Company timezone drives "what day is it for this person".
// ─────────────────────────────────────────────────────────────────────────────
async function fetchEmployeesWithBirthdays() {
    const { rows } = await db.query(`
        SELECT
            e.id,
            e.company_id,
            e.branch_id,
            e.first_name,
            e.last_name,
            -- Returned as TEXT deliberately. node-pg parses a DATE column into
            -- a JS Date at the SERVER's local midnight, so reading it back with
            -- UTC getters shifts the day (a UTC+4 host turns 1992-08-05 into
            -- Aug 4). Keeping it as "YYYY-MM-DD" removes the ambiguity entirely.
            to_char(e.date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
            c.company_name,
            c.timezone          AS timezone,
            b.branch_name,
            d.department_name
        FROM employees e
        JOIN companies c   ON c.id = e.company_id
        LEFT JOIN branches b     ON b.id = e.branch_id
        LEFT JOIN departments d  ON d.id = e.department_id
        WHERE e.is_active        = TRUE
          AND e.deleted_at       IS NULL
          AND e.date_of_birth    IS NOT NULL
          AND e.status           = 'active'
          AND c.is_active        = TRUE
          AND c.deleted_at       IS NULL
    `);

    return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract { month, day } from a date of birth without any timezone shift.
//
// Accepts the "YYYY-MM-DD" string the job's query returns, and also tolerates
// a JS Date in case a caller passes one — in which case the LOCAL getters are
// correct, because that is how node-pg builds Dates from DATE columns.
// ─────────────────────────────────────────────────────────────────────────────
function extractMonthDay(dateOfBirth) {
    if (!dateOfBirth) return null;

    if (typeof dateOfBirth === "string") {
        const m = dateOfBirth.match(/^(\d{4})-(\d{2})-(\d{2})/);
        return m ? { month: Number(m[2]), day: Number(m[3]) } : null;
    }

    if (dateOfBirth instanceof Date && !isNaN(dateOfBirth)) {
        return { month: dateOfBirth.getMonth() + 1, day: dateOfBirth.getDate() };
    }

    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Does this date of birth fall on `localDate`?
//
// Handles 29 February: in a non-leap year the birthday is observed on
// 28 February, so those employees still get wished every year.
// ─────────────────────────────────────────────────────────────────────────────
function isBirthdayToday(dateOfBirth, localDate) {
    const dob = extractMonthDay(dateOfBirth);
    if (!dob) return false;

    const { month: dobMonth, day: dobDay } = dob;

    if (dobMonth === localDate.month && dobDay === localDate.day) return true;

    // 29 Feb birthday in a non-leap year → observe on 28 Feb
    const isLeapYear = DateTime.fromObject({ year: localDate.year }).isInLeapYear;
    if (dobMonth === 2 && dobDay === 29 && !isLeapYear) {
        return localDate.month === 2 && localDate.day === 28;
    }

    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// The UTC instant matching BIRTHDAY_SEND_HOUR on the employee's local date.
//
// A past instant is fine and intentional: the dispatch queue runs every
// minute and picks up anything already due, so a job started mid-morning
// still delivers today's birthdays instead of dropping them.
// ─────────────────────────────────────────────────────────────────────────────
function computeSendAtUTC(localDate, timezone) {
    return localDate
        .setZone(timezone, { keepLocalTime: true })
        .set({ hour: BIRTHDAY_SEND_HOUR, minute: 0, second: 0, millisecond: 0 })
        .toUTC()
        .toISO();
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN JOB
// ─────────────────────────────────────────────────────────────────────────────
async function runBirthdayNotificationJob() {
    console.log(`[CRON][${new Date().toISOString()}] Birthday notification job started`);

    try {
        const employees = await fetchEmployeesWithBirthdays();
        console.log(`[CRON] Active employees with a date of birth: ${employees.length}`);

        const celebrating = [];

        for (const emp of employees) {
            const tz = emp.timezone || "UTC";
            const localDate = DateTime.now().setZone(tz).startOf("day");

            if (!isBirthdayToday(emp.date_of_birth, localDate)) continue;

            celebrating.push({
                ...emp,
                send_at: computeSendAtUTC(localDate, tz),
            });
        }

        console.log(`[CRON] Birthdays today: ${celebrating.length}`);

        if (!celebrating.length) {
            console.log("[CRON] No birthdays to celebrate. Job complete.");
            return { scheduled: 0, skipped: 0 };
        }

        const result = await NotificationService.sendBirthdayNotifications(celebrating);

        console.log(
            `[CRON] Birthday notifications — scheduled: ${result.scheduled}, ` +
            `already handled/skipped: ${result.skipped}`
        );

        const failed = (result.results || []).filter((r) => !r.success);
        if (failed.length) {
            console.warn(`[CRON] ${failed.length} birthday notifications failed:`);
            failed.forEach((f) =>
                console.warn(`  → employee_id: ${f.employee_id} (${f.type}) | ${f.message}`)
            );
        }

        console.log("[CRON] Birthday notification job complete.");
        return result;
    } catch (error) {
        console.error("[CRON] Birthday notification job FAILED:", error.message, error.stack);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTER SCHEDULE
//
// Hourly at minute 5. Every company's local midnight falls inside some hour,
// so an hourly pass catches every timezone; the unique index absorbs the
// repeated evaluations of the same birthday.
// ─────────────────────────────────────────────────────────────────────────────
cron.schedule("5 * * * *", runBirthdayNotificationJob, { timezone: "UTC" });

console.log("[CRON] Birthday notification job registered.");

module.exports = {
    runBirthdayNotificationJob,
    isBirthdayToday,
    extractMonthDay,
    computeSendAtUTC,
    BIRTHDAY_SEND_HOUR,
};
