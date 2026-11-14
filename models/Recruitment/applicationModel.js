/**
 * Candidates (the agency's talent pool) and their applications.
 */
const db = require("../../config/database");
const { buildUpdate } = require("./sql");

// What every application list shows, agency or client.
const LIST_COLUMNS = `
    a.id, a.job_id, a.candidate_id, a.stage, a.shared_with_client, a.shared_at,
    a.client_decision, a.client_feedback, a.client_decided_at, a.source,
    a.distance_km, a.answers, a.cv_file_name, (a.cv_public_id IS NOT NULL) AS has_cv,
    a.created_at, a.updated_at,
    cd.full_name, cd.email, cd.phone, cd.linkedin_url, cd.current_location`;

const ApplicationModel = {
    /**
     * One candidate per agency per email. A returning applicant updates their
     * details rather than creating a duplicate person.
     */
    async upsertCandidate(client, { agency_company_id, full_name, email, phone, linkedin_url, current_location, cv_url, cv_public_id }) {
        const { rows } = await client.query(
            `INSERT INTO recruitment_candidates
                (agency_company_id, full_name, email, phone, linkedin_url, current_location, latest_cv_url, latest_cv_public_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (agency_company_id, LOWER(email)) DO UPDATE SET
                full_name           = EXCLUDED.full_name,
                phone               = COALESCE(EXCLUDED.phone, recruitment_candidates.phone),
                linkedin_url        = COALESCE(EXCLUDED.linkedin_url, recruitment_candidates.linkedin_url),
                current_location    = COALESCE(EXCLUDED.current_location, recruitment_candidates.current_location),
                latest_cv_url       = COALESCE(EXCLUDED.latest_cv_url, recruitment_candidates.latest_cv_url),
                latest_cv_public_id = COALESCE(EXCLUDED.latest_cv_public_id, recruitment_candidates.latest_cv_public_id)
             RETURNING *`,
            [agency_company_id, full_name, email, phone, linkedin_url, current_location, cv_url, cv_public_id],
        );
        return rows[0];
    },

    async alreadyApplied(job_id, email) {
        const { rows } = await db.query(
            `SELECT 1 FROM recruitment_applications a
               JOIN recruitment_candidates c ON c.id = a.candidate_id
              WHERE a.job_id = $1 AND LOWER(c.email) = LOWER($2)`,
            [job_id, email],
        );
        return rows.length > 0;
    },

    async create(client, data) {
        const { rows } = await client.query(
            `INSERT INTO recruitment_applications
                (agency_company_id, job_id, candidate_id, answers, cv_url, cv_public_id, cv_file_name,
                 applicant_latitude, applicant_longitude, distance_km, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING id`,
            [
                data.agency_company_id, data.job_id, data.candidate_id, data.answers,
                data.cv_url, data.cv_public_id, data.cv_file_name,
                data.applicant_latitude, data.applicant_longitude, data.distance_km, data.source,
            ],
        );
        return rows[0];
    },

    // ── Agency ──────────────────────────────────────────────────────────────
    async listForJob(agency_company_id, job_id, { stage, decision } = {}) {
        const where = ["a.agency_company_id = $1", "a.job_id = $2"];
        const values = [agency_company_id, job_id];
        if (stage) { values.push(stage); where.push(`a.stage = $${values.length}`); }
        if (decision) { values.push(decision); where.push(`a.client_decision = $${values.length}`); }
        const { rows } = await db.query(
            `SELECT ${LIST_COLUMNS}, a.agency_notes
               FROM recruitment_applications a
               JOIN recruitment_candidates cd ON cd.id = a.candidate_id
              WHERE ${where.join(" AND ")}
              ORDER BY a.created_at DESC`,
            values,
        );
        return rows;
    },

    /** Latest applications across every job — the overview feed. */
    async recentForAgency(agency_company_id, limit = 8) {
        const { rows } = await db.query(
            `SELECT a.id, a.job_id, a.stage, a.client_decision, a.created_at,
                    cd.full_name, cd.email, j.title AS job_title, c.name AS client_name
               FROM recruitment_applications a
               JOIN recruitment_candidates cd ON cd.id = a.candidate_id
               JOIN recruitment_jobs j ON j.id = a.job_id
               LEFT JOIN recruitment_clients c ON c.id = j.client_id
              WHERE a.agency_company_id = $1
              ORDER BY a.created_at DESC
              LIMIT $2`,
            [agency_company_id, limit],
        );
        return rows;
    },

    async findForAgency(id, agency_company_id) {
        const { rows } = await db.query(
            `SELECT * FROM recruitment_applications WHERE id = $1 AND agency_company_id = $2`,
            [id, agency_company_id],
        );
        return rows[0] || null;
    },

    async updateForAgency(id, agency_company_id, data) {
        const upd = buildUpdate(data, ["stage", "agency_notes", "shared_with_client", "shared_at"], 3);
        if (!upd) return this.findForAgency(id, agency_company_id);
        const { rows } = await db.query(
            `UPDATE recruitment_applications SET ${upd.sets}
              WHERE id = $1 AND agency_company_id = $2 RETURNING *`,
            [id, agency_company_id, ...upd.values],
        );
        return rows[0] || null;
    },

    /** Share (or un-share) several candidates of one job with its client. */
    async setShared(agency_company_id, ids, shared) {
        const { rows } = await db.query(
            `UPDATE recruitment_applications
                SET shared_with_client = $3::boolean,
                    shared_at = CASE WHEN $3::boolean THEN COALESCE(shared_at, NOW()) ELSE shared_at END
              WHERE agency_company_id = $1 AND id = ANY($2::uuid[])
              RETURNING id`,
            [agency_company_id, ids, shared],
        );
        return rows.length;
    },

    // ── Client portal ───────────────────────────────────────────────────────
    /** Only what the agency shared, and never the agency's private notes. */
    async listForClient(client_id, { job_id, decision } = {}) {
        const where = ["j.client_id = $1", "a.shared_with_client = TRUE"];
        const values = [client_id];
        if (job_id) { values.push(job_id); where.push(`a.job_id = $${values.length}`); }
        if (decision) { values.push(decision); where.push(`a.client_decision = $${values.length}`); }
        const { rows } = await db.query(
            `SELECT ${LIST_COLUMNS}, j.title AS job_title
               FROM recruitment_applications a
               JOIN recruitment_jobs j ON j.id = a.job_id
               JOIN recruitment_candidates cd ON cd.id = a.candidate_id
              WHERE ${where.join(" AND ")}
              ORDER BY a.shared_at DESC NULLS LAST`,
            values,
        );
        return rows;
    },

    async findForClient(id, client_id) {
        const { rows } = await db.query(
            `SELECT a.* FROM recruitment_applications a
               JOIN recruitment_jobs j ON j.id = a.job_id
              WHERE a.id = $1 AND j.client_id = $2 AND a.shared_with_client = TRUE`,
            [id, client_id],
        );
        return rows[0] || null;
    },

    async setClientDecision(id, decision, feedback) {
        const { rows } = await db.query(
            `UPDATE recruitment_applications
                SET client_decision = $2::varchar,
                    client_feedback = COALESCE($3, client_feedback),
                    client_decided_at = NOW(),
                    -- A finalized candidate is a hire on the agency's board too.
                    stage = CASE WHEN $2::varchar = 'finalized' THEN 'hired' ELSE stage END
              WHERE id = $1
              RETURNING id, client_decision, client_feedback, client_decided_at, stage`,
            [id, decision, feedback],
        );
        return rows[0] || null;
    },
};

module.exports = ApplicationModel;
