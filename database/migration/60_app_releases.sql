-- Mobile app releases — one row per store build announced to users.
--
-- Replaces the single latest/min pair in app_release_settings (which now keeps
-- only the per-platform store link). What the app is told:
--   latest  = highest ACTIVE release            → "Update available"
--   minimum = highest ACTIVE release marked required → "Update required"
-- Stopping a release (is_active = false) takes it out of both without losing
-- its history; a mistyped version can simply be edited or deleted.

CREATE TABLE IF NOT EXISTS app_releases (
    id          SERIAL PRIMARY KEY,
    platform    VARCHAR(10) NOT NULL,
    version     VARCHAR(20) NOT NULL,
    notes       TEXT,
    is_required BOOLEAN NOT NULL DEFAULT FALSE,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_app_releases_platform CHECK (platform IN ('android', 'ios')),
    CONSTRAINT uq_app_releases_platform_version UNIQUE (platform, version)
);

CREATE INDEX IF NOT EXISTS idx_app_releases_platform ON app_releases (platform);

-- Carry over what was set on the old single-row screen.
INSERT INTO app_releases (platform, version, notes, is_required, created_by, updated_by)
SELECT platform, latest_version, notes, FALSE, updated_by, updated_by
  FROM app_release_settings
 WHERE latest_version IS NOT NULL
ON CONFLICT (platform, version) DO NOTHING;

INSERT INTO app_releases (platform, version, is_required, created_by, updated_by)
SELECT platform, min_version, TRUE, updated_by, updated_by
  FROM app_release_settings
 WHERE min_version IS NOT NULL
ON CONFLICT (platform, version) DO UPDATE SET is_required = TRUE;
