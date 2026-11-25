-- Job descriptions read by AI (Gemini).
--
-- 1. recruitment_jd_parses — every "read this job description" run: the
--    uploaded file (R2), the text we could extract, the form fields the model
--    filled, and the matching profile. Kept even if no job is saved from it,
--    so a run can be inspected later.
-- 2. recruitment_job_profiles — the hidden matching profile of a job, copied
--    from the run the job was saved with. Used later to score applicants
--    against the job. Never selected by any job/portal query, so it can't leak
--    to the agency UI, clients or the public job board.
--
-- Idempotent: migrate.js re-runs a file whose hash changes.

CREATE TABLE IF NOT EXISTS recruitment_jd_parses (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    agency_company_id   UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    created_by          UUID         REFERENCES users(id) ON DELETE SET NULL,
    source              VARCHAR(10)  NOT NULL,           -- file | text
    file_ref            TEXT,                            -- r2://… or a Cloudinary URL
    file_name           VARCHAR(255),
    jd_text             TEXT,                            -- extracted / pasted text (NULL for PDFs read natively)
    fields              JSONB        NOT NULL,           -- what was put into the form
    match_profile       JSONB        NOT NULL,           -- hidden; see recruitment_job_profiles
    model               VARCHAR(80),
    job_id              UUID         REFERENCES recruitment_jobs(id) ON DELETE SET NULL,
    created_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_jd_parse_source CHECK (source IN ('file', 'text'))
);

CREATE INDEX IF NOT EXISTS idx_jd_parses_agency ON recruitment_jd_parses (agency_company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS recruitment_job_profiles (
    job_id              UUID         PRIMARY KEY REFERENCES recruitment_jobs(id) ON DELETE CASCADE,
    profile             JSONB        NOT NULL,
    jd_parse_id         UUID         REFERENCES recruitment_jd_parses(id) ON DELETE SET NULL,
    jd_file_ref         TEXT,
    model               VARCHAR(80),
    updated_at          TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
