
const db = require("../config/database");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * "YYYY-MM-DD" for a DATE column. node-pg turns a DATE into local midnight of
 * the server process, so reading it back in UTC (toISOString) gives the day
 * before on any server east of UTC. Read it in local time instead.
 */
function dateKey(value) {
    if (!(value instanceof Date)) return String(value).slice(0, 10);
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

/**
 * Generate an array of "YYYY-MM-DD" strings for every day in [startDate, endDate].
 */
function generateDateRange(startDate, endDate) {
    const dates = [];
    const current = new Date(startDate + "T00:00:00Z");
    const end = new Date(endDate + "T00:00:00Z");
    while (current <= end) {
        dates.push(current.toISOString().slice(0, 10));
        current.setUTCDate(current.getUTCDate() + 1);
    }
    return dates;
}

/**
 * pg parses `timestamp without time zone` columns as if the naive digits
 * were UTC. Since those digits are already the correct local wall-clock
 * time (per your seed/check-in convention), reading them back via the
 * UTC getters (toISOString) recovers the original digits unchanged.
 * Do NOT run this value through toLocalISOString/Intl — that double-shifts it.
 */
function extractNaiveDateTime(date) {
    if (!date) return null;
    const d = date instanceof Date ? date : new Date(date);
    return d.toISOString().slice(0, 19); // "YYYY-MM-DDTHH:mm:ss"
}

/**
 * Convert a Date to "YYYY-MM-DDTHH:mm:ss" local string in the given IANA timezone,
 * without trailing "Z" — matches old backend format.
 * Falls back to UTC if timezone is invalid/missing.
 */
function toLocalISOString(date, timezone) {
    if (!date) return null;
    const d = date instanceof Date ? date : new Date(date);
    try {
        const formatter = new Intl.DateTimeFormat("en-CA", {
            timeZone: timezone || "UTC",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        });
        const parts = formatter.formatToParts(d);
        const get = (t) => parts.find((p) => p.type === t)?.value ?? "00";
        const hour = get("hour") === "24" ? "00" : get("hour");
        return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
    } catch {
        return d.toISOString().slice(0, 19);
    }
}

/**
 * The timezone an employee's times are shown in: their shift's, the same one
 * check-in used to date the row and decide on-time/late. The request's
 * timezone (the company's) is only the fallback for an employee without a
 * shift. A company with branches in several countries would otherwise show
 * every branch's times in the head office's clock.
 */
function tzOf(emp, fallback) {
    return emp?.shift_timezone || fallback || "UTC";
}

/**
 * A short name for where a clock is, for labels like "10:22 AM · India".
 * Prefers the country (a stored name, or an ISO code turned into one); falls
 * back to the timezone's city ("Asia/Kolkata" -> "Kolkata").
 */
function placeLabel(country, timezone) {
    const c = country ? String(country).trim() : "";
    if (/^[A-Za-z]{2}$/.test(c)) {
        try {
            const name = new Intl.DisplayNames(["en"], { type: "region" }).of(c.toUpperCase());
            if (name) return name;
        } catch { /* fall through */ }
    }
    if (c) return c;
    const city = String(timezone || "UTC").split("/").pop();
    return city.replace(/_/g, " ");
}

/**
 * Convert "HH:mm" or "HH:mm:ss" time string to total minutes since midnight.
 */
function timeStringToMinutes(timeStr) {
    if (!timeStr) return 0;
    const [h, m] = String(timeStr).split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
}

/**
 * Convert a Date to minutes-since-midnight in the given IANA timezone.
 */
function dateToMinutesInTz(date, timezone) {
    const d = date instanceof Date ? date : new Date(date);
    try {
        const formatter = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone || "UTC",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        });
        const parts = formatter.formatToParts(d);
        const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
        const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
        return h * 60 + m;
    } catch {
        return 0;
    }
}

/**
 * Derive the display code from an attendance DB row.
 *
 * Codes:
 *   WO  – week-off             (status = 'week-off')
 *   H   – holiday              (status = 'holiday')
 *   L   – leave                (status = 'leave')
 *   CO  – comp-off             (status = 'comp-off')
 *   P   – present              (status = 'checked-in' | 'checked-out')
 *   HP  – half-present         (status = 'half-present')
 *   A   – absent               (status = 'absent' OR no row)
 */
