const GratuityConfigModel = require("../models/employeeGratuityConfigModel");
const EmployeeModel = require("../models/employeeModel");
const { calculateGratuity } = require("../utils/gratuityCalculator");
const {
    getGratuityRule,
    listGratuityRules,
    hasGratuityPreset,
} = require("../enums/gratuityRules");
const { normalizeCountry } = require("../utils/bankDetailsValidator");
const { resolveCountryCode } = require("../enums/bankFieldSpecs");

/**
 * Employee gratuity (end-of-service benefits).
 *
 * Resolution order for the rules applied to an employee:
 *   1. their saved config row, if one exists
 *   2. otherwise the statutory preset for their work_country
 *      (from the salary structure), falling back to the company's country
 *
 * So UAE employees accrue correctly with zero configuration, and a config
 * row only appears when an admin deviates from the statutory baseline.
 */

const isNum = (v) => v !== null && v !== undefined && v !== "" && !isNaN(Number(v));

/**
 * Which country's rules apply: explicit config → salary work_country →
 * company country.
 */
function resolveRuleCountry(row) {
    return (
        normalizeCountry(row.rule_country) ||
        normalizeCountry(row.work_country) ||
        resolveCountryCode(row.company_country) ||
        null
    );
}

/**
 * A cross-border employee is one whose work country differs from the country
 * their employer is registered in — e.g. a Dubai company with someone working
 * from India.
 *
 * Entitlement here is a contractual question, not something we can infer:
 * some such employees are on a UAE contract and receive UAE end-of-service,
 * some are on a local contract, some get nothing. So we do NOT guess. Accrual
 * stays OFF until an admin explicitly decides, and we hand the UI the options.
 */
function detectCrossBorder(row) {
    const companyCountry = resolveCountryCode(row.company_country);
    const workCountry = normalizeCountry(row.work_country);

    return {
        company_country: companyCountry,
        work_country: workCountry,
        is_cross_border: Boolean(
            companyCountry && workCountry && companyCountry !== workCountry
        ),
    };
}

/** The choices an admin has for a cross-border employee. */
function buildDecisionOptions(companyCountry, workCountry) {
    const options = [];

    for (const [code, role] of [
        [companyCountry, "employer_country"],
        [workCountry, "work_country"],
    ]) {
        if (!code) continue;
        const rule = getGratuityRule(code);
        options.push({
            action: "enable",
            rule_country: code,
            role,
            country_name: rule.country_name,
            scheme_name: rule.scheme_name,
            has_preset: rule.is_preset,
            min_service_years: rule.min_service_years,
            tiers: rule.tiers,
        });
    }

    options.push({
        action: "disable",
        rule_country: null,
        role: "none",
        country_name: null,
        scheme_name: "Not entitled to end-of-service gratuity",
        has_preset: false,
    });

    return options;
}

/**
 * Merge the statutory preset with any saved overrides. A config row wins
 * field by field, so an admin can change just the basis and inherit the rest.
 */
