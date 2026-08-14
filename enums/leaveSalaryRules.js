/**
 * Leave-salary defaults and the vocabulary the module shares with the frontend.
 *
 * Same pattern as enums/gratuityRules.js: one source of truth that drives the
 * calculation when no company config row exists AND is served to the frontend
 * so the settings form can show the statutory baseline before an admin edits it.
 *
 * Figures follow UAE Federal Decree-Law No. 33 of 2021, Art. 29:
 *   - 30 calendar days of annual leave a year once a year of service is complete
 *   - 2 calendar days a month between 6 and 12 months of service
 *   - no entitlement below 6 months
 *   - leave salary is paid on the contractual wage BEFORE the leave starts
 *
 * Daily rate uses a 30-day divisor — the UAE calendar-day convention, not
 * working days. Overridable, because other jurisdictions divide differently
 * (India's gratuity divisor is 26, for instance).
 *
 * Not legal advice — confirm against your jurisdiction before go-live.
 */

const DEFAULT_LEAVE_SALARY_RULES = Object.freeze({
    days_in_month: 30,
    annual_entitlement_days: 30,
    accrual_rate_full: 2.5,      // 30 / 12, applied from full_service_months on
    accrual_rate_partial: 2,     // Art. 29(2), min_service_months .. full_service_months
    min_service_months: 6,
    full_service_months: 12,
    default_calculation_base: "basic",
    max_balance_days: null,      // null = no carry-forward ceiling
    advance_payment_enabled: true,
    encashment_enabled: true,
});

/** Which salary figure the daily rate is built from. */
const CalculationBase = Object.freeze({
    BASIC: "basic",     // employee_salary_structures.basic_salary
    GROSS: "gross",     // employee_salary_structures.actual_salary
    CUSTOM: "custom",   // employee_leave_salary_configs.custom_basis_amount
});

/** Lifecycle shared by advances and encashments. */
const PayoutStatus = Object.freeze({
    PENDING: "pending",
    APPROVED: "approved",
    PAID: "paid",
    CANCELLED: "cancelled",
});

const EncashmentType = Object.freeze({
    FINAL_SETTLEMENT: "final_settlement",
    IN_SERVICE: "in_service",
});

const SeparationType = Object.freeze({
    RESIGNATION: "resignation",
    TERMINATION: "termination",
});

const SeparationStatus = Object.freeze({
    PENDING: "pending",
    APPROVED: "approved",
    REJECTED: "rejected",
    WITHDRAWN: "withdrawn",
    CANCELLED: "cancelled",
    COMPLETED: "completed",
});

/**
 * Termination grounds. `forfeits_gratuity_by_default` is a HINT for the UI, not
 * a rule the service applies — forfeiture (UAE Art. 44) always has to be set
 * deliberately with a stated reason, so it can be defended later.
 */
const TerminationType = Object.freeze({
    WITH_CAUSE: "with_cause",
    WITHOUT_CAUSE: "without_cause",
    PROBATION: "probation",
    REDUNDANCY: "redundancy",
    CONTRACT_END: "contract_end",
    ABSCONDED: "absconded",
    RETIREMENT: "retirement",
    DEATH: "death",
});

const TERMINATION_TYPE_META = Object.freeze({
    with_cause:    { label: "Dismissal for cause",      requires_notice: false, forfeits_gratuity_by_default: true  },
    without_cause: { label: "Termination without cause", requires_notice: true,  forfeits_gratuity_by_default: false },
    probation:     { label: "Failed probation",          requires_notice: true,  forfeits_gratuity_by_default: false },
    redundancy:    { label: "Redundancy",                requires_notice: true,  forfeits_gratuity_by_default: false },
    contract_end:  { label: "Contract expiry",           requires_notice: false, forfeits_gratuity_by_default: false },
    absconded:     { label: "Absconded",                 requires_notice: false, forfeits_gratuity_by_default: true  },
    retirement:    { label: "Retirement",                requires_notice: true,  forfeits_gratuity_by_default: false },
    death:         { label: "Death in service",          requires_notice: false, forfeits_gratuity_by_default: false },
});

/** Statuses in which a case is still live — used for the one-open-case rule. */
const OPEN_SEPARATION_STATUSES = Object.freeze([
    SeparationStatus.PENDING,
    SeparationStatus.APPROVED,
]);

/** Employee status written when a case completes. */
const SEPARATION_EMPLOYEE_STATUS = Object.freeze({
    resignation: "resigned",
    termination: "terminated",
});

module.exports = {
    DEFAULT_LEAVE_SALARY_RULES,
    CalculationBase,
    PayoutStatus,
    EncashmentType,
    SeparationType,
    SeparationStatus,
    TerminationType,
    TERMINATION_TYPE_META,
    OPEN_SEPARATION_STATUSES,
    SEPARATION_EMPLOYEE_STATUS,
};
