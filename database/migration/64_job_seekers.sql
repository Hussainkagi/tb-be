-- Job seekers — candidates with their own account on the public job board.
--
-- Separate from `users` on purpose: a job seeker is not a Teambook staff
-- member, has no company, and signs in with an email code or Google (no
-- password). Their token type ("job_seeker") is refused by every staff route.
--
--   job_seekers            the person and their profile (mostly filled from their first CV)
--   job_seeker_codes       pending email codes (sign up / sign in)
--   job_seeker_cvs         their CVs; one is the default used when applying
--   job_seeker_saved_jobs  bookmarks
--   job_seeker_drafts      applications started but not sent
--   recruitment_applications.seeker_id   links an application to the account
--
-- Idempotent: migrate.js re-runs a file whose hash changes.

CREATE TABLE IF NOT EXISTS job_seekers (
    id                      UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    email                   VARCHAR(255)  NOT NULL,
    first_name              VARCHAR(100)  NOT NULL,
    last_name               VARCHAR(100)  NOT NULL DEFAULT '',
    google_sub              VARCHAR(64),
    phone                   VARCHAR(40),
    headline                VARCHAR(160),          -- current / target job title
    current_company         VARCHAR(160),
    total_experience_years  NUMERIC(4,1),
    country                 VARCHAR(100),
    city                    VARCHAR(100),
    nationality             VARCHAR(100),
    gender                  VARCHAR(20),
    date_of_birth           DATE,
    linkedin_url            VARCHAR(300),
    portfolio_url           VARCHAR(300),
    summary                 TEXT,
    skills                  JSONB         NOT NULL DEFAULT '[]',
    experience              JSONB         NOT NULL DEFAULT '[]',   -- [{title, company, location, start, end, current, summary}]
    education               JSONB         NOT NULL DEFAULT '[]',   -- [{degree, field, institution, start, end}]
    languages               JSONB         NOT NULL DEFAULT '[]',
    certifications          JSONB         NOT NULL DEFAULT '[]',
    profile_filled_at       TIMESTAMP,                              -- first time a CV filled the profile
    last_login_at           TIMESTAMP,
    created_at              TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_job_seekers_email ON job_seekers (LOWER(email));
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_seekers_google ON job_seekers (google_sub) WHERE google_sub IS NOT NULL;

CREATE TABLE IF NOT EXISTS job_seeker_codes (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    email           VARCHAR(255)  NOT NULL,
    purpose         VARCHAR(10)   NOT NULL,             -- signup | login
    first_name      VARCHAR(100),
    last_name       VARCHAR(100),
    code_hash       VARCHAR(64)   NOT NULL,
    expires_at      TIMESTAMP     NOT NULL,
    sent_at         TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    attempts        SMALLINT      NOT NULL DEFAULT 0,
    used_at         TIMESTAMP,
    CONSTRAINT chk_job_seeker_code_purpose CHECK (purpose IN ('signup', 'login'))
);
CREATE INDEX IF NOT EXISTS idx_job_seeker_codes_email ON job_seeker_codes (LOWER(email), sent_at DESC);

CREATE TABLE IF NOT EXISTS job_seeker_cvs (
    id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    seeker_id       UUID          NOT NULL REFERENCES job_seekers(id) ON DELETE CASCADE,
    file_ref        TEXT          NOT NULL,            -- r2://… (or a Cloudinary id)
    file_name       VARCHAR(255)  NOT NULL,
    mime            VARCHAR(120),
    size_bytes      INTEGER,
    is_default      BOOLEAN       NOT NULL DEFAULT FALSE,
    parsed          JSONB,                             -- what was read from it
    created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_job_seeker_cvs_seeker ON job_seeker_cvs (seeker_id, created_at DESC);
-- At most one default CV per person.
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_seeker_default_cv ON job_seeker_cvs (seeker_id) WHERE is_default;

CREATE TABLE IF NOT EXISTS job_seeker_saved_jobs (
    seeker_id       UUID          NOT NULL REFERENCES job_seekers(id) ON DELETE CASCADE,
    job_id          UUID          NOT NULL REFERENCES recruitment_jobs(id) ON DELETE CASCADE,
    created_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (seeker_id, job_id)
);

CREATE TABLE IF NOT EXISTS job_seeker_drafts (
    seeker_id       UUID          NOT NULL REFERENCES job_seekers(id) ON DELETE CASCADE,
    job_id          UUID          NOT NULL REFERENCES recruitment_jobs(id) ON DELETE CASCADE,
    answers         JSONB         NOT NULL DEFAULT '{}',
    cv_id           UUID          REFERENCES job_seeker_cvs(id) ON DELETE SET NULL,
    updated_at      TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (seeker_id, job_id)
);

ALTER TABLE recruitment_applications ADD COLUMN IF NOT EXISTS seeker_id UUID REFERENCES job_seekers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_recruitment_applications_seeker ON recruitment_applications (seeker_id, created_at DESC);

-- Some CVs state an age but no date of birth.
ALTER TABLE job_seekers ADD COLUMN IF NOT EXISTS age_years SMALLINT;
