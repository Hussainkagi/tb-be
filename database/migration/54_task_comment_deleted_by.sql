-- ============================================================
-- 54_task_comment_deleted_by.sql
-- Must run after 53_task_chat_documents.sql
--
-- Deleting a chat message is already a soft delete; this records who did it.
-- The conversation keeps a "Message deleted by <name>" placeholder in the
-- message's place, so a deletion can't quietly erase what was said. The
-- original content stays in the row for audit, but is never sent to the apps.
-- ============================================================

ALTER TABLE task_comments
    ADD COLUMN IF NOT EXISTS deleted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
