-- ============================================================
-- Task voice notes
-- ============================================================
--
-- An assigner may record a short voice note instead of (or alongside)
-- typing a description. Stored on the task itself, not a separate table —
-- one task has at most one voice note today.
--
-- The max recording length is plan-gated as a numeric 'limit' feature (see
-- enums/features.js:Feature.TASK_VOICE_NOTE_MAX_SECONDS), read directly off
-- EntitlementService.getSnapshot() in taskService — this is NOT one of the
-- four countable Limit.* keys (no countUsageFor wiring needed): it is a
-- static per-plan number, not a count of existing rows.
-- ============================================================

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS voice_note_url              TEXT,
    ADD COLUMN IF NOT EXISTS voice_note_public_id         TEXT,
    ADD COLUMN IF NOT EXISTS voice_note_duration_seconds  INT,
    ADD COLUMN IF NOT EXISTS voice_note_format            VARCHAR(20);

INSERT INTO plan_features (key, category, label, value_type, is_enforceable, is_visible, sort_order) VALUES
    ('tasks.voice_note_max_seconds', 'Tasks', 'Voice note max length (seconds)', 'limit', TRUE, TRUE, 650)
ON CONFLICT (key) DO NOTHING;

WITH seed(plan_code, feature_key, limit_value, note) AS (
    VALUES
    ('trial', 'tasks.voice_note_max_seconds', 15, '15 seconds'),
    ('free',  'tasks.voice_note_max_seconds', 15, '15 seconds'),
    ('pro',   'tasks.voice_note_max_seconds', 30, '30 seconds'),
    ('gold',  'tasks.voice_note_max_seconds', 40, '40 seconds')
)
INSERT INTO plan_feature_values (plan_id, feature_key, limit_value, note)
SELECT p.id, s.feature_key, s.limit_value, s.note
FROM seed s
JOIN plans p ON p.code = s.plan_code
ON CONFLICT (plan_id, feature_key) DO NOTHING;