function getAttendanceCode(row, dateStr, emp) {
    // Derive weekday name from dateStr (YYYY-MM-DD)
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const dayIndex = new Date(dateStr + "T00:00:00Z").getUTCDay();
    const dayName = dayNames[dayIndex];

    // Helper: determine if employee shift marks this day as working
    const isWorkingDay = emp && typeof emp[dayName] !== 'undefined' ? Boolean(emp[dayName]) : true;

    // No attendance row -> decide based on shift weekday
    if (!row) {
        return isWorkingDay ? "A" : "WO";
    }

    // If row explicitly marks holiday or leave, preserve it
    if (row.status === "holiday") return "H";
    if (row.status === "leave") return "L";

    // If attendance row marks week-off / comp-off but current shift says this
    // day is a working day, treat as absent (unless there is actual check-in)
    if (row.status === "week-off" || row.status === "comp-off") {
        if (isWorkingDay) {
            if (row.check_in || row.check_out) return "P";
            return "A";
        }
        return row.status === "comp-off" ? "CO" : "WO";
    }

    // Present-like statuses
    switch (row.status) {
        case "checked-in":
        case "checked-out": return row.is_half_day ? "HP" : "P";
        case "half-present": return "HP";
        case "absent":
        default: return "A";
    }
}

// ---------------------------------------------------------------------------
// Core data fetcher — used by all 5 report APIs
// ---------------------------------------------------------------------------

/**
 * Fetch employees + their attendance rows for the given filters.
 *
 * Filters accepted:
 *   companyId    (required)
 *   employeeId   — employee_code string e.g. "EMP001"
 *   branchId     — branch UUID
 *   departmentId — department UUID
 *   startDate    — "YYYY-MM-DD"
 *   endDate      — "YYYY-MM-DD"
 *
 * Returns:
 *   employees    — array of employee rows (with shift data joined)
 *   attendanceMap — Map<employee_uuid, Map<"YYYY-MM-DD", attendanceRow>>
 */
async function fetchEmployeesAndAttendance(filters) {
    const { companyId, employeeId, branchId, departmentId, startDate, endDate } = filters;

    // ── 1. Build employee query ──────────────────────────────────────────────
    // employeeId is the employee UUID (e.id), not employee_code
    const empConditions = [
        "e.company_id = $1",
        "e.deleted_at IS NULL",
        "e.status = 'active'",
    ];
    const empValues = [companyId];
    let p = 2;

    if (employeeId) {
        empConditions.push(`e.id = $${p++}`);
        empValues.push(employeeId);
    }
    if (branchId) {
        empConditions.push(`e.branch_id = $${p++}`);
        empValues.push(branchId);
    }
    if (departmentId) {
        empConditions.push(`e.department_id = $${p++}`);
        empValues.push(departmentId);
    }

    const empResult = await db.query(
        `SELECT
            e.id                    AS employee_uuid,
            e.employee_code,
            e.first_name,
            e.last_name,
            e.branch_id,

            -- Shift fields (all nullable — employee may have no shift assigned)
            s.id                    AS shift_id,
            s.shift_name,
            s.start_time,
            s.end_time,
            s.late_grace_minutes,
            s.working_hours         AS shift_working_hours,   -- expected hrs per day e.g. 8.00
            s.half_day_hours,
            s.is_night_shift,
            s.timezone              AS shift_timezone,
            s.monday, s.tuesday, s.wednesday, s.thursday, s.friday, s.saturday, s.sunday

         FROM employees e
         LEFT JOIN shifts s
                ON e.shift_id = s.id
               AND s.deleted_at IS NULL
               AND s.is_active = TRUE
         WHERE ${empConditions.join(" AND ")}
         ORDER BY e.employee_code`,
        empValues
    );

    console.log("EMP QUERY", empResult)

    const employees = empResult.rows;
    if (!employees.length) return { employees: [], attendanceMap: new Map() };

    // ── 2. Fetch attendance for all matched employees ────────────────────────
    // console.log(`Fetching attendance for`, employees);
    const empUuids = employees.map((e) => e.employee_uuid);


    const attValues = [empUuids];
    let attFilter = "";
    let ap = 2;

    if (startDate && endDate) {
        attFilter = `AND a.attendance_date BETWEEN $${ap++} AND $${ap++}`;
        attValues.push(startDate, endDate);
    } else if (startDate) {
        attFilter = `AND a.attendance_date >= $${ap++}`;
        attValues.push(startDate);
    } else if (endDate) {
        attFilter = `AND a.attendance_date <= $${ap++}`;
        attValues.push(endDate);
    }

    const attResult = await db.query(
        `SELECT
            a.employee_id,
            a.attendance_date,
            a.check_in,
            a.check_out,
            a.total_hours,
            a.status,
            a.attendance_status,
            a.is_half_day
         FROM attendance a
         WHERE a.employee_id = ANY($1) ${attFilter}
         ORDER BY a.attendance_date`,
        attValues
    );



    // ── 3. Build Map<employee_uuid, Map<"YYYY-MM-DD", row>> ─────────────────
    const attendanceMap = new Map();
    for (const row of attResult.rows) {
        // attendance_date comes back as a JS Date from pg — normalise to string
        const day = dateKey(row.attendance_date);

        if (!attendanceMap.has(row.employee_id)) {
            attendanceMap.set(row.employee_id, new Map());
        }
        attendanceMap.get(row.employee_id).set(day, row);
    }



    return { employees, attendanceMap };
}