function resolveConfig(row) {
    const country = resolveRuleCountry(row);
    const preset = getGratuityRule(country);
    const border = detectCrossBorder(row);

    if (!row.config_id) {
        // Cross-border and undecided → accrue nothing, ask the admin.
        if (border.is_cross_border) {
            const suggested = getGratuityRule(border.company_country);
            return {
                ...suggested,
                is_enabled: false,
                rule_country: border.company_country,
                source: "pending_decision",
                is_configured: false,
                requires_decision: true,
                ...border,
                decision_options: buildDecisionOptions(
                    border.company_country,
                    border.work_country
                ),
                pending_reason:
                    `This employee works from ${border.work_country} but is employed by a ` +
                    `${border.company_country} company. Gratuity entitlement depends on their ` +
                    `contract, so nothing accrues until an admin decides.`,
            };
        }

        return {
            ...preset,
            rule_country: country,
            source: preset.is_preset ? "country_preset" : "no_preset",
            is_configured: false,
            requires_decision: false,
            ...border,
            decision_options: null,
        };
    }

    return {
        country_code: country,
        country_name: preset.country_name,
        scheme_name: preset.scheme_name,
        is_preset: preset.is_preset,
        is_enabled: row.is_enabled,
        calculation_basis: row.calculation_basis ?? preset.calculation_basis,
        custom_basis_amount: row.custom_basis_amount,
        min_service_years: isNum(row.min_service_years)
            ? Number(row.min_service_years)
            : preset.min_service_years,
        days_in_month: isNum(row.days_in_month)
            ? Number(row.days_in_month)
            : preset.days_in_month,
        tiers: Array.isArray(row.tiers) && row.tiers.length ? row.tiers : preset.tiers,
        max_years_cap: isNum(row.max_years_cap) ? Number(row.max_years_cap) : null,
        max_amount_cap: isNum(row.max_amount_cap) ? Number(row.max_amount_cap) : null,
        year_rounding: row.year_rounding ?? preset.year_rounding,
        prorate_partial_years:
            row.prorate_partial_years ?? preset.prorate_partial_years,
        exclude_unpaid_leave: row.exclude_unpaid_leave ?? preset.exclude_unpaid_leave,
        notes: row.notes ?? preset.notes,
        rule_country: country,
        source: "employee_config",
        is_configured: true,
        // An explicit config IS the decision, so nothing is pending — but the
        // UI still wants to know this is a cross-border arrangement.
        requires_decision: false,
        ...border,
        decision_options: border.is_cross_border
            ? buildDecisionOptions(border.company_country, border.work_country)
            : null,
    };
}

// ── Deviation detection ──────────────────────────────────────────────────────

const nearly = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

const normalizeTiers = (t) =>
    (Array.isArray(t) ? t : []).map((x) => ({
        u: x.up_to_years === null || x.up_to_years === undefined ? null : Number(x.up_to_years),
        d: Number(x.days_per_year),
    }));

const sameTiers = (a, b) => JSON.stringify(normalizeTiers(a)) === JSON.stringify(normalizeTiers(b));

const describeTiers = (t) =>
    normalizeTiers(t)
        .map((x) => `${x.d} days/yr${x.u === null ? " beyond" : ` to year ${x.u}`}`)
        .join(", ");

/**
 * Compares a saved config against the statutory preset for its country and
 * reports every difference.
 *
 * A deviation is not automatically wrong — contracts and free-zone rules vary,
 * which is why overrides exist. But a typo in `days_in_month` silently rescales
 * every amount, and a `min_service_years` of 0 grants an entitlement the law
 * does not, so these must never sit invisibly inside a liability total.
 *
 * `severity: "high"` means the change moves money or eligibility.
 */
