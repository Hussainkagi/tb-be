/**
 * Task Priority (criticality)
 *
 * A fixed list, NOT a company-configurable table. Three things depend on
 * these being a known, ordered set:
 *
 *   1. list ordering — "most critical first" needs a comparable rank
 *   2. the deadline sweep — urgent work is reminded earlier
 *   3. the performance dashboard — points are weighted by criticality
 *
 * A company that wants different wording renames the label in its UI; the
 * stored key never changes. See chk_task_priority in 40_task_module.sql.
 */

const TaskPriority = Object.freeze({
    URGENT: "urgent",
    HIGH:   "high",
    MEDIUM: "medium",
    LOW:    "low",
});

const TaskPriorityLabel = Object.freeze({
    [TaskPriority.URGENT]: "Urgent",
    [TaskPriority.HIGH]:   "High",
    [TaskPriority.MEDIUM]: "Medium",
    [TaskPriority.LOW]:    "Low",
});

/** Lower number = more critical. Used for ORDER BY in list queries. */
const TaskPriorityRank = Object.freeze({
    [TaskPriority.URGENT]: 1,
    [TaskPriority.HIGH]:   2,
    [TaskPriority.MEDIUM]: 3,
    [TaskPriority.LOW]:    4,
});

/**
 * How many days before the deadline the reminder goes out.
 *
 * One day is the rule the module promises. Urgent work gets two, because a
 * single day's warning on something critical usually arrives too late to
 * change the outcome — and the dedup index is per day, so the two reminders
 * for an urgent task do not collide.
 */
const REMINDER_LEAD_DAYS = Object.freeze({
    [TaskPriority.URGENT]: 2,
    [TaskPriority.HIGH]:   1,
    [TaskPriority.MEDIUM]: 1,
    [TaskPriority.LOW]:    1,
});

const DEFAULT_PRIORITY = TaskPriority.MEDIUM;

const isValidPriority = (priority) => Object.values(TaskPriority).includes(priority);

module.exports = {
    TaskPriority,
    TaskPriorityLabel,
    TaskPriorityRank,
    REMINDER_LEAD_DAYS,
    DEFAULT_PRIORITY,
    isValidPriority,
};
