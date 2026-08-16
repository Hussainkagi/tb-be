-- ============================================================
-- Legal Policies — Terms & Conditions, Privacy Policy
-- ============================================================
--
-- Three concerns, deliberately separated:
--
--   1. policy_documents          — every version of every policy, forever.
--                                  Super Admin owned. Nothing is ever updated
--                                  in place: publishing writes a NEW row and
--                                  moves the `is_current` flag. Old versions
--                                  stay readable because a dispute in 2029 is
--                                  argued against the text the company
--                                  actually accepted in 2026, not against
--                                  whatever the file says today.
--
--   2. company_policy_acceptances — who clicked "I Agree", to WHICH version,
--                                  from which IP, and when. One row per
--                                  (company, policy version). This is the
--                                  evidence; the company profile reads it.
--
--   3. companies.country_code     — policies are country-scoped, but
--                                  companies.country is free text ("UAE",
--                                  "United Arab Emirates", "uae"). Matching a
--                                  policy against free text would silently
--                                  serve the wrong terms, so registration now
--                                  also stores a normalised ISO 3166-1
--                                  alpha-2 code and the lookup uses that.
--
-- Country resolution at read time:  exact country_code  →  global (NULL).
-- A NULL country_code row is the platform default, used by every country that
-- has no specific document of its own. Without that fallback, registering the
-- first company in a new country would have nothing to accept.
-- ============================================================


-- ------------------------------------------------------------
-- 0. COMPANY COUNTRY CODE  (normalised, for policy matching)
-- ------------------------------------------------------------
ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS country_code VARCHAR(2);

-- Backfill the codes we can infer from existing free text. Anything we cannot
-- map stays NULL and falls back to the global policy, which is the safe side
-- of the error: the company sees the default terms rather than none at all.
UPDATE companies
SET country_code = CASE UPPER(TRIM(country))
    WHEN 'AE' THEN 'AE'
    WHEN 'UAE' THEN 'AE'
    WHEN 'U.A.E' THEN 'AE'
    WHEN 'U.A.E.' THEN 'AE'
    WHEN 'UNITED ARAB EMIRATES' THEN 'AE'
    WHEN 'IN' THEN 'IN'
    WHEN 'INDIA' THEN 'IN'
    WHEN 'SA' THEN 'SA'
    WHEN 'SAUDI ARABIA' THEN 'SA'
    WHEN 'KSA' THEN 'SA'
    WHEN 'QA' THEN 'QA'
    WHEN 'QATAR' THEN 'QA'
    WHEN 'KW' THEN 'KW'
    WHEN 'KUWAIT' THEN 'KW'
    WHEN 'OM' THEN 'OM'
    WHEN 'OMAN' THEN 'OM'
    WHEN 'BH' THEN 'BH'
    WHEN 'BAHRAIN' THEN 'BH'
    WHEN 'GB' THEN 'GB'
    WHEN 'UK' THEN 'GB'
    WHEN 'UNITED KINGDOM' THEN 'GB'
    WHEN 'US' THEN 'US'
    WHEN 'USA' THEN 'US'
    WHEN 'UNITED STATES' THEN 'US'
    WHEN 'PK' THEN 'PK'
    WHEN 'PAKISTAN' THEN 'PK'
    WHEN 'BD' THEN 'BD'
    WHEN 'BANGLADESH' THEN 'BD'
    WHEN 'PH' THEN 'PH'
    WHEN 'PHILIPPINES' THEN 'PH'
    WHEN 'EG' THEN 'EG'
    WHEN 'EGYPT' THEN 'EG'
    WHEN 'SG' THEN 'SG'
    WHEN 'SINGAPORE' THEN 'SG'
    ELSE NULL
END
WHERE country_code IS NULL
  AND country IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_companies_country_code
    ON companies (country_code)
    WHERE deleted_at IS NULL;


-- ------------------------------------------------------------
-- 1. POLICY DOCUMENTS  (append-only version history)
-- ------------------------------------------------------------
--
-- content_html is what the app renders; content_text is what search and the
-- plain-text email fallback read. Both are DERIVED from the uploaded .docx at
-- publish time — the file itself is kept on Cloudinary so Legal can always
-- download the exact document that was signed off, not our rendering of it.

