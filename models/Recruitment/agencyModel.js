/**
 * Agency profile, its client companies, and the client logins.
 */
const db = require("../../config/database");
const { buildUpdate, buildInsert } = require("./sql");

const AGENCY_FIELDS = ["display_name", "slug", "logo_url", "logo_public_id", "website", "contact_email", "contact_phone", "about"];
const CLIENT_FIELDS = ["name", "industry", "website", "logo_url", "location", "contact_name", "contact_email", "contact_phone", "about", "is_active"];

// Safe to send to a browser: never the password hash.
const CLIENT_USER_COLUMNS = `id, client_id, agency_company_id, full_name, email, is_active, last_login_at, created_at`;

const AgencyModel = {
    // ── Agency ──────────────────────────────────────────────────────────────
    async findByCompany(company_id) {
        const { rows } = await db.query(`SELECT * FROM recruitment_agencies WHERE company_id = $1`, [company_id]);
        return rows[0] || null;
    },

    async slugTaken(slug, exceptCompanyId = null) {
        const { rows } = await db.query(
            `SELECT 1 FROM recruitment_agencies WHERE slug = $1 AND company_id IS DISTINCT FROM $2`,
            [slug, exceptCompanyId],
        );
        return rows.length > 0;
    },

    async upsert(company_id, data) {
        const existing = await this.findByCompany(company_id);
        if (!existing) {
            const ins = buildInsert({ ...data, company_id }, ["company_id", ...AGENCY_FIELDS]);
            const { rows } = await db.query(
                `INSERT INTO recruitment_agencies (${ins.cols}) VALUES (${ins.params}) RETURNING *`,
                ins.values,
            );
            return rows[0];
        }
        const upd = buildUpdate(data, AGENCY_FIELDS, 2);
        if (!upd) return existing;
        const { rows } = await db.query(
            `UPDATE recruitment_agencies SET ${upd.sets} WHERE company_id = $1 RETURNING *`,
            [company_id, ...upd.values],
        );
        return rows[0];
    },

    // ── Clients ─────────────────────────────────────────────────────────────
    /** Every client with its job and login counts, in one round trip. */
    async listClients(agency_company_id) {
        const { rows } = await db.query(
            `SELECT c.*,
                    COALESCE(j.total, 0)::int AS job_count,
                    COALESCE(j.open, 0)::int  AS open_job_count,
                    COALESCE(u.total, 0)::int AS user_count
               FROM recruitment_clients c
               LEFT JOIN (
                    SELECT client_id, COUNT(*) AS total, COUNT(*) FILTER (WHERE status = 'open') AS open
                      FROM recruitment_jobs WHERE agency_company_id = $1 GROUP BY client_id
               ) j ON j.client_id = c.id
               LEFT JOIN (
                    SELECT client_id, COUNT(*) AS total
                      FROM recruitment_client_users WHERE agency_company_id = $1 AND is_active GROUP BY client_id
               ) u ON u.client_id = c.id
              WHERE c.agency_company_id = $1
              ORDER BY c.is_active DESC, c.name`,
            [agency_company_id],
        );
        return rows;
    },

    async findClient(id, agency_company_id) {
        const { rows } = await db.query(
            `SELECT * FROM recruitment_clients WHERE id = $1 AND agency_company_id = $2`,
            [id, agency_company_id],
        );
        return rows[0] || null;
    },

    async createClient(agency_company_id, data) {
        const ins = buildInsert({ ...data, agency_company_id }, ["agency_company_id", ...CLIENT_FIELDS]);
        const { rows } = await db.query(
            `INSERT INTO recruitment_clients (${ins.cols}) VALUES (${ins.params}) RETURNING *`,
            ins.values,
        );
        return rows[0];
    },

    async updateClient(id, agency_company_id, data) {
        const upd = buildUpdate(data, CLIENT_FIELDS, 3);
        if (!upd) return this.findClient(id, agency_company_id);
        const { rows } = await db.query(
            `UPDATE recruitment_clients SET ${upd.sets} WHERE id = $1 AND agency_company_id = $2 RETURNING *`,
            [id, agency_company_id, ...upd.values],
        );
        return rows[0] || null;
    },

    // ── Client logins ───────────────────────────────────────────────────────
    async listClientUsers(client_id, agency_company_id) {
        const { rows } = await db.query(
            `SELECT ${CLIENT_USER_COLUMNS} FROM recruitment_client_users
              WHERE client_id = $1 AND agency_company_id = $2 ORDER BY created_at`,
            [client_id, agency_company_id],
        );
        return rows;
    },

    async emailTaken(email, exceptId = null) {
        const { rows } = await db.query(
            `SELECT 1 FROM recruitment_client_users WHERE LOWER(email) = LOWER($1) AND id IS DISTINCT FROM $2`,
            [email, exceptId],
        );
        return rows.length > 0;
    },

    async createClientUser({ client_id, agency_company_id, full_name, email, password_hash }) {
        const { rows } = await db.query(
            `INSERT INTO recruitment_client_users (client_id, agency_company_id, full_name, email, password_hash)
             VALUES ($1, $2, $3, $4, $5) RETURNING ${CLIENT_USER_COLUMNS}`,
            [client_id, agency_company_id, full_name, email, password_hash],
        );
        return rows[0];
    },

    async updateClientUser(id, agency_company_id, data) {
        const upd = buildUpdate(data, ["full_name", "is_active", "password_hash", "failed_login_attempts"], 3);
        if (!upd) return null;
        const { rows } = await db.query(
            `UPDATE recruitment_client_users SET ${upd.sets}
              WHERE id = $1 AND agency_company_id = $2 RETURNING ${CLIENT_USER_COLUMNS}`,
            [id, agency_company_id, ...upd.values],
        );
        return rows[0] || null;
    },

    /** For login only — the one query that returns the hash. */
    async findClientUserForLogin(email) {
        const { rows } = await db.query(
            `SELECT u.*, c.is_active AS client_is_active
               FROM recruitment_client_users u
               JOIN recruitment_clients c ON c.id = u.client_id
              WHERE LOWER(u.email) = LOWER($1)`,
            [email],
        );
        return rows[0] || null;
    },

    async findClientUserById(id) {
        const { rows } = await db.query(
            `SELECT u.*, c.is_active AS client_is_active FROM recruitment_client_users u
               JOIN recruitment_clients c ON c.id = u.client_id WHERE u.id = $1`,
            [id],
        );
        return rows[0] || null;
    },

    async recordLogin(id, ok) {
        await db.query(
            ok
                ? `UPDATE recruitment_client_users SET failed_login_attempts = 0, last_login_at = NOW() WHERE id = $1`
                : `UPDATE recruitment_client_users SET failed_login_attempts = failed_login_attempts + 1 WHERE id = $1`,
            [id],
        );
    },

    /** What the client portal shows in its shell: their company + the agency's brand. */
    async clientBranding(client_id) {
        const { rows } = await db.query(
            `SELECT c.id AS client_id, c.name AS client_name, c.logo_url AS client_logo_url,
                    a.display_name AS agency_name, a.logo_url AS agency_logo_url,
                    a.contact_email AS agency_email, a.contact_phone AS agency_phone,
                    COALESCE(a.display_name, co.company_name) AS agency_display
               FROM recruitment_clients c
               JOIN companies co ON co.id = c.agency_company_id
               LEFT JOIN recruitment_agencies a ON a.company_id = c.agency_company_id
              WHERE c.id = $1`,
            [client_id],
        );
        return rows[0] || null;
    },
};

module.exports = AgencyModel;
