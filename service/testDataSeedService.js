// service/testDataSeedService.js
//
// Generates a month of realistic attendance, holidays and leave requests so
// payroll can be exercised end to end without hand-building test data.
//
// The point is NOT just random noise. Random attendance almost never produces
// the cases that actually break payroll — a half day either side of a weekend,
// a genuine sandwich, a mid-month joiner. So the seeder plants those
// deliberately (`guarantee_scenarios`) and fills the remaining days randomly.
//
// Deterministic: the same `seed` always produces the same month, so a payroll
// bug found once can be reproduced exactly.
//
// TEST UTILITY — refuses to run in production unless explicitly allowed.

const db = require("../config/database");
const { getDateRange, buildShift } = require("./payrollEngineService");

// ============================================================
// Deterministic PRNG (mulberry32) — small, fast, seedable.
// Math.random() cannot be seeded, and an unreproducible payroll
// bug is barely worth reporting.
// ============================================================
function makeRandom(seed) {
    let a = seed >>> 0;
    return function random() {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const between = (rnd, min, max) => min + rnd() * (max - min);

// ============================================================
// The scenarios worth guaranteeing. Each is a payroll rule that
// is easy to get wrong and hard to hit by chance.
// ============================================================
const SCENARIOS = {
    HALF_DAY_SANDWICH: "half_day_around_week_off",
    REAL_SANDWICH: "absent_around_week_off",
    MIXED_SANDWICH_ABSENT: "mixed_sandwich_absent_side",
    MIXED_SANDWICH_HALF: "mixed_sandwich_half_day_side",
    LATE_ARRIVAL: "late_arrival",
    OVERTIME: "overtime",
    COMP_OFF: "comp_off",
    PAID_LEAVE: "paid_full_day_leave",
    PAID_HALF_LEAVE: "paid_half_day_leave",
    UNPAID_LEAVE: "unpaid_full_day_leave",
    UNPAID_HALF_LEAVE: "unpaid_half_day_leave",
    ABSENT: "plain_absence",
};

// ============================================================
// DB helpers
// ============================================================

async function fetchEmployees(company_id, employee_ids) {
    const params = [company_id];
    let idClause = "";
    if (employee_ids && employee_ids.length) {
        params.push(employee_ids);
        idClause = `AND e.id = ANY($2::uuid[])`;
    }
    const result = await db.query(
        `SELECT e.id, e.employee_code, e.first_name, e.last_name,
                e.branch_id, e.shift_id,
                e.joining_date::date::text AS joining_date,
                e.exit_date::date::text    AS exit_date,
                s.start_time, s.end_time, s.working_hours, s.half_day_hours,
                s.monday, s.tuesday, s.wednesday, s.thursday,
                s.friday, s.saturday, s.sunday
         FROM employees e
         LEFT JOIN shifts s ON e.shift_id = s.id
         WHERE e.company_id = $1
           AND e.deleted_at IS NULL
           AND e.is_active = TRUE
           ${idClause}
         ORDER BY e.employee_code NULLS LAST, e.first_name`,
        params
    );
    return result.rows;
}

async function fetchLeaveTypes(company_id) {
    const result = await db.query(
        `SELECT id, leave_name, is_paid FROM leave_types
         WHERE company_id = $1 AND is_active = TRUE AND deleted_at IS NULL`,
        [company_id]
    );
    return {
        paid: result.rows.find((t) => t.is_paid) || null,
        unpaid: result.rows.find((t) => !t.is_paid) || null,
    };
}

// `client` matters: the seeder creates holidays inside an open transaction,
// and a plain db.query() borrows a DIFFERENT pooled connection that cannot see
// uncommitted rows. Reading them back on another connection silently returned
// zero holidays, so seeded holiday dates were overwritten with attendance.
async function fetchHolidays(company_id, start, end, client = db) {
    const result = await client.query(
        `SELECT holiday_start_date, holiday_end_date, branch_id, is_company_wide
         FROM holidays
         WHERE company_id = $1 AND is_active = TRUE AND deleted_at IS NULL
           AND holiday_start_date <= $3 AND holiday_end_date >= $2`,
        [company_id, start, end]
    );
    const set = new Set();
    for (const row of result.rows) {
        getDateRange(row.holiday_start_date, row.holiday_end_date).forEach((d) => set.add(d));
    }
    return set;
}

// ============================================================
// Attendance row builders
// ============================================================

function timestampFor(date, timeStr, offsetHours = 0) {
    const [h, m] = String(timeStr || "09:00:00").split(":").map(Number);
    const d = new Date(`${date}T00:00:00.000Z`);
    d.setUTCHours(h, m || 0, 0, 0);
    if (offsetHours) d.setUTCMinutes(d.getUTCMinutes() + Math.round(offsetHours * 60));
    return d.toISOString();
}

/**
 * A worked day. `hours` drives everything downstream — payroll reads
 * total_hours to decide half day vs full day vs overtime.
 */
function workedDay({ date, employee, shift, hours, lateMinutes = 0, remarks = null }) {
    const checkIn = timestampFor(date, employee.start_time, lateMinutes / 60);
    const checkOut = timestampFor(date, employee.start_time, lateMinutes / 60 + hours);

    let attendanceStatus = "on-time";
    if (lateMinutes > 5) attendanceStatus = "late";
    else if (lateMinutes < -5) attendanceStatus = "before-time";

    return {
        date,
        status: "checked-out",
        attendance_status: attendanceStatus,
        check_in: checkIn,
        check_out: checkOut,
        total_hours: parseFloat(hours.toFixed(2)),
        remarks: remarks || `Seeded — worked ${hours.toFixed(2)}h`,
    };
}

const nonWorkedDay = (date, status, remarks) => ({
    date, status, attendance_status: null,
    check_in: null, check_out: null, total_hours: null,
    remarks: remarks || `Seeded — ${status}`,
});

// ============================================================
// SERVICE
// ============================================================
const TestDataSeedService = {

    /**
     * Seed a month of attendance for the given employees.
     *
     * @param {string}   data.company_id
     * @param {string}   data.user_id            approver for seeded leave requests
     * @param {string[]} [data.employee_ids]     omit → every active employee
     * @param {number}   data.month              1-12
     * @param {number}   data.year
     * @param {number}   [data.seed]             omit → random, and returned so you can replay
     * @param {boolean}  [data.clear_existing]   wipe the month first
     * @param {boolean}  [data.create_holidays]  add 1–2 holidays to the month
     * @param {boolean}  [data.create_leaves]    add approved leave requests
     * @param {boolean}  [data.guarantee_scenarios] plant the tricky payroll cases
     */
    async seedAttendance(data) {
        const {
            company_id,
            user_id,
            employee_ids = null,
            month,
            year,
            clear_existing = true,
            create_holidays = true,
            create_leaves = true,
            guarantee_scenarios = true,
        } = data;

        // ── Validate ─────────────────────────────────────────
        const m = parseInt(month, 10);
        const y = parseInt(year, 10);
        if (!m || m < 1 || m > 12) return { success: false, message: "month must be between 1 and 12" };
        if (!y || y < 2000 || y > 2100) return { success: false, message: "year must be between 2000 and 2100" };

        // Seeded leave requests are created already-approved, and the schema
        // requires an approver on an approved row. Catch a missing user_id here
        // rather than letting it surface as a raw check-constraint violation.
        if (create_leaves && !user_id) {
            return {
                success: false,
                message: "user_id is required to create approved leave requests"
                    + " (it becomes approved_by). Pass create_leaves: false to skip them.",
            };
        }

        const seed = Number.isFinite(parseInt(data.seed, 10))
            ? parseInt(data.seed, 10)
            : Math.floor(Math.random() * 1e9);
        const rnd = makeRandom(seed);

        const startDate = `${y}-${String(m).padStart(2, "0")}-01`;
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const endDate = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

        const client = await db.getClient();

        try {
            const employees = await fetchEmployees(company_id, employee_ids);
            if (employees.length === 0) {
                return { success: false, message: "No active employees found for the given ids" };
            }

            const leaveTypes = await fetchLeaveTypes(company_id);
            const warnings = [];
            if (create_leaves && !leaveTypes.paid) {
                warnings.push("No active PAID leave type — paid-leave scenarios were skipped");
            }
            if (create_leaves && !leaveTypes.unpaid) {
                warnings.push("No active UNPAID leave type — unpaid-leave scenarios were skipped");
            }

            await client.query("BEGIN");

            // ── Wipe the month so re-running is idempotent ────
            if (clear_existing) {
                await client.query(
                    `DELETE FROM attendance
                     WHERE company_id = $1 AND employee_id = ANY($2::uuid[])
                       AND attendance_date BETWEEN $3 AND $4`,
                    [company_id, employees.map((e) => e.id), startDate, endDate]
                );
                await client.query(
                    `DELETE FROM leave_requests
                     WHERE company_id = $1 AND employee_id = ANY($2::uuid[])
                       AND from_date <= $4 AND to_date >= $3
                       AND reason LIKE '[SEED]%'`,
                    [company_id, employees.map((e) => e.id), startDate, endDate]
                );
                await client.query(
                    `DELETE FROM holidays
                     WHERE company_id = $1 AND holiday_start_date BETWEEN $2 AND $3
                       AND holiday_name LIKE '[SEED]%'`,
                    [company_id, startDate, endDate]
                );
            }

            // ── Holidays ─────────────────────────────────────
            const createdHolidays = [];
            if (create_holidays) {
                // Mid-month, so a holiday never lands on the period edge where
                // the sandwich rule deliberately declines to guess.
                const candidates = [8, 14, 21].filter((d) => d <= lastDay);
                const count = 1 + Math.floor(rnd() * 2);
                for (let i = 0; i < count && i < candidates.length; i++) {
                    const day = candidates[i];
                    const date = `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                    const row = await client.query(
                        `INSERT INTO holidays
                            (company_id, holiday_name, holiday_type,
                             holiday_start_date, holiday_end_date, is_company_wide, is_active)
                         VALUES ($1, $2, 'public', $3, $3, TRUE, TRUE)
                         RETURNING id, holiday_name, holiday_start_date::date::text AS date`,
                        [company_id, `[SEED] Test Holiday ${i + 1}`, date]
                    );
                    createdHolidays.push(row.rows[0]);
                }
            }

            const holidaySet = await fetchHolidays(company_id, startDate, endDate, client);
            const allDates = getDateRange(startDate, endDate);

            // ── Per employee ─────────────────────────────────
            const summary = [];
            const createdLeaves = [];
            let totalRows = 0;

            for (let idx = 0; idx < employees.length; idx++) {
                const employee = employees[idx];
                const shift = buildShift(employee);

                const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
                const weekOffDays = new Set([0, 1, 2, 3, 4, 5, 6].filter((d) => !shift[dayNames[d]]));

                const isWeekOff = (date) =>
                    weekOffDays.has(new Date(`${date}T00:00:00.000Z`).getUTCDay());
                const isWorkable = (date) => !isWeekOff(date) && !holidaySet.has(date);

                // The planned scenarios for this employee, keyed by date.
                const planned = {};
                const applied = [];

                if (guarantee_scenarios) {
                    Object.assign(planned, planScenarios({
                        allDates, isWeekOff, isWorkable, employeeIndex: idx, rnd, applied,
                    }));
                }

                // ── Build a row for every day ────────────────
                const rows = [];
                const leaveDays = [];

                for (const date of allDates) {
                    // Outside employment — leave the day blank rather than
                    // inventing attendance for someone who had not joined.
                    if ((employee.joining_date && date < employee.joining_date)
                        || (employee.exit_date && date > employee.exit_date)) {
                        continue;
                    }

                    if (holidaySet.has(date)) {
                        rows.push(nonWorkedDay(date, "holiday", "Seeded — company holiday"));
                        continue;
                    }
                    if (isWeekOff(date)) {
                        rows.push(nonWorkedDay(date, "week-off", "Seeded — shift week-off"));
                        continue;
                    }

                    const plan = planned[date];

                    if (plan === SCENARIOS.HALF_DAY_SANDWICH || plan === SCENARIOS.MIXED_SANDWICH_HALF) {
                        const half = Math.max(1, (parseFloat(shift.half_day_hours) || 4) - 1);
                        rows.push(workedDay({
                            date, employee, shift, hours: half,
                            remarks: `[SCENARIO] ${plan} — half day, must NOT trigger a sandwich`,
                        }));
                        continue;
                    }
                    if (plan === SCENARIOS.REAL_SANDWICH
                        || plan === SCENARIOS.MIXED_SANDWICH_ABSENT
                        || plan === SCENARIOS.ABSENT) {
                        rows.push(nonWorkedDay(date, "absent", `[SCENARIO] ${plan}`));
                        continue;
                    }
                    if (plan === SCENARIOS.LATE_ARRIVAL) {
                        rows.push(workedDay({
                            date, employee, shift,
                            hours: parseFloat(shift.working_hours) || 8,
                            lateMinutes: 45,
                            remarks: "[SCENARIO] late_arrival — 45 minutes late",
                        }));
                        continue;
                    }
                    if (plan === SCENARIOS.OVERTIME) {
                        rows.push(workedDay({
                            date, employee, shift,
                            hours: (parseFloat(shift.working_hours) || 8) + 3,
                            remarks: "[SCENARIO] overtime — 3 extra hours",
                        }));
                        continue;
                    }
                    if (plan === SCENARIOS.COMP_OFF) {
                        rows.push(nonWorkedDay(date, "comp-off",
                            "[SCENARIO] comp_off — earned, must stay paid and never be sandwiched"));
                        continue;
                    }
                    if (typeof plan === "string" && plan.endsWith("leave")) {
                        // Attendance says 'leave'; the approved request below is
                        // what tells payroll whether it is paid.
                        rows.push(nonWorkedDay(date, "leave", `[SCENARIO] ${plan}`));
                        leaveDays.push({ date, scenario: plan });
                        continue;
                    }

                    // ── Unplanned day: weighted random ───────
                    const roll = rnd();
                    const fullHours = parseFloat(shift.working_hours) || 8;
                    const halfThreshold = parseFloat(shift.half_day_hours) || 4;

                    if (roll < 0.70) {
                        rows.push(workedDay({
                            date, employee, shift,
                            hours: between(rnd, fullHours - 0.25, fullHours + 1.5),
                            lateMinutes: rnd() < 0.2 ? Math.round(between(rnd, 10, 60)) : Math.round(between(rnd, -20, 5)),
                        }));
                    } else if (roll < 0.82) {
                        rows.push(workedDay({
                            date, employee, shift,
                            hours: between(rnd, fullHours + 2, fullHours + 4),
                            remarks: "Seeded — overtime",
                        }));
                    } else if (roll < 0.90) {
                        rows.push(workedDay({
                            date, employee, shift,
                            hours: between(rnd, 1, Math.max(1.5, halfThreshold - 0.5)),
                            remarks: "Seeded — half day (below threshold)",
                        }));
                    } else if (roll < 0.96) {
                        rows.push(nonWorkedDay(date, "absent"));
                    } else {
                        rows.push(nonWorkedDay(date, "comp-off"));
                    }
                }

                // ── Insert attendance ────────────────────────
                if (rows.length) {
                    const values = [];
                    const placeholders = rows.map((r, i) => {
                        const b = i * 10;
                        values.push(
                            company_id, employee.branch_id, employee.id, r.date,
                            r.check_in, r.check_out, r.total_hours,
                            r.attendance_status, r.status, r.remarks
                        );
                        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10})`;
                    });

                    await client.query(
                        `INSERT INTO attendance
                            (company_id, branch_id, employee_id, attendance_date,
                             check_in, check_out, total_hours,
                             attendance_status, status, remarks)
                         VALUES ${placeholders.join(",")}
                         ON CONFLICT (employee_id, attendance_date) DO UPDATE SET
                            check_in = EXCLUDED.check_in,
                            check_out = EXCLUDED.check_out,
                            total_hours = EXCLUDED.total_hours,
                            attendance_status = EXCLUDED.attendance_status,
                            status = EXCLUDED.status,
                            remarks = EXCLUDED.remarks`,
                        values
                    );
                    totalRows += rows.length;
                }

                // ── Approved leave requests ──────────────────
                if (create_leaves && employee.branch_id) {
                    for (const { date, scenario } of leaveDays) {
                        const isPaid = scenario.startsWith("paid");
                        const isHalf = scenario.includes("half");
                        const type = isPaid ? leaveTypes.paid : leaveTypes.unpaid;
                        if (!type) continue;

                        const row = await client.query(
                            `INSERT INTO leave_requests
                                (company_id, branch_id, employee_id, leave_type_id,
                                 from_date, to_date, total_days, is_half_day,
                                 reason, status, approved_by, approved_at)
                             VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,'approved',$9,NOW())
                             RETURNING id, from_date::date::text AS date, is_half_day`,
                            [company_id, employee.branch_id, employee.id, type.id,
                                date, isHalf ? 0.5 : 1, isHalf,
                                `[SEED] ${scenario}`, user_id]
                        );
                        createdLeaves.push({
                            ...row.rows[0],
                            employee_code: employee.employee_code,
                            leave_type: type.leave_name,
                            is_paid: type.is_paid,
                            scenario,
                        });
                    }
                }

                summary.push({
                    employee_id: employee.id,
                    employee_code: employee.employee_code,
                    name: `${employee.first_name} ${employee.last_name}`.trim(),
                    shift: employee.shift_id ? "assigned" : "none (engine defaults apply)",
                    week_off_days: [...weekOffDays].map((d) => dayNames[d]),
                    attendance_rows: rows.length,
                    scenarios_planted: applied,
                });
            }

            await client.query("COMMIT");

            return {
                success: true,
                message: `Seeded ${totalRows} attendance row(s) for ${employees.length} employee(s)`
                    + ` across ${startDate} → ${endDate}`,
                data: {
                    seed,
                    replay_hint: `Pass "seed": ${seed} to regenerate this exact month`,
                    period: { month: m, year: y, start_date: startDate, end_date: endDate, total_days: allDates.length },
                    employee_count: employees.length,
                    attendance_rows: totalRows,
                    holidays_created: createdHolidays,
                    leaves_created: createdLeaves,
                    warnings,
                    employees: summary,
                    next_step: {
                        message: "Now run payroll for this period",
                        create_run: `POST /api/companies/${company_id}/payroll-runs`,
                        body: { period_name: `${startDate.slice(0, 7)} (seeded)`, start_date: startDate, end_date: endDate },
                    },
                },
            };
        } catch (error) {
            await client.query("ROLLBACK").catch(() => { });
            return { success: false, message: error.message, error };
        } finally {
            client.release();
        }
    },

    /** Remove everything a previous seed created for a month. */
    async clearSeededData({ company_id, month, year, employee_ids = null }) {
        const m = parseInt(month, 10);
        const y = parseInt(year, 10);
        if (!m || m < 1 || m > 12) return { success: false, message: "month must be between 1 and 12" };
        if (!y) return { success: false, message: "year is required" };

        const startDate = `${y}-${String(m).padStart(2, "0")}-01`;
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        const endDate = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

        const client = await db.getClient();
        try {
            const employees = await fetchEmployees(company_id, employee_ids);
            const ids = employees.map((e) => e.id);

            await client.query("BEGIN");
            const att = await client.query(
                `DELETE FROM attendance
                 WHERE company_id = $1 AND employee_id = ANY($2::uuid[])
                   AND attendance_date BETWEEN $3 AND $4`,
                [company_id, ids, startDate, endDate]
            );
            const lv = await client.query(
                `DELETE FROM leave_requests
                 WHERE company_id = $1 AND employee_id = ANY($2::uuid[])
                   AND from_date <= $4 AND to_date >= $3 AND reason LIKE '[SEED]%'`,
                [company_id, ids, startDate, endDate]
            );
            const hol = await client.query(
                `DELETE FROM holidays
                 WHERE company_id = $1 AND holiday_start_date BETWEEN $2 AND $3
                   AND holiday_name LIKE '[SEED]%'`,
                [company_id, startDate, endDate]
            );
            await client.query("COMMIT");

            return {
                success: true,
                message: `Cleared ${att.rowCount} attendance row(s), ${lv.rowCount} seeded leave(s)`
                    + ` and ${hol.rowCount} seeded holiday(s)`,
                data: {
                    period: { start_date: startDate, end_date: endDate },
                    attendance_deleted: att.rowCount,
                    leaves_deleted: lv.rowCount,
                    holidays_deleted: hol.rowCount,
                },
            };
        } catch (error) {
            await client.query("ROLLBACK").catch(() => { });
            return { success: false, message: error.message, error };
        } finally {
            client.release();
        }
    },

    SCENARIOS,
};

