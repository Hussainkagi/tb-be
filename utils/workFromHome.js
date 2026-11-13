/**
 * Fixed work-from-home weekdays (employees.work_from_home_days).
 *
 * On one of these days the employee's check-in and check-out skip the
 * geofence — see attendanceService.js. Days are lowercase English weekday
 * names, matching the shifts table's working-day columns.
 */

const WEEKDAYS = Object.freeze([
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);

/**
 * Validates and canonicalises a work-from-home list from a request body.
 * Accepts any case and duplicates; returns the days in week order.
 *
 * @returns {{ days: string[] } | { error: string }}
 */
function normalizeWorkFromHomeDays(input) {
    if (input === null || input === undefined) return { days: [] };
    if (!Array.isArray(input)) {
        return { error: "work_from_home_days must be an array of weekday names" };
    }

    const wanted = new Set();
    for (const raw of input) {
        const day = String(raw ?? "").trim().toLowerCase();
        if (!WEEKDAYS.includes(day)) {
            return {
                error: `Invalid work-from-home day "${raw}". Use: ${WEEKDAYS.join(", ")}`,
            };
        }
        wanted.add(day);
    }
    return { days: WEEKDAYS.filter((d) => wanted.has(d)) };
}

/**
 * Whether `weekday` ("monday" …) is one of the employee's work-from-home days.
 */
function isWorkFromHomeDay(employee, weekday) {
    const days = employee?.work_from_home_days;
    return Array.isArray(days) && days.includes(weekday);
}

module.exports = { WEEKDAYS, normalizeWorkFromHomeDays, isWorkFromHomeDay };
