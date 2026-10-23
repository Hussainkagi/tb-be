-- ============================================================
-- 53_task_chat_documents.sql
-- Must run after 52_task_chat_attachments.sql
--
-- A chat message can now carry a document (PDF, Word, Excel) as well as a
-- photo. attachment_type is 'image' or 'document'. A photo needs nothing
-- more than its URL; a document also needs the name it was shared under, its
-- size and its type, so the apps can show a file card before anyone opens it.
-- ============================================================

ALTER TABLE task_comments
    ADD COLUMN IF NOT EXISTS attachment_name  VARCHAR(255),
    ADD COLUMN IF NOT EXISTS attachment_size  INTEGER,
    ADD COLUMN IF NOT EXISTS attachment_mime  VARCHAR(150);