CREATE TABLE IF NOT EXISTS policy_documents (
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    policy_type             VARCHAR(30)     NOT NULL,
    -- NULL = global default, used by every country without its own document.
    country_code            VARCHAR(2),

    -- Monotonic per (policy_type, country). v1, v2, v3 … never reused.
    version                 INT             NOT NULL,

    title                   TEXT            NOT NULL,
    -- What changed since the previous version. Goes into the notification and
    -- the email so an admin knows whether they need to read it again.
    change_note             TEXT,
    effective_from          DATE            NOT NULL DEFAULT CURRENT_DATE,

    -- Rendered content, extracted from the uploaded document.
    content_html            TEXT            NOT NULL,
    content_text            TEXT,

    -- The original upload, kept verbatim.
    source_file_url         TEXT,
    source_file_public_id   TEXT,
    source_file_name        TEXT,
    source_file_mime        VARCHAR(150),
    source_file_size        BIGINT,

    -- Exactly one current row per (policy_type, country) — enforced below.
    is_current              BOOLEAN         NOT NULL DEFAULT TRUE,

    -- TRUE marks a change material enough that companies should re-accept.
    -- FALSE is a typo fix: notify, but do not nag every admin for a signature.
    requires_reacceptance   BOOLEAN         NOT NULL DEFAULT TRUE,

    published_by_user_id    UUID            REFERENCES users(id) ON DELETE SET NULL,
    published_at            TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    created_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_policy_type
        CHECK (policy_type IN ('terms', 'privacy')),

    CONSTRAINT chk_policy_country_code_shape
        CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),

    CONSTRAINT chk_policy_version_positive
        CHECK (version > 0)
);

-- Version numbers are unique within a (type, country) lane. COALESCE folds the
-- global lane's NULL into a sentinel, because NULL <> NULL would let two v1
-- global documents coexist.
CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_documents_version
    ON policy_documents (policy_type, COALESCE(country_code, '**'), version);

-- The invariant the whole module rests on: one and only one live document per
-- lane. Publishing demotes the incumbent inside the same transaction.
CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_documents_current
    ON policy_documents (policy_type, COALESCE(country_code, '**'))
    WHERE is_current;

CREATE INDEX IF NOT EXISTS idx_policy_documents_lookup
    ON policy_documents (policy_type, country_code, published_at DESC);


-- ------------------------------------------------------------
-- 2. COMPANY ACCEPTANCES  (the evidence trail)
-- ------------------------------------------------------------
--
-- Rows are never deleted and never updated: re-accepting a newer version adds
-- a row, it does not overwrite the old one. The company profile shows the
-- latest per policy_type; a dispute reads the whole chain.

CREATE TABLE IF NOT EXISTS company_policy_acceptances (
    id                      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id              UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    policy_document_id      UUID            NOT NULL REFERENCES policy_documents(id) ON DELETE RESTRICT,

    -- Denormalised so the profile screen and exports never need the join, and
    -- so the record still reads correctly if a policy row is ever re-scoped.
    policy_type             VARCHAR(30)     NOT NULL,
    policy_version          INT             NOT NULL,
    country_code            VARCHAR(2),

    accepted_by_user_id     UUID            REFERENCES users(id) ON DELETE SET NULL,
    -- Free text rather than a FK: the name must survive the user being deleted.
    accepted_by_name        TEXT,
    accepted_by_email       TEXT,

    -- 'registration'  — the signup checkbox
    -- 'reacceptance'  — an admin accepting a newly published version
    acceptance_context      VARCHAR(30)     NOT NULL DEFAULT 'registration',

    ip_address              VARCHAR(64),
    user_agent              TEXT,

    accepted_at             TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at              TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_acceptance_policy_type
        CHECK (policy_type IN ('terms', 'privacy')),

    CONSTRAINT chk_acceptance_context
        CHECK (acceptance_context IN ('registration', 'reacceptance')),

    -- One acceptance per company per version. A double-clicked "I Agree" is a
    -- no-op, not a second row that makes the audit trail look tampered with.
    CONSTRAINT uq_company_policy_version
        UNIQUE (company_id, policy_document_id)
);

CREATE INDEX IF NOT EXISTS idx_policy_acceptances_company
    ON company_policy_acceptances (company_id, policy_type, accepted_at DESC);

CREATE INDEX IF NOT EXISTS idx_policy_acceptances_document
    ON company_policy_acceptances (policy_document_id);
