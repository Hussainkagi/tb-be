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
    [TaskStatus.OPEN]:        "To Do",
    [TaskStatus.IN_PROGRESS]: "In Progress",
    [TaskStatus.SUBMITTED]:   "In Review",
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

/**
 * The roles a person can hold ON A TASK — not in the company.
 *
 * Every button in the workflow spec ("Task Workflow – Roles, Buttons &
 * Notifications") is granted to one of these. One person can hold several at
 * once (an admin who assigned the task is its tasker AND an admin; someone who
 * assigned work to themselves is taskee AND tasker), and gets the union.
 *
 *   taskee   the person it is assigned to — does the work
 *   tasker   the person who assigned it — reviews it
 *   watcher  added to follow it (the assignee's HOD is added automatically)
 *   admin    the company admin — may only cancel
 */
const TaskRole = Object.freeze({
    TASKEE:  "taskee",
    TASKER:  "tasker",
    WATCHER: "watcher",
    ADMIN:   "admin",
});

const TaskRoleLabel = Object.freeze({
    [TaskRole.TASKEE]:  "Taskee",
    [TaskRole.TASKER]:  "Tasker",
    [TaskRole.WATCHER]: "Watcher",
    [TaskRole.ADMIN]:   "Admin",
});

/**
 * from → to → the task roles that may make that move. This IS the button
 * table in the spec; a move that is not listed here does not exist.
 *
 *   Start Work          To Do       → In Progress   taskee
 *   Move to To Do       In Progress → To Do         taskee
 *   Submit for Review   In Progress → In Review     taskee
 *   Approve & Complete  In Review   → Completed     tasker, watcher
 *   Send Back (Reopen)  In Review   → Reopened      tasker
 *   Pick Back Up        Reopened    → In Progress   taskee
 *   Cancel Task         any live    → Cancelled     tasker, admin
 *
 * Only the taskee moves work forward, and nobody can complete their own work
 * unless they are also its tasker or a watcher on it — so every on-time number
 * on the performance dashboard has a second person behind it.
 */
const CANCELLERS = Object.freeze([TaskRole.TASKER, TaskRole.ADMIN]);

const TRANSITION_ROLES = Object.freeze({
    [TaskStatus.OPEN]: {
        [TaskStatus.IN_PROGRESS]: [TaskRole.TASKEE],
        [TaskStatus.CANCELLED]:   CANCELLERS,
    },
    [TaskStatus.IN_PROGRESS]: {
        [TaskStatus.OPEN]:      [TaskRole.TASKEE],
        [TaskStatus.SUBMITTED]: [TaskRole.TASKEE],
        [TaskStatus.CANCELLED]: CANCELLERS,
    },
    [TaskStatus.SUBMITTED]: {
        [TaskStatus.COMPLETED]: [TaskRole.TASKER, TaskRole.WATCHER],
        [TaskStatus.REOPENED]:  [TaskRole.TASKER],
        [TaskStatus.CANCELLED]: CANCELLERS,
    },
    [TaskStatus.REOPENED]: {
        [TaskStatus.IN_PROGRESS]: [TaskRole.TASKEE],
        [TaskStatus.CANCELLED]:   CANCELLERS,
    },
    [TaskStatus.COMPLETED]: {},
    [TaskStatus.CANCELLED]: {},
});

/** from → [allowed to], regardless of who is asking. Derived from TRANSITION_ROLES. */
const ALLOWED_TRANSITIONS = Object.freeze(
    Object.fromEntries(
        Object.entries(TRANSITION_ROLES).map(([from, targets]) => [from, Object.keys(targets)])
    )
);

/**
 * The role, out of those this person holds, that permits from → to — or
 * null. The role returned is the one recorded in the history, so it is the
 * first match in the order the spec's table lists them.
 */
const roleForTransition = (from, to, roles = []) => {
    const permitted = TRANSITION_ROLES[from]?.[to] || [];
    return permitted.find((role) => roles.includes(role)) || null;
};

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
    TaskRole,
    TaskRoleLabel,
    TRANSITION_ROLES,
    ALLOWED_TRANSITIONS,
    roleForTransition,
    isValidStatus,
    isTerminal,
    canTransition,
};
