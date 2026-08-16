const db = require("../config/database");

// node-pg hands a DATE back as a JS Date at LOCAL midnight, which JSON then
// serialises in UTC — a document effective on the 16th reaches the client as
// "2026-08-15T20:00:00Z" from a UTC+4 server. For a date that decides when
// terms take legal effect, an off-by-one day is not cosmetic, so every read
// casts it to text and it stays "2026-08-16" all the way to the client.
const EFFECTIVE_FROM = `to_char(effective_from, 'YYYY-MM-DD') AS effective_from`;

// Columns every list/summary endpoint returns. content_html is deliberately
// excluded — a version list of 20 full T&C documents is megabytes of payload
// nobody renders, so the body is only fetched when one document is opened.
const SUMMARY_COLUMNS = `
    id, policy_type, country_code, version, title, change_note,
    ${EFFECTIVE_FROM}, is_current, requires_reacceptance,
    source_file_url, source_file_name, source_file_mime, source_file_size,
    published_by_user_id, published_at, created_at, updated_at
`;

// Appended after `*` on the full-row reads. The later column wins when a name
// repeats, so this overrides the Date with the text form.
const ALL_COLUMNS = `*, ${EFFECTIVE_FROM}`;

const PolicyDocument = {
    // ─────────────────────────────────────────────────────────────────────────
    // PUBLISHING
    // ─────────────────────────────────────────────────────────────────────────

    /** Highest version number so far in one (type, country) lane. 0 if new. */
    async getLatestVersionNumber(policy_type, country_code, client = db) {
        const result = await client.query(
            `SELECT COALESCE(MAX(version), 0) AS version
               FROM policy_documents
              WHERE policy_type = $1
                AND country_code IS NOT DISTINCT FROM $2`,
            [policy_type, country_code]
        );
        return Number(result.rows[0].version);
    },

    /**
     * Demote the live document in a lane.
     *
     * Must run before inserting the replacement, inside the same transaction:
     * uq_policy_documents_current permits exactly one is_current row per lane,
     * so doing it the other way round throws instead of superseding.
     */
    async demoteCurrent(policy_type, country_code, client = db) {
        const result = await client.query(
            `UPDATE policy_documents
                SET is_current = FALSE,
                    updated_at = NOW()
              WHERE policy_type = $1
                AND country_code IS NOT DISTINCT FROM $2
                AND is_current = TRUE
              RETURNING id, version`,
            [policy_type, country_code]
        );
        return result.rows[0] || null;
    },

    async create(data, client = db) {
        const {
            policy_type,
            country_code = null,
            version,
            title,
            change_note = null,
            effective_from = null,
            content_html,
            content_text = null,
            source_file_url = null,
            source_file_public_id = null,
            source_file_name = null,
            source_file_mime = null,
            source_file_size = null,
            requires_reacceptance = true,
            published_by_user_id = null,
        } = data;

        const result = await client.query(
            `INSERT INTO policy_documents (
                policy_type, country_code, version, title, change_note,
                effective_from, content_html, content_text,
                source_file_url, source_file_public_id, source_file_name,
                source_file_mime, source_file_size,
                is_current, requires_reacceptance, published_by_user_id
             ) VALUES (
                $1, $2, $3, $4, $5,
                COALESCE($6::DATE, CURRENT_DATE), $7, $8,
                $9, $10, $11,
                $12, $13,
                TRUE, $14, $15
             ) RETURNING ${ALL_COLUMNS}`,
            [
                policy_type, country_code, version, title, change_note,
                effective_from, content_html, content_text,
                source_file_url, source_file_public_id, source_file_name,
                source_file_mime, source_file_size,
                requires_reacceptance, published_by_user_id,
            ]
        );
        return result.rows[0];
    },

    // ─────────────────────────────────────────────────────────────────────────
    // READING
    // ─────────────────────────────────────────────────────────────────────────

    async findById(id) {
        const result = await db.query(
            `SELECT ${ALL_COLUMNS} FROM policy_documents WHERE id = $1`,
            [id]
        );
        return result.rows[0];
    },

    /**
     * The live document for one country, with fallback to the global one.
     *
     * ORDER BY puts the country-specific row first (country_code IS NULL sorts
     * FALSE-then-TRUE), so LIMIT 1 picks the specific document when it exists
     * and the global default otherwise — one round trip, no branching.
     */
    async findCurrent(policy_type, country_code = null) {
        const result = await db.query(
            `SELECT ${ALL_COLUMNS} FROM policy_documents
              WHERE policy_type = $1
                AND is_current = TRUE
                AND (country_code = $2 OR country_code IS NULL)
              ORDER BY (country_code IS NULL) ASC
              LIMIT 1`,
            [policy_type, country_code]
        );
        return result.rows[0];
    },

    /** Every live policy for a country (terms + privacy), same fallback rule. */
    async findAllCurrentForCountry(country_code = null) {
        const result = await db.query(
            `SELECT DISTINCT ON (policy_type) ${ALL_COLUMNS}
               FROM policy_documents
              WHERE is_current = TRUE
                AND (country_code = $1 OR country_code IS NULL)
              ORDER BY policy_type, (country_code IS NULL) ASC`,
            [country_code]
        );
        return result.rows;
    },

    /** Every live policy across all countries — the Super Admin index. */
    async listCurrent({ policy_type = null, country_code = null } = {}) {
        const where = ["is_current = TRUE"];
        const values = [];
        let p = 0;

        if (policy_type) {
            values.push(policy_type);
            where.push(`policy_type = $${++p}`);
        }
        if (country_code) {
            values.push(country_code);
            where.push(`country_code = $${++p}`);
        }

        const result = await db.query(
            `SELECT ${SUMMARY_COLUMNS}
               FROM policy_documents
              WHERE ${where.join(" AND ")}
              ORDER BY policy_type ASC, country_code ASC NULLS FIRST`,
            values
        );
        return result.rows;
    },

    /** Full version history for one lane — Super Admin only. */
    async listVersions({ policy_type, country_code = null, page = 1, limit = 20 }) {
        const offset = (page - 1) * limit;

        const rows = await db.query(
            `SELECT ${SUMMARY_COLUMNS}
               FROM policy_documents
              WHERE policy_type = $1
                AND country_code IS NOT DISTINCT FROM $2
              ORDER BY version DESC
              LIMIT $3 OFFSET $4`,
            [policy_type, country_code, limit, offset]
        );

        const count = await db.query(
            `SELECT COUNT(*) AS total
               FROM policy_documents
              WHERE policy_type = $1
                AND country_code IS NOT DISTINCT FROM $2`,
            [policy_type, country_code]
        );

        return { rows: rows.rows, total: Number(count.rows[0].total) };
    },

    /** Distinct (type, country) lanes with their live version — panel index. */
    async listLanes() {
        const result = await db.query(
            `SELECT policy_type,
                    country_code,
                    COUNT(*)::INT                                   AS version_count,
                    MAX(version)                                    AS latest_version,
                    MAX(published_at)                               AS last_published_at,
                    MAX(title) FILTER (WHERE is_current)            AS current_title,
                    MAX(id::TEXT) FILTER (WHERE is_current)         AS current_document_id
               FROM policy_documents
              GROUP BY policy_type, country_code
              ORDER BY policy_type ASC, country_code ASC NULLS FIRST`
        );
        return result.rows;
    },

    /**
     * Company admins who must be told about a new version.
     *
     * "Admins in that country" is resolved through companies.country_code, and
     * a NULL-country policy reaches every company that has no document of its
     * own — matching how findCurrent() resolves, so nobody is notified about a
     * document that is not actually theirs.
     *
     * employee_id is included because the notification fan-out addresses
     * employees, while the email needs the user's address; a company admin has
     * both, and the LEFT JOIN keeps admins who somehow have no employee row.
     */
    async findAdminsForCountry(policy_type, country_code = null) {
        const result = await db.query(
            `SELECT c.id            AS company_id,
                    c.company_name,
                    c.country_code,
                    u.id            AS user_id,
                    u.first_name,
                    u.last_name,
                    u.email,
                    e.id            AS employee_id
               FROM companies c
               JOIN user_companies uc
                 ON uc.company_id = c.id
                AND uc.role = '0'
                AND uc.is_active = TRUE
                AND uc.deleted_at IS NULL
               JOIN users u
                 ON u.id = uc.user_id
                AND u.is_active = TRUE
                AND u.deleted_at IS NULL
               LEFT JOIN employees e
                 ON e.user_id = u.id
                AND e.company_id = c.id
                AND e.deleted_at IS NULL
              WHERE c.deleted_at IS NULL
                AND c.is_active = TRUE
                AND (
                     ($2::VARCHAR IS NOT NULL AND c.country_code = $2)
                  OR ($2::VARCHAR IS NULL AND NOT EXISTS (
                         SELECT 1 FROM policy_documents p
                          WHERE p.policy_type = $1
                            AND p.is_current = TRUE
                            AND p.country_code IS NOT NULL
                            AND p.country_code = c.country_code
                     ))
                )`,
            [policy_type, country_code]
        );
        return result.rows;
    },
};

