/**
 * Task performance scoring
 *
 * The single definition of "how well did this person do", shared by the
 * nightly rollup, the dashboard API and any future export. Keeping it here
 * rather than inline in the rollup query is what stops the three from
 * drifting into three different answers for the same employee.
 *
 * Every number below is a product decision, not a technical one — change it
 * knowingly, and remember that task_performance_daily rows already written
 * keep the score they were computed with (see 42_task_performance.sql).
 */

const { TaskPriority } = require("./taskPriority");

/**
 * Points for completing one task, by criticality.
 *
 * Deliberately not linear: an urgent task is worth roughly three routine
 * ones, so a person who clears the hard queue outranks one who clears a pile
 * of trivia.
 */
const COMPLETION_POINTS = Object.freeze({
    [TaskPriority.URGENT]: 6,
    [TaskPriority.HIGH]:   4,
    [TaskPriority.MEDIUM]: 2,
    [TaskPriority.LOW]:    1,
});

/**
 * Multiplier applied when the task was completed after its deadline.
 *
 * Late work still earns something — zero would mean an employee handed an
 * impossible deadline scores the same as one who ignored the task entirely,
 * and that reads as a punishment for being given hard work.
 */
const LATE_COMPLETION_MULTIPLIER = 0.5;

/**
 * Grace period before a completion counts as late.
 *
 * A task marked done four minutes past a 5 PM deadline is on time by any
 * human reading of the word.
 */
const ON_TIME_GRACE_MINUTES = 15;

/**
 * Weights for the composite score returned by the dashboard summary.
 * They sum to 1 — the result is a 0-100 figure.
 */
const SCORE_WEIGHTS = Object.freeze({
    completion_rate: 0.5,   // completed / assigned
    on_time_rate:    0.4,   // on-time / completed
    quality_rate:    0.1,   // 1 - (reopened / completed)
});

/** How many days of history the rollup will rebuild in one catch-up pass. */
const ROLLUP_BACKFILL_DAYS = 3;

/**
 * Was this completion on time?
 *
 * A task with no deadline can never be late — the alternative (treating
 * "no due date" as instantly overdue) would poison every average.
 */
const isOnTime = (completedAt, dueAt) => {
    if (!dueAt) return true;
    if (!completedAt) return false;

    const completed = new Date(completedAt).getTime();
    const due = new Date(dueAt).getTime() + ON_TIME_GRACE_MINUTES * 60 * 1000;

    return completed <= due;
};

/** Points for one completed task. */
const pointsFor = (priority, onTime) => {
    const base = COMPLETION_POINTS[priority] ?? COMPLETION_POINTS[TaskPriority.MEDIUM];
    return onTime ? base : base * LATE_COMPLETION_MULTIPLIER;
};

/**
 * Composite 0-100 score from a set of totals.
 * Returns null when the employee had nothing assigned in the window —
 * a zero would rank someone on leave below someone who performed badly.
 */
const compositeScore = ({ assigned = 0, completed = 0, on_time = 0, reopened = 0 } = {}) => {
    if (!assigned) return null;

    const completionRate = completed / assigned;
    const onTimeRate = completed ? on_time / completed : 0;
    const qualityRate = completed ? Math.max(0, 1 - reopened / completed) : 0;

    const score =
        completionRate * SCORE_WEIGHTS.completion_rate +
        onTimeRate * SCORE_WEIGHTS.on_time_rate +
        qualityRate * SCORE_WEIGHTS.quality_rate;

    return Math.round(score * 100 * 100) / 100;
};

module.exports = {
    COMPLETION_POINTS,
    LATE_COMPLETION_MULTIPLIER,
    ON_TIME_GRACE_MINUTES,
    SCORE_WEIGHTS,
    ROLLUP_BACKFILL_DAYS,
    isOnTime,
    pointsFor,
    compositeScore,
};
