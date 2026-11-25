-- A short note the candidate writes to the recruiter when applying (optional, agency only).
ALTER TABLE recruitment_applications ADD COLUMN IF NOT EXISTS candidate_note TEXT;
