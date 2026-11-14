/**
 * Jobs — agency side, client side and the public portal.
 */
const db = require("../../config/database");
const { buildUpdate, buildInsert } = require("./sql");

const JOB_FIELDS = [
    "client_id", "title", "status", "source", "sector", "employment_type", "work_mode", "openings",
    "description", "responsibilities", "requirements", "benefits",
    "experience_min", "experience_max", "education", "skills", "tags",
    "location_city", "location_country",
    "salary_min", "salary_max", "salary_currency", "salary_period",
    "show_salary", "show_company", "list_on_portal", "form_config",
    "location_bound", "bound_label", "bound_latitude", "bound_longitude", "bound_radius_km",
    "deadline", "published_at", "closed_at",
];

// Per-job application counts, joined onto job lists.
const COUNTS_JOIN = `
    LEFT JOIN (
        SELECT job_id,
               COUNT(*)                                                   AS total,
               COUNT(*) FILTER (WHERE stage = 'applied')                  AS new,
               COUNT(*) FILTER (WHERE shared_with_client)                 AS shared,
               COUNT(*) FILTER (WHERE client_decision = 'approved')       AS approved,
               COUNT(*) FILTER (WHERE client_decision = 'finalized')      AS finalized
          FROM recruitment_applications
         WHERE agency_company_id = $1
         GROUP BY job_id
    ) ac ON ac.job_id = j.id`;

const COUNT_COLUMNS = `
    COALESCE(ac.total, 0)::int     AS application_count,
    COALESCE(ac.new, 0)::int       AS new_count,
    COALESCE(ac.shared, 0)::int    AS shared_count,
    COALESCE(ac.approved, 0)::int  AS approved_count,
    COALESCE(ac.finalized, 0)::int AS finalized_count`;

// The public portal never shows a job past its deadline, nor one whose agency
// company has been disabled or deleted.
const PUBLIC_WHERE = `
    j.status = 'open'
    AND (j.deadline IS NULL OR j.deadline >= CURRENT_DATE)
    AND co.is_active = TRUE AND co.deleted_at IS NULL`;

const PUBLIC_COLUMNS = `
    j.id, j.slug, j.title, j.sector, j.employment_type, j.work_mode, j.openings,
    j.location_city, j.location_country, j.experience_min, j.experience_max, j.education,
    j.salary_min, j.salary_max, j.salary_currency, j.salary_period, j.show_salary, j.show_company,
    j.tags, j.skills, j.deadline, j.published_at, j.updated_at, j.list_on_portal,
    c.name AS client_name, c.logo_url AS client_logo_url, c.website AS client_website,
    COALESCE(a.display_name, co.company_name) AS agency_name, a.logo_url AS agency_logo_url, a.slug AS agency_slug`;

const PUBLIC_FROM = `
    FROM recruitment_jobs j
    JOIN companies co ON co.id = j.agency_company_id
    LEFT JOIN recruitment_clients c ON c.id = j.client_id
    LEFT JOIN recruitment_agencies a ON a.company_id = j.agency_company_id`;

