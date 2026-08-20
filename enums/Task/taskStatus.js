/**
 * Task Status
 *
 * The lifecycle of a task, and — more importantly — the transitions that are
 * legal between the states. Without an explicit machine the dashboard fills
 * with nonsense: tasks completed before they were started, cancelled work
 * being marked done a month later, employees closing their own overdue items
 * by jumping straight to 'completed'.
 *
 * Stored as VARCHAR (see chk_task_status in 40_task_module.sql) rather than
 * an integer enum, because these values are read straight off the wire by the
 * mobile app and appear in query strings.
 */

const TaskStatus = Object.freeze({
    OPEN:        "open",
    IN_PROGRESS: "in_progress",
    SUBMITTED:   "submitted",
    COMPLETED:   "completed",
    REOPENED:    "reopened",
    CANCELLED:   "cancelled",
});

const TaskStatusLabel = Object.freeze({
    [TaskStatus.OPEN]:        "Open",
    [TaskStatus.IN_PROGRESS]: "In Progress",
    [TaskStatus.SUBMITTED]:   "Submitted for Review",
    [TaskStatus.COMPLETED]:   "Completed",
    [TaskStatus.REOPENED]:    "Reopened",
    [TaskStatus.CANCELLED]:   "Cancelled",
});

/** Nothing moves out of these — they end the task's life. */
const TERMINAL_STATUSES = Object.freeze([TaskStatus.COMPLETED, TaskStatus.CANCELLED]);

/**
 * Statuses that still count as live work: the deadline sweep looks at these,
 * the "open tasks" counters count these. Kept in one place so the job, the
 * dashboard and the SQL partial index in 40_task_module.sql agree.
 */
const LIVE_STATUSES = Object.freeze([
    TaskStatus.OPEN,
    TaskStatus.IN_PROGRESS,
    TaskStatus.SUBMITTED,
    TaskStatus.REOPENED,
]);

/** from → [allowed to] */
const ALLOWED_TRANSITIONS = Object.freeze({
    [TaskStatus.OPEN]:        [TaskStatus.IN_PROGRESS, TaskStatus.SUBMITTED, TaskStatus.CANCELLED],
    [TaskStatus.IN_PROGRESS]: [TaskStatus.SUBMITTED, TaskStatus.COMPLETED, TaskStatus.OPEN, TaskStatus.CANCELLED],
    [TaskStatus.SUBMITTED]:   [TaskStatus.COMPLETED, TaskStatus.REOPENED, TaskStatus.IN_PROGRESS, TaskStatus.CANCELLED],
    [TaskStatus.REOPENED]:    [TaskStatus.IN_PROGRESS, TaskStatus.SUBMITTED, TaskStatus.COMPLETED, TaskStatus.CANCELLED],
    [TaskStatus.COMPLETED]:   [TaskStatus.REOPENED],
    [TaskStatus.CANCELLED]:   [],
});

/**
 * What an EMPLOYEE may do to their own task.
 *
 * The deliberate omission is 'completed' — an employee moves work to
 * `submitted` and the assigner signs it off. Self-completion would make
 * every on-time/late number in the performance dashboard self-reported,
 * which is the fastest way to make the dashboard worthless.
 *
 * They also cannot cancel: cancelling is an assignment decision.
 * Admins and HODs are not restricted beyond ALLOWED_TRANSITIONS.
 */
const EMPLOYEE_ALLOWED_TARGETS = Object.freeze([
    TaskStatus.IN_PROGRESS,
    TaskStatus.SUBMITTED,
    TaskStatus.OPEN,
]);

const isValidStatus = (status) => Object.values(TaskStatus).includes(status);

const isTerminal = (status) => TERMINAL_STATUSES.includes(status);

/** Can this task move from → to at all, regardless of who is asking? */
const canTransition = (from, to) =>
    isValidStatus(to) && (ALLOWED_TRANSITIONS[from] || []).includes(to);

module.exports = {
    TaskStatus,
    TaskStatusLabel,
    TERMINAL_STATUSES,
    LIVE_STATUSES,
    ALLOWED_TRANSITIONS,
    EMPLOYEE_ALLOWED_TARGETS,
    isValidStatus,
    isTerminal,
    canTransition,
};
