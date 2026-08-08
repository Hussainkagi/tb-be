/**
 * End-of-service gratuity maths. Pure functions — no database, no I/O — so
 * the money logic can be tested and reasoned about on its own.
 *
 * The headline number is an ACCRUAL: what the employee would be owed if they
 * left on `as_of_date`. It is always derived, never stored, because it moves
 * every day and changes retroactively whenever the basis salary changes.
 */

const DAYS_PER_YEAR = 365;

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** Parse "YYYY-MM-DD" (or a Date) into a UTC-midnight Date, timezone-free. */
function toUTCDate(value) {
    if (!value) return null;

    if (value instanceof Date) {
        if (isNaN(value)) return null;
        // node-pg builds DATE columns at local midnight, so read local parts.
        return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
    }

    const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

const toISODate = (d) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Calendar-accurate service length, for display.
 * Returns { years, months, days, total_days }.
 */
function serviceDuration(startDate, endDate) {
    const start = toUTCDate(startDate);
    const end = toUTCDate(endDate);
    if (!start || !end || end < start) {
        return { years: 0, months: 0, days: 0, total_days: 0 };
    }

    const total_days = Math.floor((end - start) / 86400000);

    let years = end.getUTCFullYear() - start.getUTCFullYear();
    let months = end.getUTCMonth() - start.getUTCMonth();
    let days = end.getUTCDate() - start.getUTCDate();

    if (days < 0) {
        months -= 1;
        // Days in the month preceding `end`
        const prevMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 0));
        days += prevMonth.getUTCDate();
    }
    if (months < 0) {
        years -= 1;
        months += 12;
    }

    return { years, months, days, total_days };
}

/**
 * Splits a service length across the configured tiers.
 *
 * tiers: [{ up_to_years: 5, days_per_year: 21 }, { up_to_years: null, days_per_year: 30 }]
 * `up_to_years: null` means "everything beyond the previous tier".
 *
 * Returns one row per tier that contributed, with the years falling in it.
 */
function splitAcrossTiers(serviceYears, tiers) {
    const rows = [];
    let consumed = 0;

    for (const tier of tiers) {
        if (consumed >= serviceYears) break;

        const tierCeiling = tier.up_to_years === null || tier.up_to_years === undefined
            ? Infinity
            : Number(tier.up_to_years);

        const yearsInTier = Math.min(serviceYears, tierCeiling) - consumed;
        if (yearsInTier <= 0) continue;

        rows.push({
            from_year: round2(consumed),
            to_year: round2(consumed + yearsInTier),
            years: round2(yearsInTier),
            days_per_year: Number(tier.days_per_year),
        });

        consumed += yearsInTier;
    }

    return rows;
}

/**
 * Calculate accrued gratuity.
 *
 * @param {Object}  opts
 * @param {Object}  opts.config          resolved rule config (preset merged with overrides)
 * @param {Number}  opts.basis_amount    monthly salary the calculation runs on
 * @param {String}  opts.service_start_date  "YYYY-MM-DD"
 * @param {String}  opts.as_of_date      "YYYY-MM-DD" — defaults to today
 * @param {Number}  opts.unpaid_leave_days  days to deduct from service
 *
 * @returns {Object} full breakdown, safe to render directly
 */