const JobModel = {
    JOB_FIELDS,

    async create(data) {
        const ins = buildInsert(data, ["agency_company_id", "slug", "created_by", ...JOB_FIELDS]);
        const { rows } = await db.query(
            `INSERT INTO recruitment_jobs (${ins.cols}) VALUES (${ins.params}) RETURNING *`,
            ins.values,
        );
        return rows[0];
    },

    async update(id, agency_company_id, data) {
        const upd = buildUpdate(data, JOB_FIELDS, 3);
        if (!upd) return this.findForAgency(id, agency_company_id);
        const { rows } = await db.query(
            `UPDATE recruitment_jobs SET ${upd.sets} WHERE id = $1 AND agency_company_id = $2 RETURNING *`,
            [id, agency_company_id, ...upd.values],
        );
        return rows[0] || null;
    },

    async slugExists(slug) {
        const { rows } = await db.query(`SELECT 1 FROM recruitment_jobs WHERE slug = $1`, [slug]);
        return rows.length > 0;
    },

    async findForAgency(id, agency_company_id) {
        const { rows } = await db.query(
            `SELECT j.*, c.name AS client_name, ${COUNT_COLUMNS}
               FROM recruitment_jobs j
               LEFT JOIN recruitment_clients c ON c.id = j.client_id
               ${COUNTS_JOIN}
              WHERE j.id = $2 AND j.agency_company_id = $1`,
            [agency_company_id, id],
        );
        return rows[0] || null;
    },

    async listForAgency(agency_company_id, { status, client_id, q } = {}) {
        const where = ["j.agency_company_id = $1"];
        const values = [agency_company_id];
        if (status) { values.push(status); where.push(`j.status = $${values.length}`); }
        if (client_id) { values.push(client_id); where.push(`j.client_id = $${values.length}`); }
        if (q) { values.push(`%${q}%`); where.push(`j.title ILIKE $${values.length}`); }

        const { rows } = await db.query(
            `SELECT j.id, j.slug, j.title, j.status, j.source, j.sector, j.employment_type, j.work_mode,
                    j.location_city, j.location_country, j.openings, j.deadline, j.published_at,
                    j.list_on_portal, j.location_bound, j.created_at, j.updated_at,
                    j.client_id, c.name AS client_name, ${COUNT_COLUMNS}
               FROM recruitment_jobs j
               LEFT JOIN recruitment_clients c ON c.id = j.client_id
               ${COUNTS_JOIN}
              WHERE ${where.join(" AND ")}
              ORDER BY (j.status = 'requested') DESC, j.created_at DESC
              LIMIT 500`,
            values,
        );
        return rows;
    },

    /** The agency's headline numbers, one query. */
    async overview(agency_company_id) {
        const { rows } = await db.query(
            `SELECT
                (SELECT COUNT(*) FROM recruitment_jobs WHERE agency_company_id = $1 AND status = 'open')::int       AS open_jobs,
                (SELECT COUNT(*) FROM recruitment_jobs WHERE agency_company_id = $1 AND status = 'requested')::int  AS requested_jobs,
                (SELECT COUNT(*) FROM recruitment_clients WHERE agency_company_id = $1 AND is_active)::int          AS clients,
                (SELECT COUNT(*) FROM recruitment_applications WHERE agency_company_id = $1 AND stage = 'applied')::int AS new_applications,
                (SELECT COUNT(*) FROM recruitment_applications WHERE agency_company_id = $1
                    AND created_at >= NOW() - INTERVAL '7 days')::int                                              AS applications_7d,
                (SELECT COUNT(*) FROM recruitment_applications WHERE agency_company_id = $1
                    AND client_decision = 'finalized')::int                                                        AS finalized`,
            [agency_company_id],
        );
        return rows[0];
    },

    // ── Client portal ───────────────────────────────────────────────────────
    async listForClient(agency_company_id, client_id) {
        const { rows } = await db.query(
            `SELECT j.id, j.slug, j.title, j.status, j.source, j.sector, j.employment_type, j.work_mode,
                    j.location_city, j.location_country, j.openings, j.deadline, j.published_at, j.created_at,
                    ${COUNT_COLUMNS}
               FROM recruitment_jobs j
               ${COUNTS_JOIN}
              WHERE j.agency_company_id = $1 AND j.client_id = $2
              ORDER BY j.created_at DESC`,
            [agency_company_id, client_id],
        );
        return rows;
    },

    async findForClient(id, client_id) {
        const { rows } = await db.query(
            `SELECT * FROM recruitment_jobs WHERE id = $1 AND client_id = $2`,
            [id, client_id],
        );
        return rows[0] || null;
    },

    // ── Public portal ───────────────────────────────────────────────────────
    async listPublic({ q, sector, location, type, mode, tag, agency, page = 1, limit = 20 }) {
        const where = [PUBLIC_WHERE, "j.list_on_portal = TRUE"];
        const values = [];
        const add = (sql, value) => { values.push(value); where.push(sql.replace("?", `$${values.length}`)); };

        // The client's name is deliberately not searchable — a hidden company
        // must not be discoverable by typing its name.
        if (q) add(`(j.title ILIKE ? OR j.sector ILIKE $${values.length + 1} OR array_to_string(j.tags, ' ') ILIKE $${values.length + 1} OR array_to_string(j.skills, ' ') ILIKE $${values.length + 1})`, `%${q}%`);
        if (sector) add(`LOWER(j.sector) = LOWER(?)`, sector);
        if (location) add(`(j.location_city ILIKE ? OR j.location_country ILIKE $${values.length + 1})`, `%${location}%`);
        if (type) add(`j.employment_type = ?`, type);
        if (mode) add(`j.work_mode = ?`, mode);
        if (tag) add(`LOWER(?) = ANY(SELECT LOWER(t) FROM unnest(j.tags) t)`, tag);
        if (agency) add(`a.slug = ?`, agency);

        values.push(limit, (page - 1) * limit);
        const { rows } = await db.query(
            `SELECT ${PUBLIC_COLUMNS}, LEFT(j.description, 260) AS excerpt, COUNT(*) OVER()::int AS total_count
               ${PUBLIC_FROM}
              WHERE ${where.join(" AND ")}
              ORDER BY j.published_at DESC NULLS LAST
              LIMIT $${values.length - 1} OFFSET $${values.length}`,
            values,
        );
        return { rows, total: rows[0]?.total_count ?? 0 };
    },

    /** Filter options for the portal, with counts. */
    async publicFacets() {
        const { rows } = await db.query(
            `SELECT 'sector' AS kind, j.sector AS value, COUNT(*)::int AS count
               ${PUBLIC_FROM}
              WHERE ${PUBLIC_WHERE} AND j.list_on_portal AND j.sector IS NOT NULL AND j.sector <> ''
              GROUP BY j.sector
             UNION ALL
             SELECT 'location', j.location_city, COUNT(*)::int
               ${PUBLIC_FROM}
              WHERE ${PUBLIC_WHERE} AND j.list_on_portal AND j.location_city IS NOT NULL AND j.location_city <> ''
              GROUP BY j.location_city
             ORDER BY 3 DESC
             LIMIT 80`,
        );
        return rows;
    },

    /**
     * One open job by slug. Unlisted jobs are returned too — the shareable
     * link must work even when the job is kept off the portal.
     */
    async findPublicBySlug(slug) {
        const { rows } = await db.query(
            `SELECT ${PUBLIC_COLUMNS}, j.agency_company_id, j.client_id, j.status,
                    j.description, j.responsibilities, j.requirements, j.benefits, j.form_config,
                    j.location_bound, j.bound_label, j.bound_latitude, j.bound_longitude, j.bound_radius_km,
                    a.about AS agency_about, a.website AS agency_website
               ${PUBLIC_FROM}
              WHERE j.slug = $1 AND co.is_active = TRUE AND co.deleted_at IS NULL
                AND j.status IN ('open', 'paused', 'closed', 'filled')`,
            [slug],
        );
        return rows[0] || null;
    },

    async sitemap() {
        const { rows } = await db.query(
            `SELECT j.slug, j.updated_at ${PUBLIC_FROM}
              WHERE ${PUBLIC_WHERE} AND j.list_on_portal
              ORDER BY j.published_at DESC NULLS LAST LIMIT 5000`,
        );
        return rows;
    },
};

module.exports = JobModel;
