-- Job seeker onboarding, the profile summary used for matching, and invites.
--
-- After signing in, a job seeker finishes a short onboarding (CV → basic
-- details → experience → photo). The photo is required; `onboarded_at` is set
-- when they finish, and only then can they use the job board.
--
-- `profile_meta` is a compact summary of the profile built for matching
-- (sectors, normalised skills and titles, years, seniority, location …). It is
-- rebuilt whenever the profile changes. Agencies see the best-matching
-- onboarded profiles on each job and can invite them to apply by email —
-- only people who left `open_to_invites` on are shown.
--
-- Idempotent: migrate.js re-runs a file whose hash changes.

ALTER TABLE job_seekers ADD COLUMN IF NOT EXISTS photo_ref         TEXT;
ALTER TABLE job_seekers ADD COLUMN IF NOT EXISTS onboarded_at      TIMESTAMP;
ALTER TABLE job_seekers ADD COLUMN IF NOT EXISTS open_to_invites   BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE job_seekers ADD COLUMN IF NOT EXISTS profile_meta      JSONB;
ALTER TABLE job_seekers ADD COLUMN IF NOT EXISTS profile_meta_at   TIMESTAMP;

-- The pool agencies search: onboarded, open to invites.
CREATE INDEX IF NOT EXISTS idx_job_seekers_talent_pool
    ON job_seekers (onboarded_at) WHERE onboarded_at IS NOT NULL AND open_to_invites;
CREATE INDEX IF NOT EXISTS idx_job_seekers_meta_sectors
    ON job_seekers USING GIN ((profile_meta -> 'sectors'));
CREATE INDEX IF NOT EXISTS idx_job_seekers_meta_skills
    ON job_seekers USING GIN ((profile_meta -> 'skills'));

-- One invite per person per job.
CREATE TABLE IF NOT EXISTS recruitment_job_invites (
    id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id              UUID          NOT NULL REFERENCES recruitment_jobs(id) ON DELETE CASCADE,
    seeker_id           UUID          NOT NULL REFERENCES job_seekers(id) ON DELETE CASCADE,
    agency_company_id   UUID          NOT NULL,
    invited_by          UUID,                                -- the agency user who sent it
    message             TEXT,
    match_score         NUMERIC(3,1),                        -- the score shown when it was sent
    created_at          TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_job_invite UNIQUE (job_id, seeker_id)
);
CREATE INDEX IF NOT EXISTS idx_job_invites_agency ON recruitment_job_invites (agency_company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_invites_seeker ON recruitment_job_invites (seeker_id, created_at DESC);
