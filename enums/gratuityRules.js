/**
 * Statutory end-of-service gratuity presets, by country.
 *
 * Same pattern as enums/bankFieldSpecs.js: one source of truth that drives
 * the default calculation AND is served to the frontend so the config form
 * can show what the statutory baseline is before an admin overrides it.
 *
 * A country without a preset gets DISABLED_DEFAULT — no statutory scheme is
 * assumed, so nothing accrues until someone explicitly configures it.
 *
 * These encode the common interpretation of each law. They are deliberately
 * overridable per employee, because contracts, free-zone rules and company
 * policy all vary. Not legal advice — verify against your jurisdiction.
 */

const AE = Object.freeze({
    country_code: "AE",
    country_name: "United Arab Emirates",
    scheme_name: "End of Service Benefits (Federal Decree-Law No. 33 of 2021)",
    is_enabled: true,
    calculation_basis: "basic",
    min_service_years: 1,
    days_in_month: 30,
    tiers: [
        { up_to_years: 5, days_per_year: 21 },
        { up_to_years: null, days_per_year: 30 },
    ],
    max_years_cap: 2, // total must not exceed two years' wages
    max_amount_cap: null,
    year_rounding: "none",
    prorate_partial_years: true,
    exclude_unpaid_leave: true, // unpaid leave does not count toward service
    notes:
        "21 days' basic pay per year for the first 5 years, 30 days per year thereafter. " +
        "Minimum 1 year of continuous service. Pro-rated for part years. " +
        "Total capped at 2 years' wages. Since the 2021 decree-law, resignation no " +
        "longer reduces the entitlement.",
});

const IN = Object.freeze({
    country_code: "IN",
    country_name: "India",
    scheme_name: "Payment of Gratuity Act, 1972",
    is_enabled: true,
    calculation_basis: "basic",
    min_service_years: 5,
    days_in_month: 26, // statutory divisor: 15/26 of monthly wages
    tiers: [{ up_to_years: null, days_per_year: 15 }],
    max_years_cap: null,
    max_amount_cap: 2000000, // ₹20 lakh statutory ceiling
    year_rounding: "half_up", // service beyond 6 months counts as a full year
    prorate_partial_years: false,
    exclude_unpaid_leave: false,
    notes:
        "15 days' wages (basic + DA) for every completed year, using a 26-day month. " +
        "Minimum 5 years of service. Service beyond 6 months in the final year counts " +
        "as a full year. Capped at ₹20,00,000.",
});

const SA = Object.freeze({
    country_code: "SA",
    country_name: "Saudi Arabia",
    scheme_name: "End of Service Award (Saudi Labour Law)",
    is_enabled: true,
    calculation_basis: "gross",
    min_service_years: 1,
    days_in_month: 30,
    tiers: [
        { up_to_years: 5, days_per_year: 15 },
        { up_to_years: null, days_per_year: 30 },
    ],
    max_years_cap: null,
    max_amount_cap: null,
    year_rounding: "none",
    prorate_partial_years: true,
    exclude_unpaid_leave: false,
    notes:
        "Half a month's wage per year for the first 5 years, one month's wage per year " +
        "thereafter, based on the last full wage. Pro-rated for part years.",
});

/**
 * Countries with no statutory gratuity scheme configured here. Accrual is
 * off until an admin turns it on and supplies the rules explicitly, so we
 * never invent an entitlement that does not exist.
 */
const DISABLED_DEFAULT = Object.freeze({
    country_code: null,
    country_name: null,
    scheme_name: "No statutory gratuity scheme configured",
    is_enabled: false,
    calculation_basis: "basic",
    min_service_years: 1,
    days_in_month: 30,
    tiers: [{ up_to_years: null, days_per_year: 0 }],
    max_years_cap: null,
    max_amount_cap: null,
    year_rounding: "none",
    prorate_partial_years: true,
    exclude_unpaid_leave: false,
    notes:
        "No end-of-service gratuity preset exists for this country. Enable it and " +
        "enter the rules manually if the employee is entitled to one.",
});

const GRATUITY_RULES = Object.freeze({ AE, IN, SA });

/** Preset for a country code; a disabled placeholder when none exists. */
function getGratuityRule(country_code) {
    const code = String(country_code || "").toUpperCase();
    const preset = GRATUITY_RULES[code];

    if (preset) return { ...preset, is_preset: true };

    return {
        ...DISABLED_DEFAULT,
        country_code: /^[A-Z]{2}$/.test(code) ? code : null,
        country_name: /^[A-Z]{2}$/.test(code) ? code : null,
        is_preset: false,
    };
}

/** Every country with a built-in scheme — powers the config dropdown. */
function listGratuityRules() {
    return Object.values(GRATUITY_RULES).map((r) => ({
        country_code: r.country_code,
        country_name: r.country_name,
        scheme_name: r.scheme_name,
        calculation_basis: r.calculation_basis,
        min_service_years: r.min_service_years,
        tiers: r.tiers,
        notes: r.notes,
    }));
}

const hasGratuityPreset = (code) =>
    Boolean(code) && Object.prototype.hasOwnProperty.call(GRATUITY_RULES, String(code).toUpperCase());

module.exports = {
    GRATUITY_RULES,
    DISABLED_DEFAULT,
    getGratuityRule,
    listGratuityRules,
    hasGratuityPreset,
};
