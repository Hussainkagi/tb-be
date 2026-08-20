const NotificationService = require("../../service/notificationService");
const { TaskStatusLabel } = require("../../enums/Task/taskStatus");
const { TaskPriorityLabel } = require("../../enums/Task/taskPriority");
const { formatDueForDisplay } = require("../../utils/Task/taskTime");

/**
 * Task notifications.
 *
 * A thin layer over NotificationService — the pipeline (templates, audience
 * rules, per-device fan-out, the retry queue, the per-minute dispatcher)
 * already exists and is shared with leave, payroll and attendance. This file
 * only decides WHO hears about WHAT, and shapes the template variables.
 *
 * Every send goes out on both channels for the same reason 31_payslip_
 * notification.sql documents: fan-out writes a `push` recipient row only for
 * employees with an active device token, so a push-only event is invisible to
 * anyone who lives in the web panel.
 */

const CHANNELS = ["push", "in_app"];

/**
 * Send one logical event on every channel.
 *
 * Each channel is an independent notification row resolving its own template,
 * so one missing template cannot swallow the other copy. Failures are
 * reported, never thrown: a task must not fail to be assigned because a push
 * did not go out.
 */
const dispatch = async (payload) => {
    const byChannel = {};

    for (const channel of CHANNELS) {
        try {
            byChannel[channel] = await NotificationService.send({ ...payload, channel });
        } catch (error) {
            byChannel[channel] = { success: false, message: error.message };
        }
    }

    const delivered = Object.entries(byChannel)
        .filter(([, r]) => r.success && !r.skipped)
        .map(([channel]) => channel);

    return { success: delivered.length > 0, delivered_channels: delivered, channels: byChannel };
};

/** "due 25 Aug 2026, 5:00 PM" — or nothing at all, for a task with no deadline. */
const dueClause = (task) => {
    if (!task.due_at) return "";
    const zone = task.due_timezone || task.company_timezone;
    return `, due ${formatDueForDisplay(task.due_at, zone)}`;
};

const baseVariables = (task) => ({
    task_id: task.id,
    task_title: task.title,
    category_name: task.category_name || "Task",
    priority_label: TaskPriorityLabel[task.priority] || task.priority,
    status_label: TaskStatusLabel[task.status] || task.status,
    due_display: formatDueForDisplay(task.due_at, task.due_timezone || task.company_timezone),
    due_clause: dueClause(task),
});

const TaskNotificationService = {
    // ─────────────────────────────────────────────────────────────────────
    // A task has been given to someone
    // ─────────────────────────────────────────────────────────────────────
    async notifyAssigned({ task, assigned_by_name, is_reassignment = false }) {
        return dispatch({
            company_id: task.company_id,
            branch_id: task.branch_id || null,
            notification_type: "task_assigned",
            template_code: is_reassignment ? "task_reassigned" : "task_assigned",
            template_variables: {
                ...baseVariables(task),
                assigned_by_name: assigned_by_name || "Your manager",
            },
            entity_type: "tasks",
            entity_id: task.id,
            audience: { type: "specific_employee", employee_id: task.assigned_to_employee_id },
        });
    },

    // ─────────────────────────────────────────────────────────────────────
    // The status moved
    //
    // Who hears about it depends on who moved it. The assignee does not need
    // a push telling them about the button they just pressed, and the
    // watchers (assigner + HOD) do not need one for their own action.
    // ─────────────────────────────────────────────────────────────────────
    async notifyStatusChange({ task, previous_status, actor_name, actor_employee_id, remark, recipient_employee_ids = [] }) {
        const recipients = [...new Set(recipient_employee_ids.filter(Boolean))]
            .filter((id) => id !== actor_employee_id);

        if (!recipients.length) return { success: true, delivered_channels: [], skipped: true };

        return dispatch({
            company_id: task.company_id,
            branch_id: task.branch_id || null,
            notification_type: "task_status_update",
            template_code: "task_status_update",
            template_variables: {
                ...baseVariables(task),
                actor_name: actor_name || "Someone",
                previous_status_label: TaskStatusLabel[previous_status] || previous_status,
                remark_clause: remark ? `Remark: ${remark}` : "",
            },
            entity_type: "tasks",
            entity_id: task.id,
            audience: { type: "specific_employees", employee_ids: recipients },
        });
    },

    // ─────────────────────────────────────────────────────────────────────
    // The deadline is close — sent by jobs/Task/taskDeadlineJob.js
    //
    // scheduled_at is ALWAYS set, never left null, even when the moment has
    // already passed. Two reasons: the notification lands at a civilised
    // local hour rather than whenever the cron happened to fire, and
    // uq_task_reminder_once_per_day keys on scheduled_at::date — a null there
    // would not collide with anything, and the dedup guarantee would quietly
    // stop working. The per-minute dispatcher picks up a past scheduled_at on
    // its next pass.
    // ─────────────────────────────────────────────────────────────────────
    async notifyDueSoon({ task, scheduled_at, timezone }) {
        return dispatch({
            company_id: task.company_id,
            notification_type: "task_due_reminder",
            template_code: "task_due_reminder",
            template_variables: baseVariables(task),
            entity_type: "tasks",
            entity_id: task.id,
            scheduled_at,
            timezone,
            audience: { type: "specific_employee", employee_id: task.assigned_to_employee_id },
        });
    },

    /** The deadline has passed and the work is still open. */
    async notifyOverdue({ task, scheduled_at, timezone, notify_employee_ids = [] }) {
        const recipients = [...new Set([task.assigned_to_employee_id, ...notify_employee_ids].filter(Boolean))];

        return dispatch({
            company_id: task.company_id,
            notification_type: "task_overdue",
            template_code: "task_overdue",
            template_variables: baseVariables(task),
            entity_type: "tasks",
            entity_id: task.id,
            scheduled_at,
            timezone,
            audience: { type: "specific_employees", employee_ids: recipients },
        });
    },
};

module.exports = TaskNotificationService;