function calculateGratuity({
    config,
    basis_amount,
    service_start_date,
    as_of_date = null,
    unpaid_leave_days = 0,
}) {
    const asOf = toISODate(toUTCDate(as_of_date)) || new Date().toISOString().slice(0, 10);
    const warnings = [];

    const empty = (reason) => ({
        eligible: false,
        reason,
        as_of_date: asOf,
        service_start_date: toISODate(toUTCDate(service_start_date)),
        service: { years: 0, months: 0, days: 0, total_days: 0 },
        service_years_decimal: 0,
        unpaid_leave_days: Number(unpaid_leave_days) || 0,
        basis_amount: round2(basis_amount || 0),
        daily_wage: 0,
        tier_breakdown: [],
        gross_amount: 0,
        cap_applied: null,
        amount: 0,
        warnings,
    });

    if (!config || config.is_enabled === false) {
        return empty("Gratuity accrual is not enabled for this employee");
    }
    if (!service_start_date) {
        return empty("No joining date on record — cannot determine length of service");
    }

    const duration = serviceDuration(service_start_date, asOf);
    if (duration.total_days <= 0) {
        return empty("Service has not started yet");
    }

    // Unpaid leave does not count toward service where the rule says so.
    const deduct = config.exclude_unpaid_leave ? Math.max(0, Number(unpaid_leave_days) || 0) : 0;
    const effectiveDays = Math.max(0, duration.total_days - deduct);
    const rawServiceYears = effectiveDays / DAYS_PER_YEAR;

    const basis = Number(basis_amount) || 0;
    if (basis <= 0) {
        warnings.push(
            `Basis salary is ${basis} — gratuity computes to zero. ` +
            `Check the '${config.calculation_basis}' amount on the employee's salary structure.`
        );
    }

    const minYears = Number(config.min_service_years) || 0;
    if (rawServiceYears < minYears) {
        const eligibleOn = new Date(toUTCDate(service_start_date));
        eligibleOn.setUTCDate(eligibleOn.getUTCDate() + Math.ceil(minYears * DAYS_PER_YEAR) + deduct);

        return {
            ...empty(
                `Not yet eligible — ${minYears} year(s) of continuous service required`
            ),
            service: duration,
            service_years_decimal: round2(rawServiceYears),
            eligible_from: toISODate(eligibleOn),
            basis_amount: round2(basis),
        };
    }

    // Countable years: exact fraction, or rounded per the rule.
    let countableYears;
    if (config.year_rounding === "half_up") {
        const whole = Math.floor(rawServiceYears);
        countableYears = rawServiceYears - whole >= 0.5 ? whole + 1 : whole;
    } else if (!config.prorate_partial_years) {
        countableYears = Math.floor(rawServiceYears);
    } else {
        countableYears = rawServiceYears;
    }

    const daysInMonth = Number(config.days_in_month) || 30;
    const dailyWage = basis / daysInMonth;

    const tiers = Array.isArray(config.tiers) && config.tiers.length
        ? config.tiers
        : [{ up_to_years: null, days_per_year: 0 }];

    const breakdown = splitAcrossTiers(countableYears, tiers).map((row) => ({
        ...row,
        days_accrued: round2(row.years * row.days_per_year),
        amount: round2(row.years * row.days_per_year * dailyWage),
    }));

    const grossAmount = breakdown.reduce((sum, r) => sum + r.amount, 0);

    // ── Caps ────────────────────────────────────────────────────────────────
    let amount = grossAmount;
    let capApplied = null;

    if (config.max_years_cap != null) {
        const cap = basis * 12 * Number(config.max_years_cap);
        if (amount > cap) {
            capApplied = {
                type: "years_of_salary",
                cap_years: Number(config.max_years_cap),
                cap_amount: round2(cap),
            };
            amount = cap;
        }
    }

    if (config.max_amount_cap != null && amount > Number(config.max_amount_cap)) {
        capApplied = {
            type: "absolute",
            cap_amount: round2(Number(config.max_amount_cap)),
        };
        amount = Number(config.max_amount_cap);
    }

    return {
        eligible: true,
        reason: null,
        as_of_date: asOf,
        service_start_date: toISODate(toUTCDate(service_start_date)),
        service: duration,
        service_years_decimal: round2(rawServiceYears),
        countable_years: round2(countableYears),
        unpaid_leave_days: deduct,
        basis_amount: round2(basis),
        basis_type: config.calculation_basis,
        days_in_month: daysInMonth,
        daily_wage: round2(dailyWage),
        tier_breakdown: breakdown,
        gross_amount: round2(grossAmount),
        cap_applied: capApplied,
        amount: round2(amount),
        warnings,
    };
}

module.exports = {
    calculateGratuity,
    serviceDuration,
    splitAcrossTiers,
    toUTCDate,
    toISODate,
    round2,
};
