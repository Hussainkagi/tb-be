-- How well an application fits its job, out of 10 — worked out once, when the
-- candidate applies, from their CV and the job's (hidden) match profile.
-- Shown to the agency only.
ALTER TABLE recruitment_applications ADD COLUMN IF NOT EXISTS match_score     NUMERIC(3,1);
ALTER TABLE recruitment_applications ADD COLUMN IF NOT EXISTS match_summary   TEXT;
ALTER TABLE recruitment_applications ADD COLUMN IF NOT EXISTS match_details   JSONB;     -- { strengths, gaps, method }
ALTER TABLE recruitment_applications ADD COLUMN IF NOT EXISTS match_scored_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_recruitment_applications_match
    ON recruitment_applications (job_id, match_score DESC NULLS LAST);
