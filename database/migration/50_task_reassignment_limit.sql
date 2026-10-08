-- ============================================================
-- One reassignment per task, and telling the old assignee
-- ============================================================
--
-- `reassigned_at` is set the first (and only allowed) time a task's
-- assignee changes after creation — see taskService.js:updateTask and
-- TaskModel.markReassigned. A second reassignment attempt is rejected with
-- a message pointing at creating a new task instead, so the history a task
-- accumulates (comments, status log) always belongs to one continuous
-- thread of work, not work that silently jumped between three different
-- people.
--
-- `task_unassigned` is the other half of a reassignment: the PREVIOUS
-- assignee is told their task moved to someone else, instead of it just
-- vanishing from their board. Reuses the already-allowed
-- 'task_status_update' notification_type — no CHECK constraint changes
-- needed, unlike 41_task_notifications.sql's new types.
-- ============================================================

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS reassigned_at TIMESTAMP;

INSERT INTO notification_templates (
    company_id, template_code, notification_type, channel,
    title_template, body_template, deep_link_template
) VALUES

(NULL, 'task_unassigned', 'task_status_update', 'push',
 'Task Reassigned — {{task_title}}',
 '{{reassigned_by_name}} moved "{{task_title}}" to someone else. It is no longer on your board.',
 '/tasks'),

(NULL, 'task_unassigned', 'task_status_update', 'in_app',
 'Reassigned away: {{task_title}}',
 '{{reassigned_by_name}} reassigned "{{task_title}}" ({{priority_label}} priority) to someone else{{due_clause}}.',
 '/tasks')

ON CONFLICT (company_id, template_code, channel) DO NOTHING;