// ---------------------------------------------------------------------------
// Service methods
// ---------------------------------------------------------------------------

const AttendanceReportService = {

    // -----------------------------------------------------------------------
    // API 1 — Detailed Report
    // Returns a per-day attendance grid with codes + check-in/out times
    // -----------------------------------------------------------------------
    async getDetailedReport(filters) {
        try {
            const { startDate, endDate, timezone = "UTC" } = filters;
            const dates = generateDateRange(startDate, endDate);

            const { employees, attendanceMap } = await fetchEmployeesAndAttendance(filters);

            const employeeReports = employees.map((emp) => {
                const empAttMap = attendanceMap.get(emp.employee_uuid) ?? new Map();

                const attendanceByDate = {};

                for (const dateStr of dates) {
                    const row = empAttMap.get(dateStr) ?? null;
                    const code = getAttendanceCode(row, dateStr, emp);

                    // Non-working days — just return the code
                    if (["WO", "H", "L", "CO", "A"].includes(code)) {
                        attendanceByDate[dateStr] = { code };
                        continue;
                    }

                    // Present (P) or half-present (HP)
                    const entry = { code };

                    if (row?.check_in) {
                        entry.checkIn = toLocalISOString(row.check_in, tzOf(emp, timezone));
                    }
                    if (row?.check_out) {
                        entry.checkOut = toLocalISOString(row.check_out, tzOf(emp, timezone));
                        const workedMinutes = row.total_hours != null
                            ? Math.round(Number(row.total_hours) * 60)
                            : 0;
                        entry.workedMinutes = workedMinutes;
                        entry.workingHours = parseFloat((workedMinutes / 60).toFixed(2));
                    }

                    attendanceByDate[dateStr] = entry;
                }

                return {
                    empNo: emp.employee_code,
                    name: `${emp.first_name} ${emp.last_name}`.trim(),
                    shift: emp.shift_name ?? "Default",
                    attendanceByDate,
                };
            });

            return { success: true, data: { dates, employees: employeeReports } };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // -----------------------------------------------------------------------
    // API 2 — Headcount
    // Counts present / absent / week-off / leave / holiday per employee
    // -----------------------------------------------------------------------
    async getHeadcount(filters) {
        try {
            const { startDate, endDate } = filters;
            const dates = generateDateRange(startDate, endDate);

            const { employees, attendanceMap } = await fetchEmployeesAndAttendance(filters);
            console.log("Filters", filters);
            console.log("EMPLOYEES", employees);
            console.log("ATTENDANCE MAP", attendanceMap);

            const employeeReports = employees.map((emp) => {
                console.log("PROCESS", attendanceMap)
                const empAttMap = attendanceMap.get(emp.employee_uuid) ?? new Map();

                let present = 0, absent = 0, weekOff = 0, weekOffPresent = 0;
                let halfPresent = 0, weekOffHalfPresent = 0;
                let holiday = 0, holidayPresent = 0, leave = 0, compOff = 0;

                for (const dateStr of dates) {
                    const row = empAttMap.get(dateStr) ?? null;
                    const code = getAttendanceCode(row, dateStr, emp);

                    switch (code) {
                        case "WO": weekOff++; break;
                        case "H": holiday++; break;
                        case "L": leave++; break;
                        case "CO": compOff++; break;
                        case "P": present++; break;
                        case "HP": halfPresent++; break;
                        default: absent++; break;
                    }
                }

                // Working days = days employee was actually present (P + HP)
                const workingDays = present + halfPresent;
                // Total schedulable days = exclude week-offs, holidays, comp-offs
                const totalWorkingDays = dates.length - weekOff - holiday - compOff;

                return {
                    empNo: emp.employee_code,
                    name: `${emp.first_name} ${emp.last_name}`.trim(),
                    shift: emp.shift_name ?? "Default",
                    present,
                    absent,
                    weekOff,
                    weekOffPresent,
                    halfPresent,
                    weekOffHalfPresent,
                    holiday,
                    holidayPresent,
                    leave,
                    workingDays,
                    totalWorkingDays,
                    total: dates.length,
                };
            });

            return { success: true, data: { employees: employeeReports } };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // -----------------------------------------------------------------------
    // API 3 — Check-In / Check-Out Ratio
    // -----------------------------------------------------------------------
    async getCheckInOutRatio(filters) {
        try {
            const { startDate, endDate } = filters;
            const dates = generateDateRange(startDate, endDate);

            const { employees, attendanceMap } = await fetchEmployeesAndAttendance(filters);

            const employeeReports = employees.map((emp) => {
                const empAttMap = attendanceMap.get(emp.employee_uuid) ?? new Map();

                let checkInEligibleDays = 0;
                let checkInCount = 0;
                let checkOutCount = 0;

                for (const dateStr of dates) {
                    const row = empAttMap.get(dateStr) ?? null;
                    const code = getAttendanceCode(row, dateStr, emp);

                    // Eligible = any day that is NOT week-off / holiday / comp-off
                    // (leave days are borderline — employee was rostered but on leave)
                    if (!["WO", "H", "CO"].includes(code)) {
                        checkInEligibleDays++;
                    }
                    if (row?.check_in) checkInCount++;
                    if (row?.check_out) checkOutCount++;
                }

                // Check-out eligible = only days where employee actually checked in
                const checkOutEligibleDays = checkInCount;

                const checkInPercentage = checkInEligibleDays > 0
                    ? parseFloat(((checkInCount / checkInEligibleDays) * 100).toFixed(2))
                    : 0;
                const checkOutPercentage = checkOutEligibleDays > 0
                    ? parseFloat(((checkOutCount / checkOutEligibleDays) * 100).toFixed(2))
                    : 0;

                return {
                    empNo: emp.employee_code,
                    name: `${emp.first_name} ${emp.last_name}`.trim(),
                    shift: emp.shift_name ?? "Default",
                    checkInPercentage,
                    checkInCount,
                    checkInEligibleDays,
                    checkOutPercentage,
                    checkOutCount,
                    checkOutEligibleDays,
                };
            });

            return { success: true, data: { employees: employeeReports } };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // -----------------------------------------------------------------------
    // API 4 — Punctuality Ratio
    // Uses shift.start_time + shift.late_grace_minutes to classify each check-in
    // -----------------------------------------------------------------------
    async getPunctualityRatio(filters) {
        try {
            const { startDate, endDate, timezone = "UTC" } = filters;
            const dates = generateDateRange(startDate, endDate);

            const { employees, attendanceMap } = await fetchEmployeesAndAttendance(filters);

            const employeeReports = employees.map((emp) => {
                const empAttMap = attendanceMap.get(emp.employee_uuid) ?? new Map();

                // Shift timing in minutes-since-midnight
                const startMinutes = timeStringToMinutes(emp.start_time);
                const lateGrace = emp.late_grace_minutes ?? 0;
                const lateThreshold = startMinutes + lateGrace;
                const endMinutes = timeStringToMinutes(emp.end_time);

                let onTimeCount = 0, lateCount = 0, earlyEntryCount = 0, overtimeCount = 0;
                let totalCheckIns = 0;

                for (const dateStr of dates) {
                    const row = empAttMap.get(dateStr) ?? null;
                    if (!row?.check_in) continue;

                    totalCheckIns++;
                    const checkInMins = dateToMinutesInTz(row.check_in, tzOf(emp, timezone));

                    if (checkInMins < startMinutes) {
                        earlyEntryCount++;
                    } else if (checkInMins <= lateThreshold) {
                        onTimeCount++;
                    } else {
                        lateCount++;
                    }

                    // Overtime: checked out after shift end time
                    if (row?.check_out && emp.end_time) {
                        const checkOutMins = dateToMinutesInTz(row.check_out, tzOf(emp, timezone));
                        // For night shifts, check-out can be < end_time numerically (crosses midnight)
                        // Simple approach: if total_hours > shift working_hours, count as overtime
                        if (emp.is_night_shift) {
                            const workedMins = row.total_hours ? Number(row.total_hours) * 60 : 0;
                            const shiftMins = Number(emp.shift_working_hours ?? 8) * 60;
                            if (workedMins > shiftMins) overtimeCount++;
                        } else {
                            if (checkOutMins > endMinutes) overtimeCount++;
                        }
                    }
                }

                const pct = (count) => totalCheckIns > 0
                    ? parseFloat(((count / totalCheckIns) * 100).toFixed(2))
                    : 0;

                return {
                    empNo: emp.employee_code,
                    name: `${emp.first_name} ${emp.last_name}`.trim(),
                    shift: emp.shift_name ?? "Default",
                    onTimePercentage: pct(onTimeCount),
                    onTimeCount,
                    latePercentage: pct(lateCount),
                    lateCount,
                    earlyEntryPercentage: pct(earlyEntryCount),
                    earlyEntryCount,
                    overtimePercentage: pct(overtimeCount),
                    overtimeCount,
                    totalCheckIns,
                };
            });

            return { success: true, data: { employees: employeeReports } };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // -----------------------------------------------------------------------
    // API 5 — Working Hours
    // Uses shift.working_hours (expected hrs/day) from actual schema column
    // -----------------------------------------------------------------------
    async getWorkingHours(filters) {
        try {
            const { startDate, endDate } = filters;
            const dates = generateDateRange(startDate, endDate);

            const { employees, attendanceMap } = await fetchEmployeesAndAttendance(filters);

            const employeeReports = employees.map((emp) => {
                const empAttMap = attendanceMap.get(emp.employee_uuid) ?? new Map();

                // shift.working_hours = expected hours per working day (e.g. 8.00)
                const shiftHoursPerDay = Number(emp.shift_working_hours ?? 8);
                const shiftMinsPerDay = shiftHoursPerDay * 60;

                let scheduledWorkingDays = 0;
                let totalWorkedMinutes = 0;
                let overtimeMinutes = 0;

                for (const dateStr of dates) {
                    const row = empAttMap.get(dateStr) ?? null;
                    const code = getAttendanceCode(row, dateStr, emp);

                    // Scheduled = all days except week-off and holidays
                    if (!["WO", "H", "CO"].includes(code)) {
                        scheduledWorkingDays++;
                    }

                    if (row?.total_hours) {
                        const workedMins = Math.round(Number(row.total_hours) * 60);
                        totalWorkedMinutes += workedMins;

                        // Overtime = minutes worked beyond the scheduled shift
                        const extra = workedMins - shiftMinsPerDay;
                        if (extra > 0) overtimeMinutes += extra;
                    }
                }

                // Scheduled minutes for the period
                const shiftHoursScheduled = scheduledWorkingDays * shiftMinsPerDay; // in minutes
                const shiftHoursScheduledHrs = parseFloat((shiftHoursScheduled / 60).toFixed(2));

                // Shift hours completed = worked minus overtime
                const shiftHoursCompleted = Math.max(0, totalWorkedMinutes - overtimeMinutes);
                const shiftHoursCompletedHrs = parseFloat((shiftHoursCompleted / 60).toFixed(2));

                const totalWorkedHrs = parseFloat((totalWorkedMinutes / 60).toFixed(2));
                const overtimeHrs = parseFloat((overtimeMinutes / 60).toFixed(2));

                const shiftHoursPercentage = shiftHoursScheduled > 0
                    ? parseFloat(((shiftHoursCompleted / shiftHoursScheduled) * 100).toFixed(2))
                    : 0;
                const overtimePercentage = shiftHoursScheduled > 0
                    ? parseFloat(((overtimeMinutes / shiftHoursScheduled) * 100).toFixed(2))
                    : 0;

                return {
                    empNo: emp.employee_code,
                    name: `${emp.first_name} ${emp.last_name}`.trim(),
                    shift: emp.shift_name ?? "Default",
                    shiftHoursPercentage,
                    shiftHoursCompleted,
                    shiftHoursCompletedHrs,
                    shiftHoursScheduled,
                    shiftHoursScheduledHrs,
                    overtimePercentage,
                    overtimeMinutes,
                    overtimeHrs,
                    totalWorkedMinutes,
                    totalWorkedHrs,
                };
            });

            return { success: true, data: { employees: employeeReports } };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // -----------------------------------------------------------------------
    // API 6 — Casual (Raw Attendance Entries)
    // Returns all attendance entries between specific dates with all fields
    // Filters: companyId (required), employeeId, branchId, departmentId, startDate, endDate
    // -----------------------------------------------------------------------
    async getCasualReport(filters) {
        try {
            const { companyId, employeeId, branchId, departmentId, startDate, endDate, timezone = "UTC" } = filters;
            if (!companyId || !startDate || !endDate) {
                return { success: false, message: "companyId, startDate, and endDate are required" };
            }

            const conditions = ["a.company_id = $1", "a.attendance_date BETWEEN $2 AND $3"];
            const values = [companyId, startDate, endDate];
            let p = 4;
            if (employeeId) {
                conditions.push(`a.employee_id = $${p++}`);
                values.push(employeeId);
            }
            if (branchId) {
                conditions.push(`a.branch_id = $${p++}`);
                values.push(branchId);
            }
            if (departmentId) {
                conditions.push(`e.department_id = $${p++}`);
                values.push(departmentId);
            }

            // Join with employees for department filter and employee info
            const query = `
                SELECT a.*, e.employee_code, e.first_name, e.last_name, e.department_id, e.branch_id,
                       s.timezone AS shift_timezone,
                       b.branch_name,
                       b.country  AS branch_country,
                       c.country  AS company_country
                FROM attendance a
                JOIN employees e ON a.employee_id = e.id
                LEFT JOIN shifts s ON s.id = e.shift_id
                LEFT JOIN branches b ON b.id = e.branch_id
                LEFT JOIN companies c ON c.id = a.company_id
                WHERE ${conditions.join(" AND ")}
                ORDER BY a.attendance_date, e.employee_code
            `;
            const result = await db.query(query, values);

            const formattedRows = result.rows.map((row) => {
                const { branch_country, company_country, ...rest } = row;
                const localTz = tzOf(row, timezone);
                const local = (d) => (d ? toLocalISOString(d, localTz) : null);
                const company = (d) => (d ? toLocalISOString(d, timezone) : null);

                // check_in / check_out: the employee's own clock (their shift's
                // timezone). When the company keeps a different clock, the same
                // moments in company time ride along, so a head office reads
                // both without converting.
                const differs =
                    (row.check_in && local(row.check_in) !== company(row.check_in)) ||
                    (row.check_out && local(row.check_out) !== company(row.check_out));

                return {
                    ...rest,
                    check_in: local(row.check_in),
                    check_out: local(row.check_out),
                    local_time_label: differs ? placeLabel(branch_country, localTz) : null,
                    company_time_label: differs ? placeLabel(company_country, timezone) : null,
                    check_in_company: differs ? company(row.check_in) : null,
                    check_out_company: differs ? company(row.check_out) : null,
                    attendance_date: dateKey(row.attendance_date),
                };
            });

            return { success: true, data: formattedRows };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = AttendanceReportService;