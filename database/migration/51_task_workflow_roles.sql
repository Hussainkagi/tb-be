-- ============================================================
-- 51_task_workflow_roles.sql
-- Must run after 40_task_module.sql, 41_task_notifications.sql,
--                49_task_voice_note.sql
--
-- "Task Workflow – Roles, Buttons & Notifications" (Oct 2026).
--
-- The status machine stops asking "is this person a manager?" and starts
-- asking "what is this person ON THIS TASK?":
--
--   taskee   assigned_to_employee_id     does the work
--   tasker   assigned_by_employee_id     reviews: approve, send back, cancel
--            (or created_by_user_id, for an admin with no employee profile)
--   watcher  task_watchers               may approve; is notified
--   admin    user_companies.role = 0     may only cancel
--
-- The rules themselves live in enums/Task/taskStatus.js (TRANSITION_ROLES).
-- This migration only adds what the rules need to record and send:
--
--   1. task_status_history gains the task role the change was made in, and
--      the acting user — an admin with no employee profile can now cancel,
--      and the history has to name them.
--   2. task_voice_notes — the Tasker ⇄ Taskee voice note chain.
--   3. tasks.voice_note_chain_limit — the per-task cap, plan-gated, never
--      above 15.
--   4. Templates for the events the old flow never announced: watchers
--      hearing about an assignment, a cancellation with its reason, and a
--      new remark or voice note.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Who moved it, in which capacity on the task
--
-- changed_by_role keeps its meaning (the company role, or 'hod') so nothing
-- that already reads it changes. changed_by_task_role is the new, spec-level
-- answer: 'taskee' | 'tasker' | 'watcher' | 'admin'.
-- ------------------------------------------------------------
ALTER TABLE task_status_history
    ADD COLUMN IF NOT EXISTS changed_by_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS changed_by_task_role  VARCHAR(20);


-- ------------------------------------------------------------
-- 2. task_voice_notes
--
-- Separate from tasks.voice_note_url, which is the assigner's brief attached
-- at creation and stays part of the task's terms. This is the conversation
-- that follows: Tasker and Taskee only, in time order, read by everyone who
-- can see the task.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_voice_notes (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    task_id             UUID            NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    company_id          UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

    -- employee_id is NULL only for a tasker who is an admin without an
    -- employee profile; sender_user_id always names the person.
    sender_employee_id  UUID            REFERENCES employees(id) ON DELETE SET NULL,
    sender_user_id      UUID            REFERENCES users(id) ON DELETE SET NULL,
    sender_task_role    VARCHAR(20)     NOT NULL,

    url                 TEXT            NOT NULL,
    public_id           TEXT,
    duration_seconds    INT,
    format              VARCHAR(20),

    deleted_at          TIMESTAMP,
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_task_voice_note_role CHECK (sender_task_role IN ('taskee', 'tasker'))
);

CREATE INDEX IF NOT EXISTS idx_task_voice_notes_task
    ON task_voice_notes (task_id, created_at)
    WHERE deleted_at IS NULL;


-- ------------------------------------------------------------
-- 3. The per-task cap
--
-- A static per-plan number like tasks.voice_note_max_seconds, not a COUNT
-- of company-wide rows, so it is read straight off the entitlement snapshot.
-- The service clamps it to 15 whatever is configured here.
--
-- The tier numbers below 15 are still an open question in the spec, so every
-- plan starts at the maximum; change a row here (or in the plan editor) once
-- they are decided.
-- ------------------------------------------------------------
INSERT INTO plan_features (key, category, label, value_type, is_enforceable, is_visible, sort_order) VALUES
    ('tasks.voice_note_chain_limit', 'Tasks', 'Voice notes per task', 'limit', TRUE, TRUE, 660)
ON CONFLICT (key) DO NOTHING;

WITH seed(plan_code, feature_key, limit_value, note) AS (
    VALUES
    ('trial', 'tasks.voice_note_chain_limit', 15, '15 voice notes per task'),
    ('free',  'tasks.voice_note_chain_limit', 15, '15 voice notes per task'),
    ('pro',   'tasks.voice_note_chain_limit', 15, '15 voice notes per task'),
    ('gold',  'tasks.voice_note_chain_limit', 15, '15 voice notes per task')
)
INSERT INTO plan_feature_values (plan_id, feature_key, limit_value, note)
SELECT p.id, s.feature_key, s.limit_value, s.note
FROM seed s
JOIN plans p ON p.code = s.plan_code
ON CONFLICT (plan_id, feature_key) DO NOTHING;


-- ------------------------------------------------------------
-- 4. Templates
--
-- All reuse notification types 41_task_notifications.sql already allows, so
-- no CHECK constraint has to be rewritten (same approach as
-- 50_task_reassignment_limit.sql).
-- ------------------------------------------------------------
INSERT INTO notification_templates (
    company_id, template_code, notification_type, channel,
    title_template, body_template, deep_link_template
) VALUES

-- ── A task you watch was assigned ───────────────────────────────────────
(NULL, 'task_assigned_watcher', 'task_assigned', 'push',
 '👀 New task — {{task_title}}',
 '{{assigned_by_name}} assigned "{{task_title}}" to {{assignee_name}}{{due_clause}}.',
 '/tasks/{{task_id}}'),

(NULL, 'task_assigned_watcher', 'task_assigned', 'in_app',
 'Watching: {{task_title}}',
 '{{assigned_by_name}} assigned "{{task_title}}" ({{priority_label}} priority) to {{assignee_name}}{{due_clause}}. You are a watcher on it.',
 '/tasks/{{task_id}}'),

-- ── Cancelled, with the reason ──────────────────────────────────────────
(NULL, 'task_cancelled', 'task_status_update', 'push',
 '🚫 Task cancelled — {{task_title}}',
 '{{actor_name}} ({{actor_role_label}}) cancelled "{{task_title}}". Reason: {{cancel_reason}}',
 '/tasks/{{task_id}}'),

(NULL, 'task_cancelled', 'task_status_update', 'in_app',
 'Cancelled: {{task_title}}',
 '{{actor_name}} ({{actor_role_label}}) cancelled "{{task_title}}". Reason: {{cancel_reason}}',
 '/tasks/{{task_id}}'),

-- ── New remark ──────────────────────────────────────────────────────────
(NULL, 'task_remark_added', 'task_status_update', 'push',
 '💬 {{actor_name}} on {{task_title}}',
 '{{remark_preview}}',
 '/tasks/{{task_id}}'),

(NULL, 'task_remark_added', 'task_status_update', 'in_app',
 'New remark: {{task_title}}',
 '{{actor_name}}: {{remark_preview}}',
 '/tasks/{{task_id}}'),

-- ── New voice note ──────────────────────────────────────────────────────
(NULL, 'task_voice_note_added', 'task_status_update', 'push',
 '🎙️ {{actor_name}} on {{task_title}}',
 'New voice note ({{duration_display}}). Tap to listen.',
 '/tasks/{{task_id}}'),

(NULL, 'task_voice_note_added', 'task_status_update', 'in_app',
 'New voice note: {{task_title}}',
 '{{actor_name}} sent a voice note ({{duration_display}}) on "{{task_title}}".',
 '/tasks/{{task_id}}')

ON CONFLICT (company_id, template_code, channel) DO NOTHING;