const PolicyAcceptance = {
    /**
     * Record an acceptance.
     *
     * ON CONFLICT DO NOTHING covers the double-submitted registration form and
     * an admin clicking "I Agree" twice: the first row stands, and the
     * timestamp keeps meaning "when they actually agreed". The follow-up SELECT
     * returns the existing row so callers always get one back.
     */
    async record(data, client = db) {
        const {
            company_id,
            policy_document_id,
            policy_type,
            policy_version,
            country_code = null,
            accepted_by_user_id = null,
            accepted_by_name = null,
            accepted_by_email = null,
            acceptance_context = "registration",
            ip_address = null,
            user_agent = null,
        } = data;

        const result = await client.query(
            `INSERT INTO company_policy_acceptances (
                company_id, policy_document_id, policy_type, policy_version,
                country_code, accepted_by_user_id, accepted_by_name,
                accepted_by_email, acceptance_context, ip_address, user_agent
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (company_id, policy_document_id) DO NOTHING
             RETURNING *`,
            [
                company_id, policy_document_id, policy_type, policy_version,
                country_code, accepted_by_user_id, accepted_by_name,
                accepted_by_email, acceptance_context, ip_address, user_agent,
            ]
        );

        if (result.rows[0]) return result.rows[0];

        const existing = await client.query(
            `SELECT * FROM company_policy_acceptances
              WHERE company_id = $1 AND policy_document_id = $2`,
            [company_id, policy_document_id]
        );
        return existing.rows[0];
    },

    /** Full acceptance history for a company, newest first. */
    async listByCompany(company_id, { policy_type = null } = {}) {
        const values = [company_id];
        let filter = "";
        if (policy_type) {
            values.push(policy_type);
            filter = ` AND a.policy_type = $2`;
        }

        const result = await db.query(
            `SELECT a.*,
                    p.title      AS policy_title,
                    p.effective_from
               FROM company_policy_acceptances a
               JOIN policy_documents p ON p.id = a.policy_document_id
              WHERE a.company_id = $1${filter}
              ORDER BY a.accepted_at DESC`,
            values
        );
        return result.rows;
    },

    /** The most recent acceptance per policy_type — what the profile shows. */
    async latestByCompany(company_id) {
        const result = await db.query(
            `SELECT DISTINCT ON (a.policy_type)
                    a.*, p.title AS policy_title, p.effective_from
               FROM company_policy_acceptances a
               JOIN policy_documents p ON p.id = a.policy_document_id
              WHERE a.company_id = $1
              ORDER BY a.policy_type, a.accepted_at DESC`,
            [company_id]
        );
        return result.rows;
    },

    /** Every company that has accepted one specific version — Super Admin. */
    async listByDocument(policy_document_id, { page = 1, limit = 50 } = {}) {
        const offset = (page - 1) * limit;

        const rows = await db.query(
            `SELECT a.*, c.company_name, c.company_code
               FROM company_policy_acceptances a
               JOIN companies c ON c.id = a.company_id
              WHERE a.policy_document_id = $1
              ORDER BY a.accepted_at DESC
              LIMIT $2 OFFSET $3`,
            [policy_document_id, limit, offset]
        );

        const count = await db.query(
            `SELECT COUNT(*) AS total
               FROM company_policy_acceptances
              WHERE policy_document_id = $1`,
            [policy_document_id]
        );

        return { rows: rows.rows, total: Number(count.rows[0].total) };
    },
};

module.exports = { PolicyDocument, PolicyAcceptance };
