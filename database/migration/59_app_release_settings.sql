-- ============================================================
-- Mobile app release settings — one row per platform.
--
-- Read by GET /api/app-version (the app's "Update available" sheet) and
-- edited by Super Admins under Platform → App versions, so announcing a new
-- store build needs no server login and no redeploy.
--
--   latest_version  newest build in the store → "Update available" (dismissible)
--   min_version     oldest build still allowed → "Update required" (blocking)
--   NULL in either means "don't prompt".
--
-- Idempotent: migrate.js re-runs a file whose hash changes.
-- ============================================================

CREATE TABLE IF NOT EXISTS app_release_settings (
    platform        VARCHAR(10)     PRIMARY KEY,
    latest_version  VARCHAR(20),
    min_version     VARCHAR(20),
    notes           TEXT,
    store_url       TEXT,
    updated_by      UUID            REFERENCES users(id) ON DELETE SET NULL,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_app_release_platform CHECK (platform IN ('android', 'ios'))
);

INSERT INTO app_release_settings (platform, store_url) VALUES
    ('android', 'https://play.google.com/store/apps/details?id=com.hussain.teambook'),
    ('ios',     NULL)
ON CONFLICT (platform) DO NOTHING;