// ============================================================
// Scenario planner
//
// Finds real dates in the month that satisfy each scenario's shape.
// Employee 0 always gets the three sandwich cases — those are the
// ones the payroll engine gets wrong most easily, so they must be
// present even when seeding a single employee.
// ============================================================
function planScenarios({ allDates, isWeekOff, isWorkable, employeeIndex, rnd, applied }) {
    const planned = {};

    // Every stretch of week-off days that has a workable day on both sides.
    const bridges = [];
    for (let i = 1; i < allDates.length - 1; i++) {
        if (!isWeekOff(allDates[i])) continue;
        const start = i;
        while (i < allDates.length && isWeekOff(allDates[i])) i++;
        const end = i - 1;
        const before = allDates[start - 1];
        const after = allDates[end + 1];
        if (before && after && isWorkable(before) && isWorkable(after)) {
            bridges.push({ before, after });
        }
    }

    const claim = (date, scenario) => {
        if (!date || planned[date]) return false;
        planned[date] = scenario;
        if (!applied.includes(scenario)) applied.push(scenario);
        return true;
    };

    // ── The three sandwich cases, on separate weekends ───────
    if (bridges[0]) {
        // Half day either side — the reported bug. Must NOT be sandwiched.
        claim(bridges[0].before, SCENARIOS.HALF_DAY_SANDWICH);
        claim(bridges[0].after, SCENARIOS.HALF_DAY_SANDWICH);
    }
    if (bridges[1]) {
        // Absent either side — a genuine sandwich. The week-off SHOULD be unpaid.
        claim(bridges[1].before, SCENARIOS.REAL_SANDWICH);
        claim(bridges[1].after, SCENARIOS.REAL_SANDWICH);
    }
    if (bridges[2]) {
        // One full absence, one half day. Must NOT be sandwiched — a sandwich
        // needs a full day of lost pay on BOTH sides.
        claim(bridges[2].before, SCENARIOS.MIXED_SANDWICH_ABSENT);
        claim(bridges[2].after, SCENARIOS.MIXED_SANDWICH_HALF);
    }

    // ── The rest, spread over remaining workable days ────────
    const free = allDates.filter((d) => isWorkable(d) && !planned[d]);
    const rest = [
        SCENARIOS.LATE_ARRIVAL,
        SCENARIOS.OVERTIME,
        SCENARIOS.COMP_OFF,
        SCENARIOS.PAID_LEAVE,
        SCENARIOS.PAID_HALF_LEAVE,
        SCENARIOS.UNPAID_LEAVE,
        SCENARIOS.UNPAID_HALF_LEAVE,
        SCENARIOS.ABSENT,
    ];

    // Offset by employee so two employees do not get identical months.
    let cursor = Math.floor(rnd() * Math.max(1, free.length)) + employeeIndex;
    for (const scenario of rest) {
        for (let attempt = 0; attempt < free.length; attempt++) {
            const date = free[(cursor + attempt * 2) % free.length];
            if (claim(date, scenario)) {
                cursor = (cursor + attempt * 2 + 3) % Math.max(1, free.length);
                break;
            }
        }
    }

    return planned;
}

module.exports = TestDataSeedService;
