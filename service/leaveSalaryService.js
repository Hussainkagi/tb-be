const LeaveSalaryModel = require("../models/leaveSalaryModel");
const LeaveSalaryPayoutModel = require("../models/leaveSalaryPayoutModel");
const LeaveRequestModel = require("../models/leaveRequestModel");
const EmployeeModel = require("../models/employeeModel");
const {
    DEFAULT_LEAVE_SALARY_RULES,
    CalculationBase,
    EncashmentType,
} = require("../enums/leaveSalaryRules");
const {
    buildAccrualSchedule,
    computeBalance,
    completedServiceMonths,
    accrualRateFor,
    dailyRate,
    resolveBasisAmount,
    calculateAdvance,
    calculateEncashment,
    calculateUnpaidLeaveDeduction,
    calendarDaysInclusive,
} = require("../utils/leaveSalaryCalculator");
const { round2, toISODate, toUTCDate } = require("../utils/gratuityCalculator");

/**
 * Leave salary — the annual-leave bucket.
 *
 * Every employee accrues annual leave monthly; those days carry a cash value at
 * their daily rate, and that pot is what gets paid out as advance leave salary
 * before a holiday, or encashed when they leave. Spec: leave_salary_module.xlsx.
 *
 * Two invariants everything else here depends on:
 *
 *   1. THE BALANCE IS DERIVED. opening + accrued − taken − encashed, assembled
 *      on every read. There is no balance column to correct, reconcile, or find
 *      out of step with the leave module.
 *
 *   2. THE VALUE IS REVALUED. Art. 29 pays leave at the wage in force when the
 *      leave is taken, so balance_value always uses today's daily rate. The
 *      ledger keeps what each month was worth when booked (`booked_value`) only
 *      so the two can be compared — the difference is the effect of pay rises.
 */

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Any date-ish value → "YYYY-MM-DD", or null.
 *
 * node-pg returns DATE columns as JS Date objects. `String(date).slice(0, 10)`
 * on one of those gives "Fri Aug 14", which Postgres rejects when it is passed
 * back as a parameter. toUTCDate reads a Date's local parts (node-pg builds
 * DATE at local midnight) and parses ISO strings.
 */
const asDate = (v) => (v ? toISODate(toUTCDate(v)) : null);

const isNum = (v) => v !== null && v !== undefined && v !== "" && !isNaN(Number(v));

