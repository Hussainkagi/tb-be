/**
 * Payroll run — steps, statuses and the transitions between them.
 *
 * The whole payroll module is one state machine now. Everything that used
 * to be "go to tab 3 and hope you did tab 2" is expressed here instead.
 */

// ─── Steps, in order ─────────────────────────────────────────
const STEP = Object.freeze({
    SETUP: "setup",         // period created / selected
    GENERATE: "generate",   // salaries computed from attendance
    ADJUST: "adjust",       // bonuses, deductions, penalties, loans
    REVIEW: "review",       // maker checks the numbers
    APPROVAL: "approval",   // submitted — waiting on the checker
    PAYMENT: "payment",     // approved — mark as paid
    PAYSLIPS: "payslips",   // generate + email payslips
    DONE: "done",
});

const STEP_ORDER = [
    STEP.SETUP,
    STEP.GENERATE,
    STEP.ADJUST,
    STEP.REVIEW,
    STEP.APPROVAL,
    STEP.PAYMENT,
    STEP.PAYSLIPS,
    STEP.DONE,
];

const STEP_LABEL = Object.freeze({
    [STEP.SETUP]: "Period Setup",
    [STEP.GENERATE]: "Generate Payroll",
    [STEP.ADJUST]: "Adjustments",
    [STEP.REVIEW]: "Review",
    [STEP.APPROVAL]: "Approval",
    [STEP.PAYMENT]: "Payment",
    [STEP.PAYSLIPS]: "Payslips",
    [STEP.DONE]: "Completed",
});

// ─── Run statuses ────────────────────────────────────────────
const RUN_STATUS = Object.freeze({
    DRAFT: "draft",
    IN_PROGRESS: "in_progress",
    PENDING_APPROVAL: "pending_approval",
    APPROVED: "approved",
    REJECTED: "rejected",
    PAID: "paid",
    COMPLETED: "completed",
    CANCELLED: "cancelled",
});

const RUN_STATUS_TRANSITIONS = Object.freeze({
    [RUN_STATUS.DRAFT]: [RUN_STATUS.IN_PROGRESS, RUN_STATUS.CANCELLED],
    [RUN_STATUS.IN_PROGRESS]: [RUN_STATUS.PENDING_APPROVAL, RUN_STATUS.APPROVED, RUN_STATUS.CANCELLED],
    [RUN_STATUS.PENDING_APPROVAL]: [RUN_STATUS.APPROVED, RUN_STATUS.REJECTED, RUN_STATUS.CANCELLED],
    [RUN_STATUS.REJECTED]: [RUN_STATUS.IN_PROGRESS, RUN_STATUS.PENDING_APPROVAL, RUN_STATUS.CANCELLED],
    [RUN_STATUS.APPROVED]: [RUN_STATUS.PAID, RUN_STATUS.CANCELLED],
    [RUN_STATUS.PAID]: [RUN_STATUS.COMPLETED],
    [RUN_STATUS.COMPLETED]: [],
    [RUN_STATUS.CANCELLED]: [],
});

// Statuses in which the maker may still change numbers.
const EDITABLE_STATUSES = [
    RUN_STATUS.DRAFT,
    RUN_STATUS.IN_PROGRESS,
    RUN_STATUS.REJECTED,
];

// ─── Per-employee payroll statuses ───────────────────────────
const PAYROLL_STATUS = Object.freeze({
    DRAFT: "draft",
    PROCESSED: "processed",
    APPROVED: "approved",
    REJECTED: "rejected",
    PAID: "paid",
    CANCELLED: "cancelled",
});

const PAYROLL_STATUS_TRANSITIONS = Object.freeze({
    [PAYROLL_STATUS.DRAFT]: [PAYROLL_STATUS.PROCESSED, PAYROLL_STATUS.CANCELLED],
    [PAYROLL_STATUS.PROCESSED]: [PAYROLL_STATUS.APPROVED, PAYROLL_STATUS.REJECTED, PAYROLL_STATUS.CANCELLED],
    [PAYROLL_STATUS.APPROVED]: [PAYROLL_STATUS.PAID, PAYROLL_STATUS.CANCELLED],
    [PAYROLL_STATUS.REJECTED]: [PAYROLL_STATUS.PROCESSED, PAYROLL_STATUS.CANCELLED],
    [PAYROLL_STATUS.PAID]: [],
    [PAYROLL_STATUS.CANCELLED]: [],
});

// ─── Run events (audit trail actions) ────────────────────────
const RUN_ACTION = Object.freeze({
    CREATED: "created",
    GENERATED: "generated",
    REGENERATED: "regenerated",
    ADJUSTMENT_CHANGED: "adjustment_changed",
    REVIEWED: "reviewed",
    SUBMITTED: "submitted_for_approval",
    APPROVED: "approved",
    REJECTED: "rejected",
    PAID: "paid",
    PAYSLIPS_GENERATED: "payslips_generated",
    PAYSLIPS_SENT: "payslips_sent",
    EMPLOYEES_NOTIFIED: "employees_notified",
    COMPLETED: "completed",
    CANCELLED: "cancelled",
    STEP_MOVED: "step_moved",
});

const ACTOR_ROLE = Object.freeze({
    MAKER: "maker",
    CHECKER: "checker",
    SYSTEM: "system",
});

/** Index of a step in the canonical order (-1 when unknown). */
const stepIndex = (step) => STEP_ORDER.indexOf(step);

/** TRUE when `step` is at or beyond `target` in the flow. */
const isStepAtLeast = (step, target) => stepIndex(step) >= stepIndex(target);

/** The step that follows `step`, or DONE at the end of the flow. */
const nextStep = (step) => {
    const i = stepIndex(step);
    if (i < 0 || i >= STEP_ORDER.length - 1) return STEP.DONE;
    return STEP_ORDER[i + 1];
};

module.exports = {
    STEP,
    STEP_ORDER,
    STEP_LABEL,
    RUN_STATUS,
    RUN_STATUS_TRANSITIONS,
    EDITABLE_STATUSES,
    PAYROLL_STATUS,
    PAYROLL_STATUS_TRANSITIONS,
    RUN_ACTION,
    ACTOR_ROLE,
    stepIndex,
    isStepAtLeast,
    nextStep,
};
