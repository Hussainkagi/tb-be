-- One-time links that move a signed-in person from one workspace to another
-- they already belong to (e.g. their recruitment agency → their teamBook HRMS
-- company) without signing in again.
--
-- Only a SHA-256 of the token is stored; the token itself exists once, in the
-- link. A link works once and for two minutes.
--
-- Idempotent: migrate.js re-runs a file whose hash changes.

CREATE TABLE IF NOT EXISTS workspace_switch_tokens (
    token_hash          VARCHAR(64)  PRIMARY KEY,
    user_id             UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_company_id     UUID         REFERENCES companies(id) ON DELETE SET NULL,
    to_company_id       UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    expires_at          TIMESTAMP    NOT NULL,
    used_at             TIMESTAMP,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workspace_switch_expires ON workspace_switch_tokens (expires_at);
