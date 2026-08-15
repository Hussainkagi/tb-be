/**
 * Leave-salary maths. Pure functions — no database, no I/O — so the money logic
 * can be tested and reasoned about on its own, the same way
 * utils/gratuityCalculator.js is.
 *
 * Spec: leave_salary_module.xlsx (repo root). Legal basis: UAE Federal
 * Decree-Law 33/2021 Art. 29.
 *
 * ── The one non-obvious rule ────────────────────────────────────────────────
 *
 * Entitlement is CUMULATIVE at the rate the employee's current service earns,
 * not a fixed amount banked each month:
 *
 *     cumulative_days(k) = rate_for(k) x k        (k = completed months)
 *
 * so what a given month books is the difference between this month's cumulative
 * figure and last month's. That is what makes both of these come out right:
 *
 *   month 6   nothing accrued for months 1-5 (below the eligibility threshold),
 *             then 6 x 2 = 12 days credited at once. An employee with 11 months
 *             of service holds 22 days, not 10 — which is the figure the spec
 *             sheet shows.
 *   month 12  the rate steps from 2 to 2.5 and applies to the whole first year:
 *             cumulative goes 22 → 30, so month 12 books 8 days. The employee
 *             ends year one with the statutory 30, not 24.5.
 *
 * The extra days in those months surface as `catch_up_days` on the ledger row
 * rather than being folded silently into the rate, because "why did this
 * employee get 8 days in June" is a question somebody always asks.
 *
 * Months are measured from the accrual start date (joining date, unless
 * overridden), not calendar months — an employee who joined on the 20th
 * completes a month of service on the 20th. That removes proration entirely,
 * and proration of a monthly accrual is the classic source of half-day drift
 * that nobody can reconcile a year later.
 */

const { toUTCDate, toISODate, round2 } = require("./gratuityCalculator");

const MS_PER_DAY = 86400000;

/**
 * The daily rate is carried at 4 decimal places, matching the NUMERIC(12,4)
 * columns it is stored in, and only the final amount is rounded to currency.
 *
 * This is not fussiness. 8,000 / 30 = 266.6667; rounded to 266.67 first, a
 * 20-day advance comes to 5,333.40 instead of 5,333.33 — seven fils that do not
 * reconcile against the spec sheet, and that compound across a payroll run.
 */
const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;

/** Days between two dates, inclusive of both — the UAE calendar-day count. */
function calendarDaysInclusive(from_date, to_date) {
    const from = toUTCDate(from_date);
    const to = toUTCDate(to_date);
    if (!from || !to || to < from) return 0;
    return Math.floor((to - from) / MS_PER_DAY) + 1;
}

/**
 * `date` shifted by `months`, clamped to the end of the target month.
 * 31 Jan + 1 month = 28 Feb, not 3 March — otherwise a month-end joiner's
 * accrual date walks forward through the year.
 */
function addMonthsClamped(date, months) {
    const d = toUTCDate(date);
    if (!d) return null;

    const day = d.getUTCDate();
    const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();

    return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay)));
}

/** Whole months of service completed between two dates. */
function completedServiceMonths(start_date, as_of_date) {
    const start = toUTCDate(start_date);
    const asOf = toUTCDate(as_of_date);
    if (!start || !asOf || asOf < start) return 0;

    let months =
        (asOf.getUTCFullYear() - start.getUTCFullYear()) * 12 +
        (asOf.getUTCMonth() - start.getUTCMonth());

    // The anniversary day has not come round yet, so this month is not complete.
    if (asOf.getUTCDate() < start.getUTCDate()) {
        const lastDayOfMonth = new Date(
            Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() + 1, 0)
        ).getUTCDate();

        // Exception: the anniversary day does not exist this month (a 31st
        // joiner in February), so the month end completes it.
        const anniversaryFallsOnMonthEnd =
            start.getUTCDate() > lastDayOfMonth && asOf.getUTCDate() === lastDayOfMonth;

        if (!anniversaryFallsOnMonthEnd) months -= 1;
    }

    return Math.max(0, months);
}

/** Days accrued per month at a given length of service. 0 below eligibility. */
function accrualRateFor(service_months, rules) {
    const months = Number(service_months) || 0;
    if (months < Number(rules.min_service_months)) return 0;
    return months >= Number(rules.full_service_months)
        ? Number(rules.accrual_rate_full)
        : Number(rules.accrual_rate_partial);
}

/** Total days earned by the end of month `k` of service. See the header note. */
function cumulativeEntitlementDays(service_months, rules) {
    const months = Number(service_months) || 0;
    const rate = accrualRateFor(months, rules);
    return rate === 0 ? 0 : round2(rate * months);
}

/** Chosen base / days_in_month. The single definition of a day's pay. */
function dailyRate(basis_amount, days_in_month) {
    const divisor = Number(days_in_month) || 30;
    return round4((Number(basis_amount) || 0) / divisor);
}

/**
 * Which salary figure the rate is built from.
 *
 * @param {Object} salary  { basic_salary, actual_salary }
 * @param {String} base    basic | gross | custom
 * @param {Number} custom  used when base is 'custom'
 */
