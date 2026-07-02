// services/payrollEngine.js
// Single source of truth for day classification. Both payrollService
// (generation) and payrollBreakdownService (snapshot read/backfill)
// use this — never duplicate this logic again.

function getDateRange(start, end) {
    const dates = [];
    const current = new Date(start);
    const endDate = new Date(end);
    while (current <= endDate) {
        dates.push(current.toISOString().split("T")[0]);
        current.setDate(current.getDate() + 1);
    }
    return dates;
}

function calculateSandwichLeaves(allDates, deductDates, middleDates) {
    const sandwichDates = new Set();
    let i = 0;
    while (i < allDates.length) {
        const date = allDates[i];
        if (!middleDates.has(date)) { i++; continue; }
        const runStart = i;
        while (i < allDates.length && middleDates.has(allDates[i])) i++;
        const runEnd = i - 1;
        const beforeDate = runStart > 0 ? allDates[runStart - 1] : null;
        const afterDate = runEnd + 1 < allDates.length ? allDates[runEnd + 1] : null;
        if (beforeDate && deductDates.has(beforeDate) && afterDate && deductDates.has(afterDate)) {
            for (let j = runStart; j <= runEnd; j++) sandwichDates.add(allDates[j]);
        }
    }
    return sandwichDates;
}

const DAY_TYPE = {
    HOLIDAY: "holiday",
    WEEK_OFF: "week_off",
    COMP_OFF: "comp_off",
    PAID_LEAVE: "paid_leave",
    HALF_DAY_LEAVE: "half_day_leave",
    UNPAID_LEAVE: "unpaid_leave",
    PRESENT: "present",
    HALF_DAY: "half_day",
    ABSENT: "absent",
    SANDWICH: "sandwich",
};

function buildShift(row) {
    return {
        working_hours: row.working_hours || 8,
        half_day_hours: row.half_day_hours || 0,
        monday: row.monday ?? true,
        tuesday: row.tuesday ?? true,
        wednesday: row.wednesday ?? true,
        thursday: row.thursday ?? true,
        friday: row.friday ?? true,
        saturday: row.saturday ?? false,
        sunday: row.sunday ?? false,
    };
}

