CREATE TABLE IF NOT EXISTS user_companies (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
 
    user_id     UUID        NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
    company_id  UUID        NOT NULL REFERENCES companies(id)  ON DELETE CASCADE,
    branch_id   UUID                 REFERENCES branches(id)   ON DELETE SET NULL,
 
    -- Username: globally unique, company-prefixed (AA0001 format)
    username    VARCHAR(10)  NOT NULL UNIQUE,
 
    -- Per-company password (NULL until employee sets via invite link)
    password_hash           TEXT,
    failed_login_attempts   SMALLINT    NOT NULL DEFAULT 0,
    locked_at               TIMESTAMP,
 
    -- Role scoped to this company
    role        user_role   NOT NULL DEFAULT '2',
 
    -- Invite state (for employee added by admin)
    is_invited              BOOLEAN     NOT NULL DEFAULT FALSE,
    invite_accepted_at      TIMESTAMP,
 
    is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
    deleted_at  TIMESTAMP,
 
    -- Audit
    created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
 
    CONSTRAINT uq_user_company UNIQUE (user_id, company_id)
);
 
CREATE INDEX IF NOT EXISTS idx_user_companies_username
    ON user_companies(username);
 
CREATE INDEX IF NOT EXISTS idx_user_companies_user_id
    ON user_companies(user_id);
 
CREATE INDEX IF NOT EXISTS idx_user_companies_company_id
    ON user_companies(company_id);
 
CREATE INDEX IF NOT EXISTS idx_user_companies_branch_id
    ON user_companies(branch_id)
    WHERE branch_id IS NOT NULL;


CREATE TRIGGER trg_user_companies_updated_at
    BEFORE UPDATE ON user_companies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
 
 