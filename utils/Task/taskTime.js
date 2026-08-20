/**
 * Deadline arithmetic for the task module.
 *
 * Everything here exists because "one day before the deadline" is not a
 * subtraction. The employee, the person who set the deadline and the server
 * can all be in different places, and the company's timezone
 * (companies.timezone) is the only one that makes a shared answer possible —
 * the same choice jobs/attendanceReminderJob.js and jobs/birthdayNotificationJob.js
 * already make.
 */

const { DateTime } = require("luxon");

/** Fallback when a company has no timezone set. Matches companies.timezone DEFAULT. */
const DEFAULT_TIMEZONE = "UTC";

/** Local hour at which deadline reminders should land. */
const REMINDER_SEND_HOUR = 9; // 09:00 in the company's timezone

const zoneOf = (timezone) => {
    if (!timezone) return DEFAULT_TIMEZONE;
    return DateTime.local().setZone(timezone).isValid ? timezone : DEFAULT_TIMEZONE;
};

/**
 * Parse whatever the client sent as a deadline into an absolute instant.
 *
 * Accepts:
 *   - a full ISO string with an offset  → taken at face value
 *   - "2026-08-25T17:00" or "2026-08-25" → interpreted in `timezone`
 *
 * The second form is the common one: an admin picking 5 PM from a date
 * picker means 5 PM where the work happens, not 5 PM UTC. Getting this
 * wrong is a silent four-hour error in every Gulf deadline.
 */
const parseDueAt = (value, timezone) => {
    if (!value) return null;

    const zone = zoneOf(timezone);

    if (value instanceof Date) {
        return DateTime.fromJSDate(value).isValid ? value : null;
    }

    const raw = String(value).trim();
    const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw);

    const dt = hasOffset
        ? DateTime.fromISO(raw, { setZone: true })
        : DateTime.fromISO(raw.length === 10 ? `${raw}T23:59:59` : raw, { zone });

    return dt.isValid ? dt.toUTC().toJSDate() : null;
};

/** The task's deadline as it reads to the people involved: "25 Aug 2026, 5:00 PM". */
const formatDueForDisplay = (dueAt, timezone) => {
    if (!dueAt) return "no deadline";

    return DateTime.fromJSDate(new Date(dueAt))
        .setZone(zoneOf(timezone))
        .toFormat("dd LLL yyyy, h:mm a");
};

/**
 * When should the "due soon" reminder be delivered?
 *
 * `leadDays` before the deadline, at REMINDER_SEND_HOUR local time. Returns
 * null when that moment has already passed — the caller then decides whether
 * to send immediately (deadline is imminent) or skip.
 */
const computeReminderAt = (dueAt, timezone, leadDays = 1) => {
    if (!dueAt) return null;

    const zone = zoneOf(timezone);
    const due = DateTime.fromJSDate(new Date(dueAt)).setZone(zone);
    if (!due.isValid) return null;

    const reminder = due
        .minus({ days: leadDays })
        .set({ hour: REMINDER_SEND_HOUR, minute: 0, second: 0, millisecond: 0 });

    return reminder.toUTC().toJSDate();
};

/**
 * Does this deadline fall on the local calendar day that is `leadDays` from
 * today, in the company's timezone?
 *
 * The job runs hourly and asks this question of every live task, exactly the
 * way birthdayNotificationJob asks "is it their birthday where they are".
 */
const isDueInLocalDays = (dueAt, timezone, leadDays = 1) => {
    if (!dueAt) return false;

    const zone = zoneOf(timezone);
    const due = DateTime.fromJSDate(new Date(dueAt)).setZone(zone);
    if (!due.isValid) return false;

    const target = DateTime.now().setZone(zone).plus({ days: leadDays });

    return due.hasSame(target, "day");
};

/** Is the deadline behind us right now? */
const isOverdue = (dueAt) => Boolean(dueAt) && new Date(dueAt).getTime() < Date.now();

/**
 * The company's current local calendar date, and the one before it.
 * The rollup runs against `previous` — a day is only final once it is over
 * where the company lives.
 */
const localDates = (timezone) => {
    const zone = zoneOf(timezone);
    const now = DateTime.now().setZone(zone);

    return {
        zone,
        today: now.toISODate(),
        previous: now.minus({ days: 1 }).toISODate(),
    };
};

/**
 * UTC bounds of one local calendar day — the window the rollup aggregates
 * over. Returned as JS Dates so they drop straight into a parameterised query.
 */
const localDayBoundsUTC = (isoDate, timezone) => {
    const zone = zoneOf(timezone);
    const start = DateTime.fromISO(isoDate, { zone }).startOf("day");

    if (!start.isValid) return null;

    return {
        start_utc: start.toUTC().toJSDate(),
        end_utc: start.plus({ days: 1 }).toUTC().toJSDate(),
    };
};

module.exports = {
    DEFAULT_TIMEZONE,
    REMINDER_SEND_HOUR,
    zoneOf,
    parseDueAt,
    formatDueForDisplay,
    computeReminderAt,
    isDueInLocalDays,
    isOverdue,
    localDates,
    localDayBoundsUTC,
};
