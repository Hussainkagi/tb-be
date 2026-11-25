-- ============================================================
-- Recruitment (HR sourcing) — agency flow
--
--   agency (a Teambook company)            recruitment_agencies
--     └─ client companies                  recruitment_clients
--          ├─ client logins                recruitment_client_users
--          └─ jobs                         recruitment_jobs
--               └─ applications            recruitment_applications
--                    └─ candidate          recruitment_candidates (agency talent pool)
--
-- An agency is an ordinary tenant: its staff sign in with their Teambook
-- account, its plan gates the module (recruitment.manage). Client users are
-- NOT Teambook users — they have their own table and their own token type, so
-- a client login can never reach an HRMS endpoint.
--
-- Idempotent: migrate.js re-runs a file whose hash changes.
-- ============================================================


-- ------------------------------------------------------------
-- 1. AGENCY PROFILE — one per company that turns the module on
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruitment_agencies (
    company_id      UUID            PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    display_name    VARCHAR(160)    NOT NULL,
    -- Public, URL-safe handle used on the job portal.
    slug            VARCHAR(80)     NOT NULL UNIQUE,
    logo_url        TEXT,
    logo_public_id  TEXT,
    website         VARCHAR(255),
    contact_email   VARCHAR(255),
    contact_phone   VARCHAR(50),
    about           TEXT,
    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

DROP TRIGGER IF EXISTS trg_recruitment_agencies_updated_at ON recruitment_agencies;
CREATE TRIGGER trg_recruitment_agencies_updated_at
    BEFORE UPDATE ON recruitment_agencies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- 2. CLIENT COMPANIES — the agency's customers
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruitment_clients (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_company_id   UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name                VARCHAR(200)    NOT NULL,
    industry            VARCHAR(120),
    website             VARCHAR(255),
    logo_url            TEXT,
    location            VARCHAR(200),
    contact_name        VARCHAR(160),
    contact_email       VARCHAR(255),
    contact_phone       VARCHAR(50),
    about               TEXT,
    is_active           BOOLEAN         NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_recruitment_clients_agency_name
    ON recruitment_clients(agency_company_id, LOWER(name));

DROP TRIGGER IF EXISTS trg_recruitment_clients_updated_at ON recruitment_clients;
CREATE TRIGGER trg_recruitment_clients_updated_at
    BEFORE UPDATE ON recruitment_clients
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- 3. CLIENT LOGINS — credentials the agency hands to its client
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruitment_client_users (
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id               UUID            NOT NULL REFERENCES recruitment_clients(id) ON DELETE CASCADE,
    agency_company_id       UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    full_name               VARCHAR(160)    NOT NULL,
    email                   VARCHAR(255)    NOT NULL,
    password_hash           TEXT            NOT NULL,
    is_active               BOOLEAN         NOT NULL DEFAULT TRUE,
    failed_login_attempts   SMALLINT        NOT NULL DEFAULT 0,
    last_login_at           TIMESTAMP,
    created_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Email is the login, so it is unique across the whole platform.
CREATE UNIQUE INDEX IF NOT EXISTS uq_recruitment_client_users_email
    ON recruitment_client_users(LOWER(email));

CREATE INDEX IF NOT EXISTS idx_recruitment_client_users_client
    ON recruitment_client_users(client_id);

DROP TRIGGER IF EXISTS trg_recruitment_client_users_updated_at ON recruitment_client_users;
CREATE TRIGGER trg_recruitment_client_users_updated_at
    BEFORE UPDATE ON recruitment_client_users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- 4. JOBS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruitment_jobs (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_company_id   UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    client_id           UUID            REFERENCES recruitment_clients(id) ON DELETE SET NULL,

    -- Globally unique: it is the public URL (/jobs/<slug>).
    slug                VARCHAR(160)    NOT NULL UNIQUE,
    title               VARCHAR(200)    NOT NULL,

    -- requested: raised by the client, waiting on the agency
    -- draft → open → paused / closed / filled
    status              VARCHAR(20)     NOT NULL DEFAULT 'draft',
    source              VARCHAR(20)     NOT NULL DEFAULT 'agency',   -- agency | client

    sector              VARCHAR(120),
    employment_type     VARCHAR(30)     NOT NULL DEFAULT 'full_time',
    work_mode           VARCHAR(20)     NOT NULL DEFAULT 'onsite',   -- onsite | hybrid | remote
    openings            INTEGER         NOT NULL DEFAULT 1,

    description         TEXT,
    responsibilities    TEXT,
    requirements        TEXT,
    benefits            TEXT,
    experience_min      NUMERIC(4,1),
    experience_max      NUMERIC(4,1),
    education           VARCHAR(200),
    skills              TEXT[]          NOT NULL DEFAULT '{}',
    tags                TEXT[]          NOT NULL DEFAULT '{}',

    location_city       VARCHAR(120),
    location_country    VARCHAR(120),

    salary_min          NUMERIC(12,2),
    salary_max          NUMERIC(12,2),
    salary_currency     VARCHAR(10)     NOT NULL DEFAULT 'AED',
    salary_period       VARCHAR(10)     NOT NULL DEFAULT 'month',    -- hour | day | month | year

    -- What the public sees.
    show_salary         BOOLEAN         NOT NULL DEFAULT FALSE,
    show_company        BOOLEAN         NOT NULL DEFAULT TRUE,
    list_on_portal      BOOLEAN         NOT NULL DEFAULT TRUE,

    -- Which apply-form fields are on/required, plus custom questions.
    -- See utils/recruitmentForm.js — the one place the shape is defined.
    form_config         JSONB           NOT NULL DEFAULT '{}'::jsonb,

    -- Location-bound jobs ask the applicant's browser for its position and
    -- refuse an application from outside the circle.
    location_bound      BOOLEAN         NOT NULL DEFAULT FALSE,
    bound_label         VARCHAR(120),
    bound_latitude      NUMERIC(10,7),
    bound_longitude     NUMERIC(10,7),
    bound_radius_km     NUMERIC(7,2),

    deadline            DATE,
    published_at        TIMESTAMP,
    closed_at           TIMESTAMP,
    created_by          UUID,
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_recruitment_jobs_status
        CHECK (status IN ('requested', 'draft', 'open', 'paused', 'closed', 'filled')),
    CONSTRAINT chk_recruitment_jobs_work_mode
        CHECK (work_mode IN ('onsite', 'hybrid', 'remote')),
    CONSTRAINT chk_recruitment_jobs_bound
        CHECK (NOT location_bound OR (bound_latitude IS NOT NULL AND bound_longitude IS NOT NULL AND bound_radius_km > 0))
);

CREATE INDEX IF NOT EXISTS idx_recruitment_jobs_agency
    ON recruitment_jobs(agency_company_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_recruitment_jobs_client
    ON recruitment_jobs(client_id);

-- The public portal only ever reads open, listed jobs, newest first.
CREATE INDEX IF NOT EXISTS idx_recruitment_jobs_public
    ON recruitment_jobs(published_at DESC)
    WHERE status = 'open' AND list_on_portal = TRUE;

CREATE INDEX IF NOT EXISTS idx_recruitment_jobs_tags
    ON recruitment_jobs USING GIN (tags);

DROP TRIGGER IF EXISTS trg_recruitment_jobs_updated_at ON recruitment_jobs;
CREATE TRIGGER trg_recruitment_jobs_updated_at
    BEFORE UPDATE ON recruitment_jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- 5. CANDIDATES — the agency's talent pool, one row per person
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruitment_candidates (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_company_id   UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    full_name           VARCHAR(160)    NOT NULL,
    email               VARCHAR(255)    NOT NULL,
    phone               VARCHAR(50),
    linkedin_url        VARCHAR(300),
    current_location    VARCHAR(160),
    latest_cv_url       TEXT,
    latest_cv_public_id TEXT,
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_recruitment_candidates_agency_email
    ON recruitment_candidates(agency_company_id, LOWER(email));

DROP TRIGGER IF EXISTS trg_recruitment_candidates_updated_at ON recruitment_candidates;
CREATE TRIGGER trg_recruitment_candidates_updated_at
    BEFORE UPDATE ON recruitment_candidates
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- 6. APPLICATIONS — a candidate against one job
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recruitment_applications (
    id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_company_id   UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    job_id              UUID            NOT NULL REFERENCES recruitment_jobs(id) ON DELETE CASCADE,
    candidate_id        UUID            NOT NULL REFERENCES recruitment_candidates(id) ON DELETE CASCADE,

    -- Everything the form collected, as submitted (field key → value).
    answers             JSONB           NOT NULL DEFAULT '{}'::jsonb,
    cv_url              TEXT,
    cv_public_id        TEXT,
    cv_file_name        VARCHAR(255),

    -- Location-bound jobs only.
    applicant_latitude  NUMERIC(10,7),
    applicant_longitude NUMERIC(10,7),
    distance_km         NUMERIC(8,2),

    -- The agency's own pipeline.
    stage               VARCHAR(20)     NOT NULL DEFAULT 'applied',
    agency_notes        TEXT,

    -- What the client sees and decides. A candidate is invisible to the
    -- client until the agency shares them.
    shared_with_client  BOOLEAN         NOT NULL DEFAULT FALSE,
    shared_at           TIMESTAMP,
    client_decision     VARCHAR(20)     NOT NULL DEFAULT 'pending',
    client_feedback     TEXT,
    client_decided_at   TIMESTAMP,

    source              VARCHAR(20)     NOT NULL DEFAULT 'portal',   -- portal | link | manual
    created_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT uq_recruitment_application UNIQUE (job_id, candidate_id),
    CONSTRAINT chk_recruitment_applications_stage
        CHECK (stage IN ('applied', 'screening', 'shortlisted', 'interview', 'offered', 'hired', 'rejected')),
    CONSTRAINT chk_recruitment_applications_decision
        CHECK (client_decision IN ('pending', 'approved', 'rejected', 'finalized'))
);

CREATE INDEX IF NOT EXISTS idx_recruitment_applications_job
    ON recruitment_applications(job_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_recruitment_applications_agency
    ON recruitment_applications(agency_company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_recruitment_applications_shared
    ON recruitment_applications(job_id)
    WHERE shared_with_client = TRUE;

DROP TRIGGER IF EXISTS trg_recruitment_applications_updated_at ON recruitment_applications;
CREATE TRIGGER trg_recruitment_applications_updated_at
    BEFORE UPDATE ON recruitment_applications
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- 7. PLAN FEATURE — recruitment.manage
-- Mirrors Feature.RECRUITMENT in enums/features.js.
-- ------------------------------------------------------------
INSERT INTO plan_features (key, category, label, value_type, is_enforceable, is_visible, sort_order) VALUES
    ('recruitment.manage', 'Recruitment', 'Recruitment agency: clients, jobs, job portal & client logins', 'boolean', TRUE, TRUE, 710)
ON CONFLICT (key) DO NOTHING;

WITH seed(plan_code, feature_key, bool_value) AS (
    VALUES
    ('trial', 'recruitment.manage', TRUE),
    ('pro',   'recruitment.manage', TRUE),
    ('gold',  'recruitment.manage', TRUE)
)
INSERT INTO plan_feature_values (plan_id, feature_key, bool_value)
SELECT p.id, s.feature_key, s.bool_value
FROM seed s
JOIN plans p ON p.code = s.plan_code
ON CONFLICT (plan_id, feature_key) DO NOTHING;