function detectDeviations(config, row) {
    // Nothing to compare against when the country has no statutory baseline,
    // or when the employee is simply inheriting the preset.
    if (!config.is_configured || !config.is_preset) return [];

    const preset = getGratuityRule(config.rule_country);
    if (!preset.is_preset) return [];

    const out = [];
    const add = (field, label, configured, statutory, severity, impact) =>
        out.push({ field, label, configured, statutory, severity, impact });

    if (!nearly(config.min_service_years, preset.min_service_years)) {
        const lower = Number(config.min_service_years) < Number(preset.min_service_years);
        add(
            "min_service_years",
            "Qualifying period",
            Number(config.min_service_years),
            preset.min_service_years,
            "high",
            lower
                ? `Entitlement starts ${preset.min_service_years - Number(config.min_service_years)} year(s) earlier than ${preset.country_name} law requires, so employees accrue before they legally qualify.`
                : `Entitlement starts later than ${preset.country_name} law requires, so qualifying employees may show zero.`
        );
    }

    if (!nearly(config.days_in_month, preset.days_in_month)) {
        const ratio = preset.days_in_month / Number(config.days_in_month);
        add(
            "days_in_month",
            "Days-in-month divisor",
            Number(config.days_in_month),
            preset.days_in_month,
            "high",
            `The daily wage is scaled by ${ratio.toFixed(2)}x versus the statutory ${preset.days_in_month}-day month, changing every amount proportionally.`
        );
    }

    if (!sameTiers(config.tiers, preset.tiers)) {
        add("tiers", "Accrual rates", describeTiers(config.tiers), describeTiers(preset.tiers), "high",
            "The days accrued per year differ from the statutory schedule.");
    }

    const cfgYearCap = config.max_years_cap == null ? null : Number(config.max_years_cap);
    const preYearCap = preset.max_years_cap == null ? null : Number(preset.max_years_cap);
    if (cfgYearCap !== preYearCap && !(cfgYearCap != null && preYearCap != null && nearly(cfgYearCap, preYearCap))) {
        add("max_years_cap", "Cap in years of salary", cfgYearCap, preYearCap, "high",
            cfgYearCap === null
                ? `The statutory ceiling of ${preYearCap} years' wages has been removed, so long-service totals are uncapped.`
                : "The ceiling differs from the statutory limit.");
    }

    const cfgAmtCap = config.max_amount_cap == null ? null : Number(config.max_amount_cap);
    const preAmtCap = preset.max_amount_cap == null ? null : Number(preset.max_amount_cap);
    if (cfgAmtCap !== preAmtCap && !(cfgAmtCap != null && preAmtCap != null && nearly(cfgAmtCap, preAmtCap))) {
        add("max_amount_cap", "Absolute cap", cfgAmtCap, preAmtCap, "high",
            cfgAmtCap === null
                ? "The statutory absolute ceiling has been removed."
                : "The absolute ceiling differs from the statutory limit.");
    }

    if (Boolean(config.prorate_partial_years) !== Boolean(preset.prorate_partial_years)) {
        add("prorate_partial_years", "Pro-rate part years",
            Boolean(config.prorate_partial_years), preset.prorate_partial_years, "high",
            config.prorate_partial_years
                ? "Part years are paid pro-rata where the statute rounds them."
                : "Part years are discarded where the statute pays them pro-rata.");
    }

    if (config.calculation_basis !== preset.calculation_basis) {
        // Switching away from `basic` is the documented fix when basic_salary is
        // missing, so only flag it as high when there was a usable basic to use.
        const basicUsable = Number(row.basic_salary) > 0;
        add("calculation_basis", "Calculation basis",
            config.calculation_basis, preset.calculation_basis,
            basicUsable ? "high" : "info",
            basicUsable
                ? `${preset.country_name} law bases gratuity on ${preset.calculation_basis} pay, and a usable ${preset.calculation_basis} amount exists on the salary structure.`
                : `Statutory basis is ${preset.calculation_basis}, but no usable ${preset.calculation_basis} amount is recorded, so this override is expected.`);
    }

    if (config.year_rounding !== preset.year_rounding) {
        add("year_rounding", "Year rounding", config.year_rounding, preset.year_rounding, "info",
            "Service years are rounded differently from the statutory rule.");
    }

    if (Boolean(config.exclude_unpaid_leave) !== Boolean(preset.exclude_unpaid_leave)) {
        add("exclude_unpaid_leave", "Exclude unpaid leave",
            Boolean(config.exclude_unpaid_leave), preset.exclude_unpaid_leave, "info",
            config.exclude_unpaid_leave
                ? "Unpaid leave is deducted from service where the statute does not require it."
                : "Unpaid leave counts toward service where the statute excludes it.");
    }

    return out;
}

/** The monthly amount the calculation runs on, per the configured basis. */
function resolveBasisAmount(row, config) {
    switch (config.calculation_basis) {
        case "custom":
            return Number(row.custom_basis_amount) || 0;
        case "gross":
            return Number(row.actual_salary) || 0;
        case "basic":
        default:
            return Number(row.basic_salary) || 0;
    }
}

