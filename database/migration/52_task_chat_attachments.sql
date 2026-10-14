-- ============================================================
-- 52_task_chat_attachments.sql
-- Must run after 40_task_module.sql, 51_task_workflow_roles.sql
--
-- Remarks become the task's conversation: a message can carry a photo, and
-- a photo can be sent on its own. Voice notes stay in task_voice_notes (they
-- have their own cap and recorder rules) — the apps merge the two into one
-- thread by created_at.
-- ============================================================

ALTER TABLE task_comments
    ADD COLUMN IF NOT EXISTS attachment_url        TEXT,
    ADD COLUMN IF NOT EXISTS attachment_public_id  TEXT,
    ADD COLUMN IF NOT EXISTS attachment_type       VARCHAR(20),
    -- Names an admin who has no employee profile (employee_id is NULL then).
    ADD COLUMN IF NOT EXISTS author_user_id        UUID REFERENCES users(id) ON DELETE SET NULL;

-- A photo-only message has no text.
ALTER TABLE task_comments ALTER COLUMN comment DROP NOT NULL;

ALTER TABLE task_comments DROP CONSTRAINT IF EXISTS chk_task_comment_has_content;
ALTER TABLE task_comments
    ADD CONSTRAINT chk_task_comment_has_content
    CHECK (comment IS NOT NULL OR attachment_url IS NOT NULL);