function resolveBasisAmount(salary, base, custom_basis_amount = null) {
    switch (base) {
        case "custom":
            return Number(custom_basis_amount) || 0;
        case "gross":
            return Number(salary?.actual_salary) || 0;
        case "basic":
        default:
            return Number(salary?.basic_salary) || 0;
    }
}

/**
 * The month-by-month accrual schedule for one employee.
 *
 * Rows are what gets written to leave_salary_accruals. Months below the
 * eligibility threshold are emitted with zero days and is_deferred = true
 * rather than skipped, so the ledger reads as a continuous timeline instead of
 * an unexplained gap.
 *
 * @param {Object} opts
 * @param {String} opts.accrual_start_date  joining date, or the configured override
 * @param {String} opts.as_of_date          accrue up to and including this date
 * @param {Object} opts.rules               resolved leave-salary config
 * @param {String} [opts.after_date]        skip months completing on or before this
 *        date. Set to opening_balance_as_of, so an imported opening balance and
 *        the ledger can never double-count the same months.
 * @param {Number} [opts.basis_amount]      salary the rows are valued at
 * @param {String} [opts.calculation_base]
 *
 * @returns {Array<Object>} one row per completed month
 */
function buildAccrualSchedule({
    accrual_start_date,
    as_of_date,
    rules,
    after_date = null,
    basis_amount = 0,
    calculation_base = "basic",
}) {
    const start = toUTCDate(accrual_start_date);
    const asOf = toUTCDate(as_of_date);
    if (!start || !asOf || asOf < start) return [];

    const cutoff = toUTCDate(after_date);
    const rate = dailyRate(basis_amount, rules.days_in_month);
    const totalMonths = completedServiceMonths(start, asOf);

    const rows = [];

    for (let k = 1; k <= totalMonths; k++) {
        const completedOn = addMonthsClamped(start, k);
        if (cutoff && completedOn <= cutoff) continue;

        const cumulative = cumulativeEntitlementDays(k, rules);
        const previous = cumulativeEntitlementDays(k - 1, rules);
        const accrued = round2(Math.max(0, cumulative - previous));
        const monthlyRate = accrualRateFor(k, rules);
        const catchUp = round2(Math.max(0, accrued - monthlyRate));

        rows.push({
            period_year: completedOn.getUTCFullYear(),
            period_month: completedOn.getUTCMonth() + 1,
            period_end_date: toISODate(completedOn),
            service_months: k,
            accrual_rate: monthlyRate,
            accrued_days: accrued,
            catch_up_days: catchUp,
            is_deferred: accrued === 0,
            calculation_base,
            basis_amount: round2(basis_amount),
            days_in_month: Number(rules.days_in_month) || 30,
            daily_rate: rate,
            accrued_amount: round2(accrued * rate),
            note:
                catchUp > 0
                    ? k === Number(rules.full_service_months)
                        ? `Rate stepped up to ${monthlyRate} days/month at ${k} months of service; earlier months re-rated (+${catchUp} days)`
                        : `Eligibility reached at ${k} months of service; deferred months credited (+${catchUp} days)`
                    : accrued === 0
                        ? `Below the ${rules.min_service_months}-month eligibility threshold — accrual deferred`
                        : null,
        });
    }

    return rows;
}

/**
 * The bucket, as the API reports it.
 *
 * balance_days = opening + accrued − annual leave taken − days encashed
 *
 * Days taken come from approved leave requests on leave types flagged
 * counts_toward_leave_salary, so the bucket cannot disagree with the leave
 * module about how much leave was used.
 *
 * The payable figure is deliberately NOT the sum of the ledger's booked
 * amounts. Art. 29 entitles the employee to their wage at the time the leave is
 * taken, so the balance is revalued at the current daily rate on every read.
 * `booked_value` is kept alongside it for reconciliation — the gap between the
 * two is exactly the effect of salary changes since the days were earned.
 */