/** Run the calculation for one prepared input row. */
function computeForRow(row, { as_of_date = null, unpaidDaysMap = {} } = {}) {
    const config = resolveConfig(row);
    const basis_amount = resolveBasisAmount(row, config);
    const service_start_date = row.config_service_start_date || row.joining_date;

    const result = calculateGratuity({
        config,
        basis_amount,
        service_start_date,
        as_of_date,
        unpaid_leave_days: unpaidDaysMap[row.employee_id] || 0,
    });

    // A pending cross-border decision reads better than the generic
    // "accrual is not enabled" message.
    if (config.requires_decision) {
        result.reason = config.pending_reason;
    }

    // Surface data problems the admin can actually act on.
    if (!row.salary_structure_id) {
        result.warnings.push(
            "No active salary structure — add one before gratuity can be calculated."
        );
    } else if (config.calculation_basis === "basic" && !(Number(row.basic_salary) > 0)) {
        result.warnings.push(
            "basic_salary is 0 on the active salary structure. UAE law bases gratuity on " +
            "basic pay — either set a basic amount or switch the basis to 'gross'."
        );
    }
    if (!row.joining_date && !row.config_service_start_date) {
        result.warnings.push("Employee has no joining date — set one or override the service start date.");
    }

    // A saved config that departs from statute must never sit invisibly inside
    // a liability total — surface the money-moving ones as warnings.
    const deviations = detectDeviations(config, row);
    const highSeverity = deviations.filter((d) => d.severity === "high");

    if (highSeverity.length) {
        result.warnings.push(
            `This employee uses custom rules that differ from ${config.country_name} statutory defaults ` +
            `(${highSeverity.map((d) => d.label.toLowerCase()).join(", ")}). ` +
            `Amounts will not match the statutory calculation.`
        );
    }

    return {
        employee: {
            id: row.employee_id,
            first_name: row.first_name,
            last_name: row.last_name,
            full_name: `${row.first_name} ${row.last_name}`.trim(),
            employee_code: row.employee_code,
            status: row.status,
            branch_id: row.branch_id ?? null,
            branch_name: row.branch_name ?? null,
            joining_date: row.joining_date,
        },
        currency: row.salary_currency || row.company_currency,
        config: {
            is_configured: config.is_configured,
            source: config.source,
            is_enabled: config.is_enabled,
            // Cross-border context — drives the "enable or not?" prompt in the UI
            is_cross_border: config.is_cross_border,
            requires_decision: config.requires_decision === true,
            pending_reason: config.pending_reason ?? null,
            company_country: config.company_country ?? null,
            work_country: config.work_country ?? null,
            decision_options: config.decision_options ?? null,
            rule_country: config.rule_country,
            country_name: config.country_name,
            scheme_name: config.scheme_name,
            is_preset: config.is_preset,
            calculation_basis: config.calculation_basis,
            custom_basis_amount: config.custom_basis_amount ?? null,
            service_start_date,
            min_service_years: config.min_service_years,
            days_in_month: config.days_in_month,
            tiers: config.tiers,
            max_years_cap: config.max_years_cap,
            max_amount_cap: config.max_amount_cap,
            year_rounding: config.year_rounding,
            prorate_partial_years: config.prorate_partial_years,
            exclude_unpaid_leave: config.exclude_unpaid_leave,
            notes: config.notes,
            // Every field where the saved config departs from the statutory
            // preset. Empty when inheriting the preset or when no preset exists.
            deviations,
            has_high_severity_deviations: highSeverity.length > 0,
        },
        calculation: result,
    };
}

