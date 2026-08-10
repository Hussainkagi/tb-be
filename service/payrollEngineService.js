// service/payrollEngineService.js
//
// Single source of truth for day classification and money.
// payrollService (generation) and payrollBreakdownService (snapshot read /
// backfill) both call buildDailyBreakdown — never duplicate this logic.
//
// Two invariants hold for every day, and the rest of the module relies on them:
//
//   1.  pay_fraction + deduct_fraction === 1
//   2.  sum(payable_amount) + sum(deduction_amount) === gross_salary
//
// which makes net = sum(payable) + overtime, with no separate
// "gross minus deductions" formula that can drift out of sync.

// ============================================================
// DATE HELPERS — all UTC
//
// `new Date("2026-08-03")` parses as UTC midnight, but getDay()/getDate()
// read in LOCAL time. On any server west of UTC that returns the PREVIOUS
// day, so every week-off landed one day early and the whole classification
// shifted. Everything below stays in UTC end to end.
// ============================================================

function toUTCDate(value) {
    if (value instanceof Date) {
        return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
    }
    const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
}

function toDateString(value) {
    return toUTCDate(value).toISOString().slice(0, 10);
}

function getDateRange(start, end) {
    const dates = [];
    const cursor = toUTCDate(start);
    const last = toUTCDate(end);
    while (cursor <= last) {
        dates.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return dates;
}

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function dayOfWeek(dateStr) {
    return toUTCDate(dateStr).getUTCDay();
}

const round2 = (n) => parseFloat((Number(n) || 0).toFixed(2));
const round4 = (n) => parseFloat((Number(n) || 0).toFixed(4));

// ============================================================
// DAY TYPES
// ============================================================
const DAY_TYPE = Object.freeze({
    HOLIDAY: "holiday",
    WEEK_OFF: "week_off",
    COMP_OFF: "comp_off",
    PAID_LEAVE: "paid_leave",
    HALF_DAY_LEAVE: "half_day_leave",
    UNPAID_LEAVE: "unpaid_leave",
    HALF_DAY_UNPAID_LEAVE: "half_day_unpaid_leave",
    PRESENT: "present",
    HALF_DAY: "half_day",
    ABSENT: "absent",
    SANDWICH: "sandwich",
    NOT_EMPLOYED: "not_employed",
});

// Day types that represent a FULL day of lost pay. Only these may act as
// the bookends of a sandwich — a half day is half attendance, not an
// absence, and must never swallow the week-off next to it.
const FULL_LOSS_TYPES = new Set([
    DAY_TYPE.ABSENT,
    DAY_TYPE.UNPAID_LEAVE,
    DAY_TYPE.SANDWICH,
]);

// ============================================================
// SETTINGS
// ============================================================
const DEFAULT_SETTINGS = Object.freeze({
    per_day_basis: "calendar_days",
    sandwich_enabled: true,
    sandwich_applies_to: "week_off",
    sandwich_requires_full_day: true,
    sandwich_max_bridge_days: 2,
    half_day_leave_is_payable: true,
    prorate_joiners_leavers: true,
    overtime_on_off_days: true,
});

function normalizeSettings(settings) {
    return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

function buildShift(row) {
    return {
        working_hours: parseFloat(row?.working_hours) || 8,
        half_day_hours: parseFloat(row?.half_day_hours) || 0,
        monday: row?.monday ?? true,
        tuesday: row?.tuesday ?? true,
        wednesday: row?.wednesday ?? true,
        thursday: row?.thursday ?? true,
        friday: row?.friday ?? true,
        saturday: row?.saturday ?? false,
        sunday: row?.sunday ?? false,
    };
}

// ============================================================
// SANDWICH LEAVE
//
// A sandwich is a maximal run of *bridgeable* off-days (week-offs, and
// holidays only if the company opts in) that is flanked on BOTH sides by a
// full day of lost pay. Those bridged days then become unpaid too.
//
// What changed, and why the old version was wrong:
//   • Bookends now have to be FULL-day losses. Previously every date in
//     `deductDates` qualified, and a half day (worked short hours, or an
//     unpaid half-day leave) lands in that set — so "half day Saturday,
//     half day Monday" made Sunday unpaid. That is not a sandwich.
//   • comp-off is never bridgeable. It was earned by working; swallowing it
//     takes back pay the employee already worked for.
//   • Holidays are opt-in via sandwich_applies_to. Most policies bridge
//     week-offs only.
//   • The bridge has a maximum length, so a single absence either side of a
//     long shutdown cannot zero out the whole stretch.
// ============================================================
function findSandwichDates(allDates, classification, settings) {
    const sandwiched = new Set();
    if (!settings.sandwich_enabled) return sandwiched;

    const bridgeable = new Set();
    if (settings.sandwich_applies_to === "week_off" || settings.sandwich_applies_to === "both") {
        bridgeable.add(DAY_TYPE.WEEK_OFF);
    }
    if (settings.sandwich_applies_to === "holiday" || settings.sandwich_applies_to === "both") {
        bridgeable.add(DAY_TYPE.HOLIDAY);
    }
    if (bridgeable.size === 0) return sandwiched;

    const isBridgeable = (date) => bridgeable.has(classification[date]?.type);

    const isBookend = (date) => {
        const cls = classification[date];
        if (!cls) return false;
        if (!FULL_LOSS_TYPES.has(cls.type)) return false;
        // With the strict rule a bookend must lose a whole day's pay.
        // Relaxed, any deductible day (including a half day) counts.
        if (settings.sandwich_requires_full_day) return (cls.deductFraction || 0) >= 1;
        return (cls.deductFraction || 0) > 0;
    };

    let i = 0;
    while (i < allDates.length) {
        if (!isBridgeable(allDates[i])) {
            i++;
            continue;
        }

        const runStart = i;
        while (i < allDates.length && isBridgeable(allDates[i])) i++;
        const runEnd = i - 1;
        const runLength = runEnd - runStart + 1;

        // A run touching either edge of the period has no visible bookend
        // on that side — we cannot see the neighbouring period, so we do
        // not guess. Same reason the run length is capped.
        if (runStart === 0 || runEnd === allDates.length - 1) continue;
        if (runLength > settings.sandwich_max_bridge_days) continue;

        if (isBookend(allDates[runStart - 1]) && isBookend(allDates[runEnd + 1])) {
            for (let j = runStart; j <= runEnd; j++) sandwiched.add(allDates[j]);
        }
    }

    return sandwiched;
}

// ============================================================
// ROUNDING RECONCILIATION
//
// A daily rate rarely divides evenly: 14,500 / 31 = 467.741935…, and 31 rows
// each rounded to 467.74 sum to 14,499.94 — six fils short of gross. Small,
// but it means the day-by-day breakdown visibly disagrees with the salary it
// is explaining, and the two net-salary formulas (sum of payable vs
// gross − deductions) drift apart by the same amount.
//
// Largest-remainder allocation fixes it: floor every cell to the cent, then
// hand the leftover cents to the rows with the largest discarded fraction.
// Every row stays within a cent of its true value and the column totals are
// exact. This is the standard apportionment method — the alternative,
// dumping the whole residual on the last day, makes one arbitrary day look
// different from its identical neighbours.
// ============================================================
function allocateCents(exactValues, targetCents) {
    const floors = exactValues.map((v) => Math.floor(v * 100));
    const remainders = exactValues.map((v, i) => ({ i, frac: v * 100 - floors[i] }));

    let leftover = targetCents - floors.reduce((a, b) => a + b, 0);

    // Hand out (or claw back) one cent at a time, largest fraction first.
    remainders.sort((a, b) => b.frac - a.frac);
    const step = leftover >= 0 ? 1 : -1;
    for (let k = 0; leftover !== 0 && k < remainders.length * 2; k++) {
        const target = remainders[k % remainders.length].i;
        // Never push a cell below zero — a negative payable is nonsense.
        if (step < 0 && floors[target] <= 0) continue;
        floors[target] += step;
        leftover -= step;
    }

    return floors.map((c) => c / 100);
}

// ============================================================
// PER-DAY RATE
// ============================================================
function resolvePerDaySalary(grossSalary, allDates, offDayCount, settings) {
    switch (settings.per_day_basis) {
        case "fixed_30":
            return grossSalary / 30;
        case "working_days": {
            const workingDays = allDates.length - offDayCount;
            return workingDays > 0 ? grossSalary / workingDays : 0;
        }
        case "calendar_days":
        default:
            return allDates.length > 0 ? grossSalary / allDates.length : 0;
    }
}

// ============================================================
// MAIN — build the day-by-day breakdown + summary
//
// @param {Object}  input
// @param {Object}  input.period            { start_date, end_date }
// @param {Object}  input.shift             from buildShift()
// @param {Object}  input.salaryStructure   employee_salary_structures row
// @param {Object}  input.attendanceMap     date → attendance row
// @param {Array}   input.approvedLeaves    leave_requests joined with leave_types
// @param {Set}     input.holidaySet        date strings
// @param {Object} [input.employee]         needs joining_date / exit_date to prorate
// @param {Object} [input.settings]         payroll_settings row
// @returns {{ daily: Array, summary: Object }}
// ============================================================
function buildDailyBreakdown(input) {
    const {
        period,
        shift,
        salaryStructure,
        attendanceMap = {},
        approvedLeaves = [],
        holidaySet = new Set(),
        employee = null,
    } = input;

    const settings = normalizeSettings(input.settings);
    const allDates = getDateRange(period.start_date, period.end_date);

    // ── Salary components ────────────────────────────────────
    const basicSalary = parseFloat(salaryStructure.actual_salary) || 0;
    const housingAllowance = parseFloat(salaryStructure.housing_allowance) || 0;
    const transportAllowance = parseFloat(salaryStructure.transport_allowance) || 0;
    const otherAllowance = parseFloat(salaryStructure.other_allowance) || 0;
    const grossSalary = basicSalary + housingAllowance + transportAllowance + otherAllowance;

    // ── Week-off calendar ────────────────────────────────────
    const weekOffDays = new Set([0, 1, 2, 3, 4, 5, 6].filter((d) => !shift[DAY_NAMES[d]]));

    // ── Employment window (proration) ────────────────────────
    const joiningDate = settings.prorate_joiners_leavers && employee?.joining_date
        ? toDateString(employee.joining_date)
        : null;
    const exitDate = settings.prorate_joiners_leavers && employee?.exit_date
        ? toDateString(employee.exit_date)
        : null;

    // ── Approved leave lookup ────────────────────────────────
    // Half-day flags live on the request, so a multi-day request marked
    // half_day applies the half to every date in its range.
    const leaveDateMap = {};
    for (const leave of approvedLeaves) {
        for (const d of getDateRange(leave.from_date, leave.to_date)) {
            leaveDateMap[d] = {
                is_paid: leave.is_paid,
                is_half_day: leave.is_half_day,
                leave_type: leave.leave_name || null,
            };
        }
    }

    // ── Classify every date ──────────────────────────────────
    const classification = {};
    let offDayCount = 0;

    for (const date of allDates) {
        const isWeekOff = weekOffDays.has(dayOfWeek(date));
        const isHoliday = holidaySet.has(date);
        const attendance = attendanceMap[date];
        const leaveInfo = leaveDateMap[date];

        // Outside the employment window — not absence, just not employed.
        // Unpaid, but never a sandwich bookend and never counted as absent.
        if ((joiningDate && date < joiningDate) || (exitDate && date > exitDate)) {
            classification[date] = {
                type: DAY_TYPE.NOT_EMPLOYED,
                payFraction: 0,
                deductFraction: 1,
                remarks: joiningDate && date < joiningDate ? "Before joining date" : "After exit date",
            };
            continue;
        }

        if (isHoliday) {
            offDayCount++;
            classification[date] = { type: DAY_TYPE.HOLIDAY, payFraction: 1, deductFraction: 0 };
        } else if (isWeekOff) {
            offDayCount++;
            classification[date] = { type: DAY_TYPE.WEEK_OFF, payFraction: 1, deductFraction: 0 };
        } else if (leaveInfo) {
            if (leaveInfo.is_paid) {
                // A paid half-day leave is half leave + half worked, so the
                // day is fully payable. It used to be booked at 0.5 pay with
                // no matching deduction, which broke the gross invariant.
                const payable = leaveInfo.is_half_day && !settings.half_day_leave_is_payable ? 0.5 : 1;
                classification[date] = {
                    type: leaveInfo.is_half_day ? DAY_TYPE.HALF_DAY_LEAVE : DAY_TYPE.PAID_LEAVE,
                    payFraction: payable,
                    deductFraction: round2(1 - payable),
                    remarks: leaveInfo.leave_type,
                };
            } else {
                const lost = leaveInfo.is_half_day ? 0.5 : 1;
                classification[date] = {
                    type: leaveInfo.is_half_day ? DAY_TYPE.HALF_DAY_UNPAID_LEAVE : DAY_TYPE.UNPAID_LEAVE,
                    payFraction: round2(1 - lost),
                    deductFraction: lost,
                    remarks: leaveInfo.leave_type,
                };
            }
        } else if (!attendance) {
            classification[date] = { type: DAY_TYPE.ABSENT, payFraction: 0, deductFraction: 1 };
        } else {
            classification[date] = classifyAttendanceDay(date, attendance, shift);
        }

        // ── Overtime — measured on any day with recorded hours ──
        // Previously only full present days earned overtime, so a short day
        // that ran long, or a week-off callout, silently paid nothing.
        if (salaryStructure.overtime_enabled && attendance) {
            const hours = parseFloat(attendance.total_hours) || 0;
            const cls = classification[date];
            const isOffDay = cls.type === DAY_TYPE.WEEK_OFF || cls.type === DAY_TYPE.HOLIDAY;

            if (isOffDay) {
                if (settings.overtime_on_off_days) cls.overtimeHours = round2(hours);
            } else {
                cls.overtimeHours = round2(Math.max(0, hours - (parseFloat(shift.working_hours) || 8)));
            }
            cls.totalHours = hours;
            cls.attendanceStatus = attendance.status;
        }
    }

    // ── Sandwich pass ────────────────────────────────────────
    for (const date of findSandwichDates(allDates, classification, settings)) {
        offDayCount--; // it stops being a paid off-day
        classification[date] = {
            ...classification[date],
            type: DAY_TYPE.SANDWICH,
            payFraction: 0,
            deductFraction: 1,
            remarks: "Sandwiched between full-day absences",
        };
    }

    // ── Money ────────────────────────────────────────────────
    const perDaySalary = resolvePerDaySalary(grossSalary, allDates, offDayCount, settings);
    const overtimeRate = parseFloat(salaryStructure.overtime_rate_per_hour) || 0;

    // Allocate payable and deduction together, against the one target that
    // matters — the money the period is worth. For the calendar-day basis that
    // target IS gross, so `payable + deduction === gross` becomes exact rather
    // than approximately true.
    const exactPayable = allDates.map((d) => perDaySalary * classification[d].payFraction);
    const exactDeduct = allDates.map((d) => perDaySalary * classification[d].deductFraction);
    const targetCents = Math.round(perDaySalary * allDates.length * 100);

    const allocated = allocateCents([...exactPayable, ...exactDeduct], targetCents);
    const payableByDay = allocated.slice(0, allDates.length);
    const deductByDay = allocated.slice(allDates.length);

    const dailyRows = allDates.map((date, i) => {
        const cls = classification[date];
        const overtimeHours = cls.overtimeHours || 0;
        const overtimeAmount = round2(overtimeHours * overtimeRate);
        const payableAmount = payableByDay[i];
        const deductionAmount = deductByDay[i];

        return {
            date,
            day_of_week: DAY_NAMES[dayOfWeek(date)],
            day_type: cls.type,
            per_day_salary: round4(perDaySalary),
            pay_fraction: cls.payFraction,
            deduct_fraction: cls.deductFraction,
            payable_amount: payableAmount,
            deduction_amount: deductionAmount,
            overtime_hours: overtimeHours,
            overtime_amount: overtimeAmount,
            net_day_amount: round2(payableAmount + overtimeAmount),
            total_hours: cls.totalHours ?? null,
            attendance_status: cls.attendanceStatus ?? null,
            is_sandwich: cls.type === DAY_TYPE.SANDWICH,
            remarks: cls.remarks ?? null,
        };
    });

    return { daily: dailyRows, summary: summarizeDailyRows(dailyRows, { grossSalary, basicSalary, perDaySalary }) };
}

// ── Attendance-driven classification for a working day ───────
function classifyAttendanceDay(date, attendance, shift) {
    const status = attendance.status;
    const hours = parseFloat(attendance.total_hours) || 0;
    const halfDayThreshold = parseFloat(shift.half_day_hours) || 0;

    if (status === "checked-in" || status === "checked-out") {
        if (halfDayThreshold > 0 && hours < halfDayThreshold) {
            return {
                type: DAY_TYPE.HALF_DAY,
                payFraction: 0.5,
                deductFraction: 0.5,
                totalHours: hours,
                attendanceStatus: status,
                remarks: `Worked ${hours}h, below the ${halfDayThreshold}h half-day threshold`,
            };
        }
        return {
            type: DAY_TYPE.PRESENT,
            payFraction: 1,
            deductFraction: 0,
            totalHours: hours,
            attendanceStatus: status,
        };
    }

    if (status === "comp-off") {
        // Earned by working elsewhere — fully paid, and deliberately not
        // bridgeable, so a sandwich can never claw it back.
        return { type: DAY_TYPE.COMP_OFF, payFraction: 1, deductFraction: 0, attendanceStatus: status };
    }

    if (status === "holiday") {
        return { type: DAY_TYPE.HOLIDAY, payFraction: 1, deductFraction: 0, attendanceStatus: status };
    }

    if (status === "week-off") {
        return { type: DAY_TYPE.WEEK_OFF, payFraction: 1, deductFraction: 0, attendanceStatus: status };
    }

    // 'absent', or 'leave' with no matching approved request → unpaid
    return {
        type: DAY_TYPE.ABSENT,
        payFraction: 0,
        deductFraction: 1,
        attendanceStatus: status,
        remarks: status === "leave" ? "Marked as leave with no approved leave request" : null,
    };
}

// ============================================================
// SUMMARY — the ONLY place daily rows are aggregated.
// Reused by payrollBreakdownService when it reads frozen lines
// back out of payroll_daily_lines.
// ============================================================
function summarizeDailyRows(rows, { grossSalary, basicSalary = 0, perDaySalary = 0 } = {}) {
    const acc = {
        total_payable: 0,
        total_deduction: 0,
        total_overtime_amt: 0,
        total_overtime_hrs: 0,
        total_present: 0,
        total_absent: 0,
        total_sandwich: 0,
        total_unpaid_leave: 0,
        total_paid_leave: 0,
        total_holidays: 0,
        total_week_off: 0,
        total_comp_off: 0,
        total_not_employed: 0,
        total_half_days: 0,
    };

    for (const row of rows) {
        const payFraction = parseFloat(row.pay_fraction) || 0;
        const deductFraction = parseFloat(row.deduct_fraction) || 0;

        acc.total_payable += parseFloat(row.payable_amount) || 0;
        acc.total_deduction += parseFloat(row.deduction_amount) || 0;
        acc.total_overtime_amt += parseFloat(row.overtime_amount) || 0;
        acc.total_overtime_hrs += parseFloat(row.overtime_hours) || 0;

        switch (row.day_type) {
            case DAY_TYPE.PRESENT:
                acc.total_present += 1;
                break;
            case DAY_TYPE.HALF_DAY:
                acc.total_present += 0.5;
                acc.total_half_days += 1;
                break;
            case DAY_TYPE.ABSENT:
                acc.total_absent += 1;
                break;
            case DAY_TYPE.SANDWICH:
                acc.total_sandwich += 1;
                break;
            case DAY_TYPE.UNPAID_LEAVE:
            case DAY_TYPE.HALF_DAY_UNPAID_LEAVE:
                acc.total_unpaid_leave += deductFraction;
                // The worked half of an unpaid half-day still counts as attendance
                acc.total_present += payFraction;
                break;
            case DAY_TYPE.PAID_LEAVE:
                acc.total_paid_leave += 1;
                break;
            case DAY_TYPE.HALF_DAY_LEAVE:
                acc.total_paid_leave += 0.5;
                acc.total_present += 0.5;
                break;
            case DAY_TYPE.HOLIDAY:
                acc.total_holidays += 1;
                break;
            case DAY_TYPE.WEEK_OFF:
                acc.total_week_off += 1;
                break;
            case DAY_TYPE.COMP_OFF:
                acc.total_comp_off += 1;
                break;
            case DAY_TYPE.NOT_EMPLOYED:
                acc.total_not_employed += 1;
                break;
            default:
                break;
        }
    }

    for (const key of Object.keys(acc)) acc[key] = round2(acc[key]);

    // Gross is normally handed in from the salary structure. When summarizing
    // frozen lines we can rebuild it, because payable + deduction === gross.
    const gross = round2(grossSalary ?? acc.total_payable + acc.total_deduction);

    const summary = {
        ...acc,
        gross_salary: gross,
        actual_salary: round2(basicSalary),
        per_day_salary: round4(perDaySalary || (rows.length ? parseFloat(rows[0].per_day_salary) : 0)),
        total_days: rows.length,

        // Names the payrolls table and the UI use
        total_working_days: rows.length,
        total_present_days: acc.total_present,
        total_absent_days: acc.total_absent,
        total_paid_leave_days: acc.total_paid_leave,
        total_unpaid_leave_days: round2(acc.total_unpaid_leave + acc.total_sandwich),
        sandwich_days: acc.total_sandwich,
        not_employed_days: acc.total_not_employed,
        payable_days: round2(rows.reduce((s, r) => s + (parseFloat(r.pay_fraction) || 0), 0)),
        deduction_amount: acc.total_deduction,
        overtime_hours: acc.total_overtime_hrs,
        overtime_amount: acc.total_overtime_amt,
    };

    // Net follows straight from the daily rows — no second formula to drift.
    summary.net_salary = round2(summary.total_payable + summary.total_overtime_amt);

    return summary;
}

module.exports = {
    DAY_TYPE,
    DEFAULT_SETTINGS,
    FULL_LOSS_TYPES,
    getDateRange,
    toDateString,
    dayOfWeek,
    buildShift,
    buildDailyBreakdown,
    summarizeDailyRows,
    normalizeSettings,
    round2,
    round4,
};