function computeBalance({
    opening_days = 0,
    accrued_days = 0,
    taken_days = 0,
    encashed_days = 0,
    booked_value = 0,
    current_daily_rate = 0,
    max_balance_days = null,
}) {
    const opening = Number(opening_days) || 0;
    const accrued = Number(accrued_days) || 0;
    const taken = Number(taken_days) || 0;
    const encashed = Number(encashed_days) || 0;

    const rawBalance = round2(opening + accrued - taken - encashed);

    const cap = max_balance_days === null || max_balance_days === undefined
        ? null
        : Number(max_balance_days);

    // A cap forfeits days, so it is reported, never applied silently.
    const isCapped = cap !== null && rawBalance > cap;
    const balance = isCapped ? round2(cap) : rawBalance;

    const rate = Number(current_daily_rate) || 0;
    const booked = Number(booked_value) || 0;

    /**
     * What the ledger paid per day on average, across everything ever booked.
     *
     * The revaluation figure has to compare like with like: the REMAINING days
     * at today's rate against those same days at the rate they were earned at.
     * Subtracting the whole booked value from the remaining balance's value
     * instead would mostly measure how much leave has been taken — an employee
     * who used half their days on an unchanged salary would show a large
     * "revaluation", which is nonsense.
     *
     * Undefined when nothing has been booked (a pure opening-balance import),
     * and reported as null rather than guessed at.
     */
    const avgBookedRate = accrued > 0 && booked > 0 ? booked / accrued : null;

    return {
        opening_balance_days: round2(opening),
        accrued_days: round2(accrued),
        days_taken: round2(taken),
        days_encashed: round2(encashed),
        balance_days: balance,
        uncapped_balance_days: rawBalance,
        forfeited_days: isCapped ? round2(rawBalance - cap) : 0,
        max_balance_days: cap,
        is_capped: isCapped,
        // A negative balance means leave was granted beyond what was earned —
        // legitimate (advance leave), but the admin should see it.
        is_negative: balance < 0,
        current_daily_rate: round4(rate),
        balance_value: round2(balance * rate),
        booked_value: round2(booked),
        average_booked_rate: avgBookedRate === null ? null : round4(avgBookedRate),
        revaluation_difference:
            avgBookedRate === null ? 0 : round2(balance * (rate - avgBookedRate)),
    };
}

/**
 * Advance leave salary — paid before the leave starts (Art. 29).
 * Calendar days, inclusive of both endpoints.
 */
function calculateAdvance({ from_date, to_date, basis_amount, days_in_month = 30 }) {
    const days = calendarDaysInclusive(from_date, to_date);
    const rate = dailyRate(basis_amount, days_in_month);

    return {
        from_date: toISODate(toUTCDate(from_date)),
        to_date: toISODate(toUTCDate(to_date)),
        calendar_days: days,
        basis_amount: round2(basis_amount),
        days_in_month: Number(days_in_month) || 30,
        daily_rate: rate,
        amount: round2(days * rate),
    };
}

/** Encashment of unused balance — days x daily rate. */
function calculateEncashment({ days, basis_amount, days_in_month = 30 }) {
    const d = Math.max(0, Number(days) || 0);
    const rate = dailyRate(basis_amount, days_in_month);

    return {
        days_encashed: round2(d),
        basis_amount: round2(basis_amount),
        days_in_month: Number(days_in_month) || 30,
        daily_rate: rate,
        amount: round2(d * rate),
    };
}

/**
 * Unpaid-leave deduction, for reference only.
 *
 * Payroll already deducts unpaid leave through its daily breakdown
 * (service/payrollEngineService.js), and that stays the single source of truth
 * for money leaving a payslip. This function exists so the leave-salary screens
 * can show the spec sheet's figure without a second deduction being written
 * anywhere — two systems deducting the same days is how an employee ends up
 * docked twice.
 */
function calculateUnpaidLeaveDeduction({ unpaid_days, basis_amount, days_in_month = 30 }) {
    const days = Math.max(0, Number(unpaid_days) || 0);
    const rate = dailyRate(basis_amount, days_in_month);

    return {
        unpaid_leave_days: round2(days),
        basis_amount: round2(basis_amount),
        days_in_month: Number(days_in_month) || 30,
        daily_rate: rate,
        deduction_amount: round2(days * rate),
        is_authoritative: false,
        note: "Indicative. Payroll generation applies the actual unpaid-leave deduction.",
    };
}

/**
 * Notice not served → compensation in lieu (Art. 43).
 *
 * Counted from the day after the decision to the day the notice would have
 * ended, so a waived or shortened notice carries a number rather than an
 * argument.
 */
function calculateNoticeShortfall({
    notice_start_date,
    notice_period_days,
    last_working_date,
    basis_amount,
    days_in_month = 30,
}) {
    const start = toUTCDate(notice_start_date);
    const lwd = toUTCDate(last_working_date);
    const required = Math.max(0, Number(notice_period_days) || 0);
    const rate = dailyRate(basis_amount, days_in_month);

    if (!start || !lwd || required === 0) {
        return {
            required_notice_days: required,
            served_notice_days: 0,
            shortfall_days: 0,
            daily_rate: rate,
            shortfall_amount: 0,
        };
    }

    const served = Math.min(required, Math.max(0, calendarDaysInclusive(start, lwd)));
    const shortfall = round2(required - served);

    return {
        notice_start_date: toISODate(start),
        last_working_date: toISODate(lwd),
        required_notice_days: required,
        served_notice_days: served,
        shortfall_days: shortfall,
        basis_amount: round2(basis_amount),
        days_in_month: Number(days_in_month) || 30,
        daily_rate: rate,
        shortfall_amount: round2(shortfall * rate),
    };
}

module.exports = {
    round4,
    calendarDaysInclusive,
    addMonthsClamped,
    completedServiceMonths,
    accrualRateFor,
    cumulativeEntitlementDays,
    dailyRate,
    resolveBasisAmount,
    buildAccrualSchedule,
    computeBalance,
    calculateAdvance,
    calculateEncashment,
    calculateUnpaidLeaveDeduction,
    calculateNoticeShortfall,
};