const EmployeeGratuityService = {
    /** Statutory presets, for the config form. */
    async getRules(country_code = null) {
        try {
            if (!country_code) {
                return { success: true, data: { countries: listGratuityRules() } };
            }
            const code = normalizeCountry(country_code);
            const rule = getGratuityRule(code);
            return {
                success: true,
                data: { ...rule, has_preset: hasGratuityPreset(code) },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Config + accrued amount for one employee. */
    async getForEmployee(employee_id, query = {}) {
        try {
            const row = await GratuityConfigModel.getCalculationInputs(employee_id);
            if (!row) return { success: false, message: "Employee not found" };

            const config = resolveConfig(row);
            const unpaidDaysMap = config.exclude_unpaid_leave
                ? await GratuityConfigModel.getUnpaidLeaveDays([employee_id])
                : {};

            return {
                success: true,
                data: computeForRow(row, { as_of_date: query.as_of_date, unpaidDaysMap }),
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * Create or update an employee's config. Any field left out inherits the
     * statutory preset for the resolved country.
     */
    async upsertForEmployee(company_id, employee_id, payload = {}) {
        try {
            const employee = await EmployeeModel.findById(employee_id);
            if (!employee) return { success: false, message: "Employee not found" };
            if (String(employee.company_id) !== String(company_id)) {
                return { success: false, message: "Employee does not belong to this company" };
            }

            const row = await GratuityConfigModel.getCalculationInputs(employee_id);
            const country =
                normalizeCountry(payload.rule_country) || resolveRuleCountry(row);

            if (!country) {
                return {
                    success: false,
                    message:
                        "rule_country is required — set it explicitly, or set work_country on the employee's salary structure",
                };
            }

            const preset = getGratuityRule(country);
            const errors = [];

            const basis = payload.calculation_basis ?? preset.calculation_basis;
            if (!["basic", "gross", "custom"].includes(basis)) {
                errors.push({ field: "calculation_basis", message: "Must be one of: basic, gross, custom" });
            }
            if (basis === "custom" && !isNum(payload.custom_basis_amount)) {
                errors.push({
                    field: "custom_basis_amount",
                    message: "custom_basis_amount is required when calculation_basis is 'custom'",
                });
            }

            const tiers = Array.isArray(payload.tiers) && payload.tiers.length
                ? payload.tiers
                : preset.tiers;

            for (const [i, tier] of tiers.entries()) {
                if (!isNum(tier.days_per_year) || Number(tier.days_per_year) < 0) {
                    errors.push({ field: `tiers[${i}].days_per_year`, message: "Must be a number >= 0" });
                }
                if (
                    tier.up_to_years !== null &&
                    tier.up_to_years !== undefined &&
                    (!isNum(tier.up_to_years) || Number(tier.up_to_years) <= 0)
                ) {
                    errors.push({
                        field: `tiers[${i}].up_to_years`,
                        message: "Must be a positive number, or null for the final open-ended tier",
                    });
                }
            }

            const daysInMonth = isNum(payload.days_in_month)
                ? Number(payload.days_in_month)
                : preset.days_in_month;
            if (daysInMonth <= 0 || daysInMonth > 31) {
                errors.push({ field: "days_in_month", message: "Must be between 1 and 31" });
            }

            if (payload.year_rounding && !["none", "half_up"].includes(payload.year_rounding)) {
                errors.push({ field: "year_rounding", message: "Must be one of: none, half_up" });
            }

            if (errors.length) {
                return { success: false, message: "Gratuity configuration is invalid", errors };
            }

            const saved = await GratuityConfigModel.upsert(company_id, employee_id, {
                is_enabled: payload.is_enabled ?? preset.is_enabled ?? true,
                rule_country: country,
                calculation_basis: basis,
                custom_basis_amount: basis === "custom" ? Number(payload.custom_basis_amount) : null,
                service_start_date: payload.service_start_date || null,
                min_service_years: isNum(payload.min_service_years)
                    ? Number(payload.min_service_years)
                    : preset.min_service_years,
                days_in_month: daysInMonth,
                tiers,
                max_years_cap: isNum(payload.max_years_cap)
                    ? Number(payload.max_years_cap)
                    : preset.max_years_cap,
                max_amount_cap: isNum(payload.max_amount_cap)
                    ? Number(payload.max_amount_cap)
                    : preset.max_amount_cap,
                year_rounding: payload.year_rounding ?? preset.year_rounding,
                prorate_partial_years:
                    payload.prorate_partial_years ?? preset.prorate_partial_years,
                exclude_unpaid_leave:
                    payload.exclude_unpaid_leave ?? preset.exclude_unpaid_leave,
                notes: payload.notes ?? null,
            });

            // Return the freshly recomputed figure so the UI updates in one round trip.
            const recomputed = await EmployeeGratuityService.getForEmployee(employee_id);

            return {
                success: true,
                message: "Gratuity configuration saved",
                data: recomputed.success ? recomputed.data : { config: saved },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Drop the override and fall back to the statutory preset. */
    async removeForEmployee(employee_id) {
        try {
            const deleted = await GratuityConfigModel.softDelete(employee_id);
            if (!deleted) {
                return { success: false, message: "No gratuity configuration to remove" };
            }
            const recomputed = await EmployeeGratuityService.getForEmployee(employee_id);
            return {
                success: true,
                message: "Gratuity configuration removed — reverted to the country default",
                data: recomputed.success ? recomputed.data : null,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * Company-wide accrued liability — what the business owes if everyone
     * left today. The number finance actually asks for.
     */
    async getCompanySummary(company_id, query = {}) {
        try {
            const rows = await GratuityConfigModel.getCalculationInputsByCompany(company_id, {
                branch_id: query.branch_id || null,
            });

            if (!rows.length) {
                return {
                    success: true,
                    data: { as_of_date: query.as_of_date || null, totals: {}, by_branch: [], employees: [] },
                };
            }

            // Only query unpaid leave when some rule actually needs it.
            const needsUnpaid = rows.filter((r) => resolveConfig(r).exclude_unpaid_leave);
            const unpaidDaysMap = needsUnpaid.length
                ? await GratuityConfigModel.getUnpaidLeaveDays(needsUnpaid.map((r) => r.employee_id))
                : {};

            const computed = rows.map((r) =>
                computeForRow(r, { as_of_date: query.as_of_date, unpaidDaysMap })
            );

            const eligible = computed.filter((c) => c.calculation.eligible);
            const accruing = computed.filter((c) => c.config.is_enabled);

            // Sum per currency — never add different currencies together.
            const byCurrency = {};
            for (const c of eligible) {
                const ccy = c.currency || "UNKNOWN";
                byCurrency[ccy] = (byCurrency[ccy] || 0) + c.calculation.amount;
            }

            const byBranch = {};
            for (const c of computed) {
                const key = c.employee.branch_id || "unassigned";
                byBranch[key] = byBranch[key] || {
                    branch_id: c.employee.branch_id,
                    branch_name: c.employee.branch_name || "Unassigned",
                    employee_count: 0,
                    eligible_count: 0,
                    total_accrued: 0,
                    currency: c.currency,
                };
                byBranch[key].employee_count++;
                if (c.calculation.eligible) {
                    byBranch[key].eligible_count++;
                    byBranch[key].total_accrued += c.calculation.amount;
                }
            }

            return {
                success: true,
                data: {
                    as_of_date: computed[0]?.calculation.as_of_date || null,
                    totals: {
                        employee_count: computed.length,
                        accrual_enabled_count: accruing.length,
                        eligible_count: eligible.length,
                        not_yet_eligible_count: accruing.length - eligible.length,
                        total_accrued_by_currency: Object.entries(byCurrency).map(
                            ([currency, amount]) => ({
                                currency,
                                amount: Math.round((amount + Number.EPSILON) * 100) / 100,
                            })
                        ),
                        employees_with_warnings: computed.filter(
                            (c) => c.calculation.warnings.length
                        ).length,
                        // Cross-border staff nobody has decided on yet — these
                        // accrue nothing until an admin picks a scheme.
                        pending_decision_count: computed.filter(
                            (c) => c.config.requires_decision
                        ).length,
                        cross_border_count: computed.filter((c) => c.config.is_cross_border)
                            .length,
                        // Saved configs that depart from statute in ways that
                        // move money — the audit list for finance.
                        deviating_config_count: computed.filter(
                            (c) => c.config.has_high_severity_deviations
                        ).length,
                    },
                    by_branch: Object.values(byBranch).map((b) => ({
                        ...b,
                        total_accrued: Math.round((b.total_accrued + Number.EPSILON) * 100) / 100,
                    })),
                    employees: computed.map((c) => ({
                        ...c.employee,
                        currency: c.currency,
                        rule_country: c.config.rule_country,
                        is_enabled: c.config.is_enabled,
                        is_configured: c.config.is_configured,
                        is_cross_border: c.config.is_cross_border,
                        requires_decision: c.config.requires_decision,
                        has_high_severity_deviations: c.config.has_high_severity_deviations,
                        deviations: c.config.deviations,
                        company_country: c.config.company_country,
                        work_country: c.config.work_country,
                        eligible: c.calculation.eligible,
                        reason: c.calculation.reason,
                        service_years: c.calculation.service_years_decimal,
                        service_label: `${c.calculation.service.years}y ${c.calculation.service.months}m`,
                        basis_amount: c.calculation.basis_amount,
                        accrued_amount: c.calculation.amount,
                        eligible_from: c.calculation.eligible_from || null,
                        warnings: c.calculation.warnings,
                    })),
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = EmployeeGratuityService;
