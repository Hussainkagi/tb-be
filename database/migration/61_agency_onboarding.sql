-- Agency (B2B sourcing) onboarding.
--
-- 1. companies.account_type — what a workspace is for. 'hrms' runs its own
--    staff (every existing company); 'agency' sources people for clients and
--    gets its own UI. The portal routes on it after sign-in.
-- 2. users.google_sub — the stable Google account id, set the first time a
--    person continues with Google. Matching on it (not only the email) keeps
--    the link even if they later change their Gmail address.
-- 3. agency_signups — a form signup waiting for its email OTP. Nothing is
--    written to users / companies until the OTP is verified AND the agency
--    is set up, so an unverified signup can never claim or touch an existing
--    Teambook account.
--
-- Idempotent: migrate.js re-runs a file whose hash changes.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS account_type VARCHAR(10) NOT NULL DEFAULT 'hrms';

DO $$ BEGIN
    ALTER TABLE companies
        ADD CONSTRAINT chk_companies_account_type CHECK (account_type IN ('hrms', 'agency'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_google_sub ON users (google_sub) WHERE google_sub IS NOT NULL;

CREATE TABLE IF NOT EXISTS agency_signups (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255) NOT NULL,
    first_name      VARCHAR(100) NOT NULL,
    last_name       VARCHAR(100) NOT NULL,
    password_hash   TEXT         NOT NULL,
    -- sha256 of the 6-digit code; the code itself is only ever in the email.
    otp_hash        VARCHAR(64)  NOT NULL,
    otp_expires_at  TIMESTAMP    NOT NULL,
    otp_sent_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attempts        SMALLINT     NOT NULL DEFAULT 0,
    verified_at     TIMESTAMP,
    -- Set once the agency is created from it; a used signup can't be replayed.
    completed_at    TIMESTAMP,
    created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agency_signups_email ON agency_signups (LOWER(email));
