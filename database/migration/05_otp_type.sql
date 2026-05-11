-- Safe enum creation (handles already-exists case)
DO $$ BEGIN
    CREATE TYPE otp_type AS ENUM (
        'email_verification',   -- OTP after company registration
        'invite',               -- password-set token when employee is added
        'password_reset'        -- forgot password reset link
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS otp_verifications (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),

    user_id         UUID         NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
    company_id      UUID                  REFERENCES companies(id)  ON DELETE CASCADE,

    type            otp_type     NOT NULL,
    token           VARCHAR(255) NOT NULL UNIQUE,   -- OTP code or secure token
    expires_at      TIMESTAMP    NOT NULL,
    verified_at     TIMESTAMP,                      -- stamped on use

    created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_otp_token
    ON otp_verifications(token);

CREATE INDEX IF NOT EXISTS idx_otp_user_type
    ON otp_verifications(user_id, type)
    WHERE verified_at IS NULL;