const fullName = (row) => `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim();

/** Merge a company config row over the statutory defaults. */
const resolveRules = (configRow) => {
    if (!configRow) return { ...DEFAULT_LEAVE_SALARY_RULES, is_default: true };

    return {
        days_in_month: Number(configRow.days_in_month),
        annual_entitlement_days: Number(configRow.annual_entitlement_days),
        accrual_rate_full: Number(configRow.accrual_rate_full),
        accrual_rate_partial: Number(configRow.accrual_rate_partial),
        min_service_months: Number(configRow.min_service_months),
        full_service_months: Number(configRow.full_service_months),
        default_calculation_base: configRow.default_calculation_base,
        max_balance_days: configRow.max_balance_days === null ? null : Number(configRow.max_balance_days),
        advance_payment_enabled: configRow.advance_payment_enabled,
        encashment_enabled: configRow.encashment_enabled,
        notes: configRow.notes,
        is_default: false,
    };
};

/**
 * Everything about one employee that the maths needs, with the two config
 * layers already collapsed: per-employee override → company config → statute.
 */
const resolveEmployeeContext = (row, rules) => {
    const base = row.employee_calculation_base || rules.default_calculation_base || CalculationBase.BASIC;

    const basis_amount = resolveBasisAmount(
        { basic_salary: row.basic_salary, actual_salary: row.actual_salary },
        base,
        row.custom_basis_amount
    );

    const accrual_start_date = row.config_accrual_start_date || row.joining_date || null;

    return {
        employee_id: row.employee_id,
        employee_name: fullName(row),
        employee_code: row.employee_code,
        branch_id: row.branch_id,
        branch_name: row.branch_name,
        department_name: row.department_name,
        employee_status: row.employee_status,
        joining_date: row.joining_date,
        accrual_start_date,
        // A missing config row means "enabled" — accrual is the default, and an
        // employee is far more likely to be missed than deliberately excluded.
        is_enabled: row.employee_config_id ? row.is_enabled !== false : true,
        calculation_base: base,
        custom_basis_amount: row.custom_basis_amount,
        basis_amount,
        days_in_month: rules.days_in_month,
        daily_rate: dailyRate(basis_amount, rules.days_in_month),
        opening_balance_days: Number(row.opening_balance_days ?? 0),
        opening_balance_as_of: row.opening_balance_as_of ?? null,
        currency: row.salary_currency || row.company_currency || null,
        has_salary_structure: !!row.salary_structure_id,
    };
};

/** Warnings that explain a zero where the admin expects a number. */
const contextWarnings = (ctx, rules, as_of_date) => {
    const warnings = [];

    if (!ctx.accrual_start_date) {
        warnings.push("No joining date on record — accrual cannot start.");
    }
    if (!ctx.has_salary_structure) {
        warnings.push("No active salary structure — the daily rate is zero.");
    } else if (ctx.basis_amount <= 0) {
        warnings.push(
            `The '${ctx.calculation_base}' salary is ${ctx.basis_amount} — leave salary computes to zero.`
        );
    }
    if (!ctx.is_enabled) {
        warnings.push("Leave-salary accrual is switched off for this employee.");
    }

    const months = ctx.accrual_start_date
        ? completedServiceMonths(ctx.accrual_start_date, as_of_date)
        : 0;

    if (ctx.accrual_start_date && months < rules.min_service_months) {
        warnings.push(
            `${months} month(s) of service — below the ${rules.min_service_months}-month ` +
            `eligibility threshold. Days accrue retrospectively once it is reached.`
        );
    }

    return warnings;
};

/** Assemble the bucket for one employee from its four independent components. */
const buildBucket = (ctx, rules, { as_of_date, accrual, taken_days, encashed }) => {
    const balance = computeBalance({
        opening_days: ctx.opening_balance_days,
        accrued_days: accrual?.accrued_days ?? 0,
        taken_days: taken_days ?? 0,
        encashed_days: encashed?.encashed_days ?? 0,
        booked_value: accrual?.booked_value ?? 0,
        current_daily_rate: ctx.daily_rate,
        max_balance_days: rules.max_balance_days,
    });

    const service_months = ctx.accrual_start_date
        ? completedServiceMonths(ctx.accrual_start_date, as_of_date)
        : 0;

    return {
        employee_id: ctx.employee_id,
        employee_name: ctx.employee_name,
        employee_code: ctx.employee_code,
        branch_id: ctx.branch_id,
        branch_name: ctx.branch_name,
        department_name: ctx.department_name,
        employee_status: ctx.employee_status,
        as_of_date,
        is_enabled: ctx.is_enabled,

        service_months,
        monthly_accrual_rate: accrualRateFor(service_months, rules),

        calculation_base: ctx.calculation_base,
        basis_amount: round2(ctx.basis_amount),
        days_in_month: ctx.days_in_month,
        daily_rate: ctx.daily_rate,
        currency: ctx.currency,

        ...balance,

        encashed_value: round2(encashed?.encashed_value ?? 0),
        last_accrued_period: accrual?.last_period_end ?? null,
        warnings: contextWarnings(ctx, rules, as_of_date),
    };
};

const LeaveSalaryService = {
    // ─────────────────────────────────────────────────────────────────────────
    // CONFIGURATION
    // ─────────────────────────────────────────────────────────────────────────

    /** Resolved rules plus the raw row, so the form can show what is overridden. */
    async getConfig(company_id) {
        try {
            const [configRow, leaveTypes] = await Promise.all([
                LeaveSalaryModel.getCompanyConfig(company_id),
                LeaveSalaryModel.getAnnualLeaveTypes(company_id),
            ]);

            const rules = resolveRules(configRow);
            const counted = leaveTypes.filter((t) => t.counts_toward_leave_salary);

            return {
                success: true,
                data: {
                    config: rules,
                    statutory_defaults: DEFAULT_LEAVE_SALARY_RULES,
                    is_using_defaults: rules.is_default,
                    leave_types: leaveTypes,
                    // Without a flagged leave type nothing ever draws the bucket
                    // down, so balances would only ever grow. Worth saying
                    // loudly at setup rather than discovering it at year end.
                    setup_warnings: counted.length
                        ? []
                        : [
                            "No leave type is flagged as counting toward leave salary. " +
                            "Annual leave taken will not reduce the accrued balance until one is.",
                        ],
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async upsertConfig(company_id, payload = {}) {
        try {
            const current = await LeaveSalaryModel.getCompanyConfig(company_id);
            const base = resolveRules(current);

            const merged = {
                days_in_month: payload.days_in_month ?? base.days_in_month,
                annual_entitlement_days: payload.annual_entitlement_days ?? base.annual_entitlement_days,
                accrual_rate_full: payload.accrual_rate_full ?? base.accrual_rate_full,
                accrual_rate_partial: payload.accrual_rate_partial ?? base.accrual_rate_partial,
                min_service_months: payload.min_service_months ?? base.min_service_months,
                full_service_months: payload.full_service_months ?? base.full_service_months,
                default_calculation_base: payload.default_calculation_base ?? base.default_calculation_base,
                max_balance_days: payload.max_balance_days === undefined
                    ? base.max_balance_days
                    : payload.max_balance_days,
                advance_payment_enabled: payload.advance_payment_enabled ?? base.advance_payment_enabled,
                encashment_enabled: payload.encashment_enabled ?? base.encashment_enabled,
                notes: payload.notes ?? base.notes ?? null,
            };

            const errors = [];

            if (!isNum(merged.days_in_month) || merged.days_in_month <= 0 || merged.days_in_month > 31) {
                errors.push({ field: "days_in_month", message: "Must be between 1 and 31" });
            }
            for (const field of ["annual_entitlement_days", "accrual_rate_full", "accrual_rate_partial"]) {
                if (!isNum(merged[field]) || Number(merged[field]) < 0) {
                    errors.push({ field, message: "Must be a number >= 0" });
                }
            }
            if (!isNum(merged.min_service_months) || Number(merged.min_service_months) < 0) {
                errors.push({ field: "min_service_months", message: "Must be a number >= 0" });
            }
            if (Number(merged.full_service_months) < Number(merged.min_service_months)) {
                errors.push({
                    field: "full_service_months",
                    message: "Must be greater than or equal to min_service_months",
                });
            }
            if (![CalculationBase.BASIC, CalculationBase.GROSS].includes(merged.default_calculation_base)) {
                errors.push({
                    field: "default_calculation_base",
                    message: "Must be 'basic' or 'gross'",
                });
            }
            if (merged.max_balance_days !== null && (!isNum(merged.max_balance_days) || Number(merged.max_balance_days) < 0)) {
                errors.push({ field: "max_balance_days", message: "Must be a number >= 0, or null for uncapped" });
            }

            if (errors.length) {
                return { success: false, message: "Validation failed", errors };
            }

            const saved = await LeaveSalaryModel.upsertCompanyConfig(company_id, merged);

            return {
                success: true,
                message: "Leave salary configuration saved",
                data: resolveRules(saved),
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Flag which leave types draw the bucket down. */
    async setLeaveTypeCounting(company_id, leave_type_id, counts) {
        try {
            if (typeof counts !== "boolean") {
                return { success: false, message: "counts_toward_leave_salary must be true or false" };
            }

            const updated = await LeaveSalaryModel.setLeaveTypeCountsTowardLeaveSalary(
                company_id, leave_type_id, counts
            );
            if (!updated) return { success: false, message: "Leave type not found" };

            return { success: true, message: "Leave type updated", data: updated };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async upsertEmployeeConfig(company_id, employee_id, payload = {}) {
        try {
            const employee = await EmployeeModel.findById(employee_id);
            if (!employee) return { success: false, message: "Employee not found" };
            if (String(employee.company_id) !== String(company_id)) {
                return { success: false, message: "Employee does not belong to this company" };
            }

            const current = await LeaveSalaryModel.getEmployeeConfig(employee_id);

            const merged = {
                is_enabled: payload.is_enabled ?? current?.is_enabled ?? true,
                calculation_base: payload.calculation_base ?? current?.calculation_base ?? null,
                custom_basis_amount: payload.custom_basis_amount ?? current?.custom_basis_amount ?? null,
                accrual_start_date: payload.accrual_start_date ?? current?.accrual_start_date ?? null,
                opening_balance_days: payload.opening_balance_days ?? current?.opening_balance_days ?? 0,
                opening_balance_as_of: payload.opening_balance_as_of ?? current?.opening_balance_as_of ?? null,
                notes: payload.notes ?? current?.notes ?? null,
            };

            const errors = [];

            if (merged.calculation_base !== null &&
                !Object.values(CalculationBase).includes(merged.calculation_base)) {
                errors.push({
                    field: "calculation_base",
                    message: "Must be one of: basic, gross, custom (or null to inherit)",
                });
            }
            if (merged.calculation_base === CalculationBase.CUSTOM && !isNum(merged.custom_basis_amount)) {
                errors.push({
                    field: "custom_basis_amount",
                    message: "Required when calculation_base is 'custom'",
                });
            }
            if (!isNum(merged.opening_balance_days) || Number(merged.opening_balance_days) < 0) {
                errors.push({ field: "opening_balance_days", message: "Must be a number >= 0" });
            }
            // An opening balance with no date cannot be placed on the timeline,
            // so accrual would not know which months it already covers.
            if (Number(merged.opening_balance_days) > 0 && !merged.opening_balance_as_of) {
                errors.push({
                    field: "opening_balance_as_of",
                    message: "Required when an opening balance is set — it marks the months accrual must skip",
                });
            }

            if (errors.length) {
                return { success: false, message: "Validation failed", errors };
            }

            const saved = await LeaveSalaryModel.upsertEmployeeConfig(company_id, employee_id, merged);

            return {
                success: true,
                message: "Employee leave salary settings saved",
                data: saved,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async removeEmployeeConfig(employee_id) {
        try {
            const removed = await LeaveSalaryModel.softDeleteEmployeeConfig(employee_id);
            if (!removed) return { success: false, message: "No leave salary settings found for this employee" };

            return {
                success: true,
                message: "Employee reverted to the company leave salary settings",
                data: removed,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // THE BUCKET
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * One employee: balance, ledger, and the payouts against it.
     *
     * Shared by the admin screen, the employee's own view and the settlement
     * preview, so all three can never disagree about a number.
     */
    async getForEmployee(employee_id, { as_of_date = null, include_ledger = true } = {}) {
        try {
            const row = await LeaveSalaryModel.getCalculationInputs(employee_id);
            if (!row) return { success: false, message: "Employee not found" };

            const asOf = as_of_date || today();
            const rules = resolveRules(await LeaveSalaryModel.getCompanyConfig(row.company_id));
            const ctx = resolveEmployeeContext(row, rules);

            const [accrualMap, takenMap, encashedMap] = await Promise.all([
                LeaveSalaryModel.getAccrualTotals([employee_id], asOf),
                LeaveSalaryModel.getTakenDays([employee_id], asOf),
                LeaveSalaryModel.getEncashedDays([employee_id], asOf),
            ]);

            const bucket = buildBucket(ctx, rules, {
                as_of_date: asOf,
                accrual: accrualMap[employee_id],
                taken_days: takenMap[employee_id],
                encashed: encashedMap[employee_id],
            });

            const [ledger, advances, encashments] = await Promise.all([
                include_ledger ? LeaveSalaryModel.getAccruals(employee_id) : Promise.resolve([]),
                LeaveSalaryPayoutModel.listAdvances({ company_id: row.company_id, employee_id }),
                LeaveSalaryPayoutModel.listEncashments({ company_id: row.company_id, employee_id }),
            ]);

            return {
                success: true,
                data: {
                    balance: bucket,
                    config: {
                        ...rules,
                        applied_calculation_base: ctx.calculation_base,
                        accrual_start_date: ctx.accrual_start_date,
                        opening_balance_days: ctx.opening_balance_days,
                        opening_balance_as_of: ctx.opening_balance_as_of,
                        is_enabled: ctx.is_enabled,
                    },
                    accrual_ledger: ledger,
                    advances,
                    encashments,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * The company view: what each employee has collected, and the total the
     * business is carrying. This is the accrued LIABILITY — money already earned
     * and owed, not a forecast.
     */
    async getCompanySummary(company_id, { branch_id = null, as_of_date = null } = {}) {
        try {
            const asOf = as_of_date || today();
            const rules = resolveRules(await LeaveSalaryModel.getCompanyConfig(company_id));

            const rows = await LeaveSalaryModel.getCalculationInputsByCompany(company_id, { branch_id });
            const employee_ids = rows.map((r) => r.employee_id);

            const [accrualMap, takenMap, encashedMap, payoutTotals] = await Promise.all([
                LeaveSalaryModel.getAccrualTotals(employee_ids, asOf),
                LeaveSalaryModel.getTakenDays(employee_ids, asOf),
                LeaveSalaryModel.getEncashedDays(employee_ids, asOf),
                LeaveSalaryPayoutModel.getCompanyPayoutTotals(company_id),
            ]);

            const employees = rows.map((row) => {
                const ctx = resolveEmployeeContext(row, rules);
                return buildBucket(ctx, rules, {
                    as_of_date: asOf,
                    accrual: accrualMap[row.employee_id],
                    taken_days: takenMap[row.employee_id],
                    encashed: encashedMap[row.employee_id],
                });
            });

            const sum = (fn) => round2(employees.reduce((acc, e) => acc + (fn(e) || 0), 0));

            return {
                success: true,
                data: {
                    as_of_date: asOf,
                    currency: employees.find((e) => e.currency)?.currency ?? null,
                    totals: {
                        employee_count: employees.length,
                        accruing_employee_count: employees.filter((e) => e.is_enabled).length,
                        accrued_days: sum((e) => e.accrued_days),
                        days_taken: sum((e) => e.days_taken),
                        days_encashed: sum((e) => e.days_encashed),
                        balance_days: sum((e) => e.balance_days),
                        // The headline: what the outstanding balance would cost
                        // to pay out today.
                        accrued_liability: sum((e) => e.balance_value),
                        booked_value: sum((e) => e.booked_value),
                        revaluation_difference: sum((e) => e.revaluation_difference),
                        forfeited_days: sum((e) => e.forfeited_days),
                        ...payoutTotals,
                    },
                    employees_missing_setup: employees
                        .filter((e) => e.warnings.length > 0)
                        .map((e) => ({
                            employee_id: e.employee_id,
                            employee_name: e.employee_name,
                            warnings: e.warnings,
                        })),
                    employees,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getAccrualLedger(employee_id, { year = null } = {}) {
        try {
            const rows = await LeaveSalaryModel.getAccruals(employee_id, { year });
            return {
                success: true,
                data: {
                    employee_id,
                    total_accrued_days: round2(rows.reduce((a, r) => a + Number(r.accrued_days), 0)),
                    total_booked_value: round2(rows.reduce((a, r) => a + Number(r.accrued_amount), 0)),
                    entries: rows,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // ACCRUAL RUN
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Book every month that has completed since the last run.
     *
     * Safe to run as often as you like — usually monthly, by hand or from a job.
     * Months already booked are skipped, so the historical rate snapshots stay
     * as they were. `recalculate: true` deliberately rebuilds them at today's
     * salary, which is what you want after fixing a wrong salary structure and
     * nothing else.
     *
     * `dry_run: true` returns exactly what would be written without writing it —
     * this is a money ledger, and the first run against real data should be
     * inspectable.
     */
    async runAccrual(company_id, {
        as_of_date = null,
        employee_id = null,
        branch_id = null,
        dry_run = false,
        recalculate = false,
    } = {}) {
        try {
            const asOf = as_of_date || today();
            const rules = resolveRules(await LeaveSalaryModel.getCompanyConfig(company_id));

            const rows = await LeaveSalaryModel.getCalculationInputsByCompany(company_id, {
                branch_id,
                employee_ids: employee_id ? [employee_id] : null,
                // A separated employee still accrues up to their last working
                // day; the settlement needs those final months.
                include_separated: !!employee_id,
            });

            if (!rows.length) {
                return { success: false, message: "No employees matched this accrual run" };
            }

            const results = [];
            const skipped = [];

            for (const row of rows) {
                const ctx = resolveEmployeeContext(row, rules);

                if (!ctx.is_enabled) {
                    skipped.push({ employee_id: ctx.employee_id, employee_name: ctx.employee_name, reason: "Accrual disabled for this employee" });
                    continue;
                }
                if (!ctx.accrual_start_date) {
                    skipped.push({ employee_id: ctx.employee_id, employee_name: ctx.employee_name, reason: "No joining date on record" });
                    continue;
                }

                // Never book past a completed separation: the bucket stops on
                // the last working day, and the settlement is built from it.
                const lastBooked = recalculate
                    ? null
                    : await LeaveSalaryModel.getLastAccrualDate(ctx.employee_id);

                // Whichever cutoff is later wins — an imported opening balance
                // and the ledger must not cover the same month twice.
                const after = [ctx.opening_balance_as_of, lastBooked]
                    .filter(Boolean)
                    .sort()
                    .pop() ?? null;

                const schedule = buildAccrualSchedule({
                    accrual_start_date: ctx.accrual_start_date,
                    as_of_date: asOf,
                    rules,
                    after_date: after,
                    basis_amount: ctx.basis_amount,
                    calculation_base: ctx.calculation_base,
                });

                if (!schedule.length) {
                    skipped.push({
                        employee_id: ctx.employee_id,
                        employee_name: ctx.employee_name,
                        reason: "Already up to date",
                    });
                    continue;
                }

                const written = dry_run
                    ? schedule
                    : await LeaveSalaryModel.upsertAccruals(company_id, ctx.employee_id, schedule);

                results.push({
                    employee_id: ctx.employee_id,
                    employee_name: ctx.employee_name,
                    employee_code: ctx.employee_code,
                    months_booked: schedule.length,
                    days_accrued: round2(schedule.reduce((a, r) => a + r.accrued_days, 0)),
                    value_accrued: round2(schedule.reduce((a, r) => a + r.accrued_amount, 0)),
                    from_period: schedule[0].period_end_date,
                    to_period: schedule[schedule.length - 1].period_end_date,
                    entries: written,
                });
            }

            return {
                success: true,
                message: dry_run
                    ? `Dry run — ${results.length} employee(s) would accrue`
                    : `Accrual booked for ${results.length} employee(s)`,
                data: {
                    as_of_date: asOf,
                    dry_run,
                    recalculate,
                    processed_count: results.length,
                    skipped_count: skipped.length,
                    total_days_accrued: round2(results.reduce((a, r) => a + r.days_accrued, 0)),
                    total_value_accrued: round2(results.reduce((a, r) => a + r.value_accrued, 0)),
                    results,
                    skipped,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // ADVANCE LEAVE SALARY
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Raise an advance, either from an approved leave request (preferred — the
     * dates and the days then come from the request itself) or from explicit
     * dates for leave agreed outside the system.
     */
    async createAdvance(company_id, payload = {}, created_by = null) {
        try {
            const {
                employee_id, leave_request_id = null,
                from_date = null, to_date = null,
                payroll_month = null, notes = null,
            } = payload;

            if (!employee_id) return { success: false, message: "employee_id is required" };

            const row = await LeaveSalaryModel.getCalculationInputs(employee_id);
            if (!row) return { success: false, message: "Employee not found" };
            if (String(row.company_id) !== String(company_id)) {
                return { success: false, message: "Employee does not belong to this company" };
            }

            const rules = resolveRules(await LeaveSalaryModel.getCompanyConfig(company_id));
            if (rules.advance_payment_enabled === false) {
                return { success: false, message: "Advance leave salary is switched off for this company" };
            }

            const ctx = resolveEmployeeContext(row, rules);

            let leaveFrom = from_date;
            let leaveTo = to_date;

            if (leave_request_id) {
                const leaveRequest = await LeaveRequestModel.findById(leave_request_id);
                if (!leaveRequest) return { success: false, message: "Leave request not found" };
                if (String(leaveRequest.employee_id) !== String(employee_id)) {
                    return { success: false, message: "That leave request belongs to a different employee" };
                }
                if (leaveRequest.status !== "approved") {
                    return {
                        success: false,
                        message: `Leave salary is paid against approved leave only. This request is ${leaveRequest.status}.`,
                    };
                }

                const existing = await LeaveSalaryPayoutModel.findAdvanceByLeaveRequest(leave_request_id);
                if (existing) {
                    return {
                        success: false,
                        message: `An advance already exists for this leave request (status: ${existing.status})`,
                        data: { advance_id: existing.id },
                    };
                }

                leaveFrom = leaveFrom || asDate(leaveRequest.from_date);
                leaveTo = leaveTo || asDate(leaveRequest.to_date);
            }

            if (!leaveFrom || !leaveTo) {
                return {
                    success: false,
                    message: "Provide leave_request_id, or both from_date and to_date",
                };
            }
            if (calendarDaysInclusive(leaveFrom, leaveTo) <= 0) {
                return { success: false, message: "to_date must be on or after from_date" };
            }
            if (ctx.basis_amount <= 0) {
                return {
                    success: false,
                    message: `The employee's '${ctx.calculation_base}' salary is zero — set a salary structure before paying leave salary.`,
                };
            }

            const calc = calculateAdvance({
                from_date: leaveFrom,
                to_date: leaveTo,
                basis_amount: ctx.basis_amount,
                days_in_month: rules.days_in_month,
            });

            const advance = await LeaveSalaryPayoutModel.createAdvance({
                company_id,
                employee_id,
                leave_request_id,
                leave_from_date: calc.from_date,
                leave_to_date: calc.to_date,
                calendar_days: calc.calendar_days,
                calculation_base: ctx.calculation_base,
                basis_amount: calc.basis_amount,
                days_in_month: calc.days_in_month,
                daily_rate: calc.daily_rate,
                amount: calc.amount,
                payroll_month,
                notes,
                created_by,
            });

            return {
                success: true,
                message: "Advance leave salary raised",
                data: { advance, calculation: calc },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** What an advance would come to, without creating anything. */
    async previewAdvance(company_id, { employee_id, from_date, to_date } = {}) {
        try {
            if (!employee_id || !from_date || !to_date) {
                return { success: false, message: "employee_id, from_date and to_date are required" };
            }

            const row = await LeaveSalaryModel.getCalculationInputs(employee_id);
            if (!row || String(row.company_id) !== String(company_id)) {
                return { success: false, message: "Employee not found" };
            }

            const rules = resolveRules(await LeaveSalaryModel.getCompanyConfig(company_id));
            const ctx = resolveEmployeeContext(row, rules);

            const calc = calculateAdvance({
                from_date, to_date,
                basis_amount: ctx.basis_amount,
                days_in_month: rules.days_in_month,
            });

            const balance = await this.getForEmployee(employee_id, { include_ledger: false });

            return {
                success: true,
                data: {
                    ...calc,
                    calculation_base: ctx.calculation_base,
                    currency: ctx.currency,
                    // Advance leave salary is a payment, not a draw on the
                    // bucket — the days are consumed by the leave request. The
                    // balance is shown so an admin can see whether the employee
                    // has actually earned the leave they are being paid for.
                    balance_days: balance.success ? balance.data.balance.balance_days : null,
                    exceeds_balance: balance.success
                        ? calc.calendar_days > balance.data.balance.balance_days
                        : null,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async listAdvances(company_id, filters = {}) {
        try {
            const advances = await LeaveSalaryPayoutModel.listAdvances({ company_id, ...filters });
            return {
                success: true,
                data: {
                    count: advances.length,
                    total_amount: round2(advances.reduce((a, r) => a + Number(r.amount), 0)),
                    advances,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async approveAdvance(company_id, id, approved_by) {
        return this._transition({
            company_id, id,
            find: () => LeaveSalaryPayoutModel.findAdvanceById(id),
            act: () => LeaveSalaryPayoutModel.approveAdvance(id, approved_by),
            noun: "Advance",
            expected: "pending",
        });
    },

    async markAdvancePaid(company_id, id, { payment_reference = null, payroll_month = null } = {}) {
        return this._transition({
            company_id, id,
            find: () => LeaveSalaryPayoutModel.findAdvanceById(id),
            act: () => LeaveSalaryPayoutModel.markAdvancePaid(id, { payment_reference, payroll_month }),
            noun: "Advance",
            expected: "approved",
        });
    },

    async cancelAdvance(company_id, id, cancelled_reason) {
        if (!cancelled_reason) {
            return { success: false, message: "A cancellation reason is required" };
        }
        return this._transition({
            company_id, id,
            find: () => LeaveSalaryPayoutModel.findAdvanceById(id),
            act: () => LeaveSalaryPayoutModel.cancelAdvance(id, cancelled_reason),
            noun: "Advance",
            expected: "pending or approved",
        });
    },

    // ─────────────────────────────────────────────────────────────────────────
    // ENCASHMENT
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Cash out unused balance.
     *
     * Days are checked against the live balance, not a cached figure, and
     * pending encashments already hold their days (see
     * leaveSalaryModel.getEncashedDays) — so two payouts raised the same
     * afternoon cannot together overdraw the bucket.
     */
    async createEncashment(company_id, payload = {}, created_by = null) {
        try {
            const {
                employee_id, days = null, effective_date = null,
                encashment_type = EncashmentType.IN_SERVICE,
                separation_id = null, payroll_month = null, notes = null,
                encash_full_balance = false,
            } = payload;

            if (!employee_id) return { success: false, message: "employee_id is required" };

            const row = await LeaveSalaryModel.getCalculationInputs(employee_id);
            if (!row) return { success: false, message: "Employee not found" };
            if (String(row.company_id) !== String(company_id)) {
                return { success: false, message: "Employee does not belong to this company" };
            }

            const rules = resolveRules(await LeaveSalaryModel.getCompanyConfig(company_id));
            if (rules.encashment_enabled === false) {
                return { success: false, message: "Leave encashment is switched off for this company" };
            }

            const asOf = effective_date || today();
            const current = await this.getForEmployee(employee_id, {
                as_of_date: asOf,
                include_ledger: false,
            });
            if (!current.success) return current;

            const available = current.data.balance.balance_days;
            const requested = encash_full_balance ? available : Number(days);

            if (!isNum(requested) || requested <= 0) {
                return {
                    success: false,
                    message: encash_full_balance
                        ? `There is no balance to encash (${available} days available)`
                        : "days must be a number greater than 0",
                };
            }
            if (requested > available) {
                return {
                    success: false,
                    message: `Only ${available} day(s) are available to encash — ${requested} requested.`,
                    data: { available_days: available, requested_days: requested },
                };
            }

            const ctx = resolveEmployeeContext(row, rules);
            const calc = calculateEncashment({
                days: requested,
                basis_amount: ctx.basis_amount,
                days_in_month: rules.days_in_month,
            });

            const encashment = await LeaveSalaryPayoutModel.createEncashment({
                company_id,
                employee_id,
                separation_id,
                encashment_type,
                effective_date: asOf,
                days_encashed: calc.days_encashed,
                calculation_base: ctx.calculation_base,
                basis_amount: calc.basis_amount,
                days_in_month: calc.days_in_month,
                daily_rate: calc.daily_rate,
                amount: calc.amount,
                payroll_month,
                notes,
                created_by,
            });

            return {
                success: true,
                message: "Leave encashment raised",
                data: { encashment, calculation: calc, balance_before: current.data.balance },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async listEncashments(company_id, filters = {}) {
        try {
            const encashments = await LeaveSalaryPayoutModel.listEncashments({ company_id, ...filters });
            return {
                success: true,
                data: {
                    count: encashments.length,
                    total_amount: round2(encashments.reduce((a, r) => a + Number(r.amount), 0)),
                    encashments,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async approveEncashment(company_id, id, approved_by) {
        return this._transition({
            company_id, id,
            find: () => LeaveSalaryPayoutModel.findEncashmentById(id),
            act: () => LeaveSalaryPayoutModel.approveEncashment(id, approved_by),
            noun: "Encashment",
            expected: "pending",
        });
    },

    async markEncashmentPaid(company_id, id, { payment_reference = null, payroll_month = null } = {}) {
        return this._transition({
            company_id, id,
            find: () => LeaveSalaryPayoutModel.findEncashmentById(id),
            act: () => LeaveSalaryPayoutModel.markEncashmentPaid(id, { payment_reference, payroll_month }),
            noun: "Encashment",
            expected: "approved",
        });
    },

    async cancelEncashment(company_id, id, cancelled_reason) {
        if (!cancelled_reason) {
            return { success: false, message: "A cancellation reason is required" };
        }
        return this._transition({
            company_id, id,
            find: () => LeaveSalaryPayoutModel.findEncashmentById(id),
            act: () => LeaveSalaryPayoutModel.cancelEncashment(id, cancelled_reason),
            noun: "Encashment",
            expected: "pending or approved",
        });
    },

    /**
     * Shared guard for every payout state change: exists, belongs to this
     * tenant, and was in the expected state. The conditional UPDATE in the model
     * is what actually enforces the last one — this only turns "no row" into a
     * message that says which state was expected.
     */
    async _transition({ company_id, id, find, act, noun, expected }) {
        try {
            const existing = await find();
            if (!existing) return { success: false, message: `${noun} not found` };
            if (String(existing.company_id) !== String(company_id)) {
                return { success: false, message: `${noun} does not belong to this company` };
            }

            const updated = await act();
            if (!updated) {
                return {
                    success: false,
                    message: `${noun} is ${existing.status} — this action needs it to be ${expected}.`,
                };
            }

            return { success: true, message: `${noun} updated`, data: updated };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // UNPAID LEAVE — indicative only
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * The spec sheet's unpaid-leave deduction, for the leave-salary screens.
     *
     * Payroll generation is the authority on what actually comes off a payslip
     * (service/payrollEngineService.js classifies every day and deducts there).
     * This endpoint deliberately writes nothing — two systems deducting the same
     * days is how an employee ends up docked twice.
     */
    async getUnpaidLeaveDeduction(company_id, employee_id, { payroll_month = null } = {}) {
        try {
            const row = await LeaveSalaryModel.getCalculationInputs(employee_id);
            if (!row || String(row.company_id) !== String(company_id)) {
                return { success: false, message: "Employee not found" };
            }

            const rules = resolveRules(await LeaveSalaryModel.getCompanyConfig(company_id));
            const ctx = resolveEmployeeContext(row, rules);

            let from_date = null;
            let to_date = null;
            if (payroll_month) {
                if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(payroll_month)) {
                    return { success: false, message: "payroll_month must be in YYYY-MM format" };
                }
                const [y, m] = payroll_month.split("-").map(Number);
                from_date = `${payroll_month}-01`;
                to_date = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
            }

            const unpaid_days = await LeaveSalaryModel.getUnpaidLeaveDays(employee_id, { from_date, to_date });

            return {
                success: true,
                data: {
                    employee_id,
                    employee_name: ctx.employee_name,
                    payroll_month,
                    currency: ctx.currency,
                    calculation_base: ctx.calculation_base,
                    ...calculateUnpaidLeaveDeduction({
                        unpaid_days,
                        basis_amount: ctx.basis_amount,
                        days_in_month: rules.days_in_month,
                    }),
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Employee self-service
    // ─────────────────────────────────────────────────────────────────────────

    async getForUser(user_id, company_id) {
        try {
            const employee = await EmployeeModel.findByUserAndCompany(user_id, company_id);
            if (!employee) {
                return { success: false, message: "No employee profile found for this user in this company" };
            }

            const result = await this.getForEmployee(employee.id, { include_ledger: true });
            if (!result.success) return result;

            // An employee sees their own bucket, not the company's setup
            // problems — those are for the admin screen to act on.
            const { warnings, ...balance } = result.data.balance;

            return {
                success: true,
                data: {
                    balance,
                    accrual_ledger: result.data.accrual_ledger,
                    advances: result.data.advances,
                    encashments: result.data.encashments,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // Used by the separation module, which needs the bucket without re-deriving
    // any of this. Exported deliberately rather than duplicated there.
    resolveRules,
    resolveEmployeeContext,
};

module.exports = LeaveSalaryService;