// Returns { daily: [...rows], summary: {...} }
// This is the ONLY place day classification happens.
function buildDailyBreakdown(period, shift, salaryStructure, attendanceMap, approvedLeaves, holidaySet) {
    const allDates = getDateRange(period.start_date, period.end_date);
    const totalDays = allDates.length;

    const basicSalary = parseFloat(salaryStructure.actual_salary) || 0;
    const housingAllowance = parseFloat(salaryStructure.housing_allowance) || 0;
    const transportAllowance = parseFloat(salaryStructure.transport_allowance) || 0;
    const otherAllowance = parseFloat(salaryStructure.other_allowance) || 0;
    const grossSalary = basicSalary + housingAllowance + transportAllowance + otherAllowance;
    const perDaySalary = totalDays > 0 ? grossSalary / totalDays : 0;

    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const weekOffDayNumbers = new Set(
        [0, 1, 2, 3, 4, 5, 6].filter(d => !shift[dayNames[d]])
    );

    const leaveDateMap = {};
    for (const leave of approvedLeaves) {
        const leaveDates = getDateRange(leave.from_date, leave.to_date);
        for (const d of leaveDates) {
            leaveDateMap[d] = { is_paid: leave.is_paid, is_half_day: leave.is_half_day };
        }
    }

    const deductDates = new Set();
    const middleDates = new Set();
    const rawClassification = {};

    for (const date of allDates) {
        const jsDate = new Date(date);
        const dayOfWeek = jsDate.getDay();
        const isWeekOff = weekOffDayNumbers.has(dayOfWeek);
        const isHoliday = holidaySet.has(date);
        const attendance = attendanceMap[date];
        const leaveInfo = leaveDateMap[date];

        if (isHoliday) {
            middleDates.add(date);
            rawClassification[date] = { type: DAY_TYPE.HOLIDAY, payFraction: 1, deduct: false };
            continue;
        }
        if (isWeekOff) {
            middleDates.add(date);
            rawClassification[date] = { type: DAY_TYPE.WEEK_OFF, payFraction: 1, deduct: false };
            continue;
        }
        if (leaveInfo) {
            if (leaveInfo.is_paid) {
                const type = leaveInfo.is_half_day ? DAY_TYPE.HALF_DAY_LEAVE : DAY_TYPE.PAID_LEAVE;
                rawClassification[date] = { type, payFraction: leaveInfo.is_half_day ? 0.5 : 1, deduct: false };
            } else {
                const days = leaveInfo.is_half_day ? 0.5 : 1;
                rawClassification[date] = {
                    type: DAY_TYPE.UNPAID_LEAVE,
                    payFraction: 1 - days,
                    deductFraction: days,
                    deduct: true,
                };
                deductDates.add(date);
            }
            continue;
        }
        if (!attendance) {
            rawClassification[date] = { type: DAY_TYPE.ABSENT, payFraction: 0, deductFraction: 1, deduct: true };
            deductDates.add(date);
            continue;
        }

        const status = attendance.status;
        if (status === "checked-in" || status === "checked-out") {
            const totalHoursWorked = parseFloat(attendance.total_hours) || 0;
            const halfDayThreshold = parseFloat(shift.half_day_hours) || 0;

            if (halfDayThreshold > 0 && totalHoursWorked < halfDayThreshold) {
                rawClassification[date] = {
                    type: DAY_TYPE.HALF_DAY,
                    payFraction: 0.5,
                    deductFraction: 0.5,
                    deduct: true,
                    total_hours: totalHoursWorked,
                };
                deductDates.add(date);
            } else {
                let overtimeHours = 0;
                if (salaryStructure.overtime_enabled) {
                    const fullDayHours = parseFloat(shift.working_hours) || 8;
                    overtimeHours = Math.max(0, totalHoursWorked - fullDayHours);
                }
                rawClassification[date] = {
                    type: DAY_TYPE.PRESENT,
                    payFraction: 1,
                    deduct: false,
                    total_hours: totalHoursWorked,
                    overtime_hours: parseFloat(overtimeHours.toFixed(2)),
                };
            }
        } else if (status === "absent") {
            rawClassification[date] = { type: DAY_TYPE.ABSENT, payFraction: 0, deductFraction: 1, deduct: true };
            deductDates.add(date);
        } else if (status === "comp-off") {
            middleDates.add(date);
            rawClassification[date] = { type: DAY_TYPE.COMP_OFF, payFraction: 1, deduct: false };
        } else if (status === "leave") {
            rawClassification[date] = { type: DAY_TYPE.ABSENT, payFraction: 0, deductFraction: 1, deduct: true };
            deductDates.add(date);
        }
    }

    const sandwichDates = calculateSandwichLeaves(allDates, deductDates, middleDates);
    for (const d of sandwichDates) {
        if (!deductDates.has(d)) {
            deductDates.add(d);
            rawClassification[d] = {
                ...rawClassification[d],
                type: DAY_TYPE.SANDWICH,
                payFraction: 0,
                deductFraction: 1,
                deduct: true,
            };
        }
    }

    const overtimeRatePerHour = parseFloat(salaryStructure.overtime_rate_per_hour) || 0;

    const dailyRows = allDates.map(date => {
        const cls = rawClassification[date] || { type: "unknown", payFraction: 0, deduct: false };
        const jsDate = new Date(date);
        const dayOfWeek = dayNames[jsDate.getDay()];

        const deductFraction = cls.deductFraction || 0;
        const deductionAmt = parseFloat((perDaySalary * deductFraction).toFixed(2));
        const payableAmt = parseFloat((perDaySalary * cls.payFraction).toFixed(2));
        const overtimeHrs = cls.overtime_hours || 0;
        const overtimeAmt = parseFloat((overtimeHrs * overtimeRatePerHour).toFixed(2));

        return {
            date,
            day_of_week: dayOfWeek,
            day_type: cls.type,
            per_day_salary: parseFloat(perDaySalary.toFixed(4)),
            pay_fraction: cls.payFraction,
            deduct_fraction: deductFraction,
            payable_amount: payableAmt,
            deduction_amount: deductionAmt,
            overtime_hours: overtimeHrs,
            overtime_amount: overtimeAmt,
            net_day_amount: parseFloat((payableAmt + overtimeAmt).toFixed(2)),
            total_hours: cls.total_hours ?? null,
            is_sandwich: cls.type === DAY_TYPE.SANDWICH,
        };
    });

    const summary = dailyRows.reduce((acc, row) => {
        acc.total_payable += row.payable_amount;
        acc.total_deduction += row.deduction_amount;
        acc.total_overtime_amt += row.overtime_amount;
        acc.total_overtime_hrs += row.overtime_hours;

        if (row.day_type === DAY_TYPE.PRESENT) acc.total_present++;
        else if (row.day_type === DAY_TYPE.HALF_DAY) acc.total_present += 0.5;
        else if (row.day_type === DAY_TYPE.ABSENT) acc.total_absent++;
        else if (row.day_type === DAY_TYPE.SANDWICH) acc.total_sandwich++;
        else if (row.day_type === DAY_TYPE.UNPAID_LEAVE) acc.total_unpaid_leave += row.deduct_fraction;
        else if ([DAY_TYPE.PAID_LEAVE, DAY_TYPE.HALF_DAY_LEAVE].includes(row.day_type))
            acc.total_paid_leave += row.pay_fraction;
        else if (row.day_type === DAY_TYPE.HOLIDAY) acc.total_holidays++;
        else if (row.day_type === DAY_TYPE.WEEK_OFF) acc.total_week_off++;
        else if (row.day_type === DAY_TYPE.COMP_OFF) acc.total_comp_off++;

        return acc;
    }, {
        total_payable: 0, total_deduction: 0, total_overtime_amt: 0, total_overtime_hrs: 0,
        total_present: 0, total_absent: 0, total_sandwich: 0, total_unpaid_leave: 0,
        total_paid_leave: 0, total_holidays: 0, total_week_off: 0, total_comp_off: 0,
    });

    for (const key of Object.keys(summary)) summary[key] = parseFloat(summary[key].toFixed(2));

    summary.gross_salary = parseFloat(grossSalary.toFixed(2));
    summary.per_day_salary = parseFloat(perDaySalary.toFixed(4));
    summary.total_days = totalDays;
    summary.net_salary = parseFloat(
        (summary.gross_salary - summary.total_deduction + summary.total_overtime_amt).toFixed(2)
    );
    summary.actual_salary = basicSalary;
    summary.total_working_days = totalDays;
    summary.total_present_days = summary.total_present;
    summary.total_absent_days = summary.total_absent;
    summary.total_paid_leave_days = summary.total_paid_leave;
    summary.total_unpaid_leave_days = summary.total_unpaid_leave + summary.total_sandwich;
    summary.deduction_amount = summary.total_deduction;
    summary.overtime_hours = summary.total_overtime_hrs;
    summary.overtime_amount = summary.total_overtime_amt;

    return { daily: dailyRows, summary };
}

module.exports = {
    DAY_TYPE,
    getDateRange,
    buildShift,
    buildDailyBreakdown,
};