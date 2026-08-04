const db = require("../config/database");

/**
 * Reads over `activity_logs`. Writes are done by the activityLogger middleware.
 *
 * `company_id = NULL` rows are pre-auth actions (company registration, failed
 * logins) — they only ever appear in the platform-wide feed.
 */

const SELECT_COLUMNS = `
    l.id, l.company_id, l.user_id, l.user_company_id, l.username,
    l.action, l.entity_type, l.entity_id,
    l.method, l.path, l.status_code, l.is_success,
    l.request_body, l.error_message,
    l.ip_address, l.user_agent, l.duration_ms, l.created_at,
    COALESCE(l.actor_name, u.first_name || ' ' || u.last_name) AS actor_name,
    u.email        AS actor_email,
    l.role         AS actor_role,
    c.company_name, c.company_code
`;

const FROM_JOINS = `
    FROM activity_logs l
    LEFT JOIN users u     ON u.id = l.user_id
    LEFT JOIN companies c ON c.id = l.company_id
`;

/**
 * Shared filter builder. `startIndex` lets the same clause be reused by the
 * list query and the count query, which have different placeholder offsets.
 */
function buildFilters(opts, startIndex = 0) {
    const {
        company_id = null,
        user_id = null,
        action = null,
        entity_type = null,
        entity_id = null,
        method = null,
        status = null, // success | failure
        search = null,
        from = null,
        to = null,
    } = opts;

    const conds = ["1 = 1"];
    const vals = [];
    let i = startIndex;

    if (company_id) {
        i++; vals.push(company_id);
        conds.push(`l.company_id = $${i}`);
    }
    if (user_id) {
        i++; vals.push(user_id);
        conds.push(`l.user_id = $${i}`);
    }
    if (action) {
        i++; vals.push(action);
        conds.push(`l.action = $${i}`);
    }
    if (entity_type) {
        i++; vals.push(entity_type);
        conds.push(`l.entity_type = $${i}`);
    }
    if (entity_id) {
        i++; vals.push(entity_id);
        conds.push(`l.entity_id = $${i}`);
    }
    if (method) {
        i++; vals.push(String(method).toUpperCase());
        conds.push(`l.method = $${i}`);
    }
    if (status === "success") conds.push("l.is_success = true");
    if (status === "failure") conds.push("l.is_success = false");

    if (search) {
        i++; vals.push(`%${search}%`);
        conds.push(`(l.action ILIKE $${i} OR l.path ILIKE $${i} OR l.username ILIKE $${i})`);
    }
    if (from) {
        i++; vals.push(from);
        conds.push(`l.created_at >= $${i}::date`);
    }
    if (to) {
        i++; vals.push(to);
        conds.push(`l.created_at < ($${i}::date + INTERVAL '1 day')`);
    }

    return { sql: conds.join(" AND "), vals, next: i };
}

const ActivityLog = {
    /** Paginated feed. Omit company_id for the platform-wide view. */
    async list(opts) {
        const { page = 1, limit = 50 } = opts;
        const offset = (page - 1) * limit;

        const listFilters = buildFilters(opts, 0);
        const countFilters = buildFilters(opts, 0);

        const listResult = await db.query(
            `SELECT ${SELECT_COLUMNS}
             ${FROM_JOINS}
             WHERE ${listFilters.sql}
             ORDER BY l.created_at DESC
             LIMIT $${listFilters.next + 1} OFFSET $${listFilters.next + 2}`,
            [...listFilters.vals, limit, offset]
        );

        const countResult = await db.query(
            `SELECT COUNT(*) AS total FROM activity_logs l WHERE ${countFilters.sql}`,
            countFilters.vals
        );

        return { rows: listResult.rows, total: parseInt(countResult.rows[0].total, 10) };
    },

    /** Full history of one record, oldest → newest. */
    async listForEntity(entity_type, entity_id, limit = 100) {
        const result = await db.query(
            `SELECT ${SELECT_COLUMNS}
             ${FROM_JOINS}
             WHERE l.entity_type = $1 AND l.entity_id = $2
             ORDER BY l.created_at ASC
             LIMIT $3`,
            [entity_type, entity_id, limit]
        );
        return result.rows;
    },

    /** Headline counters for a window. Pass company_id = null for platform-wide. */
    async summary(company_id, from, to) {
        const result = await db.query(
            `SELECT
                COUNT(*)                                    AS total_actions,
                COUNT(*) FILTER (WHERE is_success)          AS success_count,
                COUNT(*) FILTER (WHERE NOT is_success)      AS failure_count,
                COUNT(DISTINCT user_id)                     AS active_users,
                COUNT(DISTINCT company_id)                  AS active_companies,
                COUNT(*) FILTER (WHERE action = 'auth.login' AND is_success) AS login_count,
                COALESCE(ROUND(AVG(duration_ms)), 0)        AS avg_duration_ms
             FROM activity_logs
             WHERE ($1::uuid IS NULL OR company_id = $1)
               AND created_at >= $2::date
               AND created_at < ($3::date + INTERVAL '1 day')`,
            [company_id, from, to]
        );
        return result.rows[0];
    },

    /** Most frequent actions in the window. */
    async topActions(company_id, from, to, limit = 15) {
        const result = await db.query(
            `SELECT action, entity_type,
                    COUNT(*)                               AS count,
                    COUNT(*) FILTER (WHERE NOT is_success) AS failure_count
             FROM activity_logs
             WHERE ($1::uuid IS NULL OR company_id = $1)
               AND created_at >= $2::date
               AND created_at < ($3::date + INTERVAL '1 day')
             GROUP BY action, entity_type
             ORDER BY count DESC
             LIMIT $4`,
            [company_id, from, to, limit]
        );
        return result.rows;
    },

    /** Busiest users in the window. */
    async topActors(company_id, from, to, limit = 10) {
        const result = await db.query(
            `SELECT l.user_id, l.username,
                    COALESCE(MAX(l.actor_name), MAX(u.first_name || ' ' || u.last_name)) AS actor_name,
                    MAX(u.email)  AS actor_email,
                    COUNT(*)      AS action_count,
                    MAX(l.created_at) AS last_action_at
             FROM activity_logs l
             LEFT JOIN users u ON u.id = l.user_id
             WHERE ($1::uuid IS NULL OR l.company_id = $1)
               AND l.user_id IS NOT NULL
               AND l.created_at >= $2::date
               AND l.created_at < ($3::date + INTERVAL '1 day')
             GROUP BY l.user_id, l.username
             ORDER BY action_count DESC
             LIMIT $4`,
            [company_id, from, to, limit]
        );
        return result.rows;
    },

    /** Daily volume, for the activity sparkline. */
    async dailyVolume(company_id, from, to) {
        const result = await db.query(
            `SELECT created_at::date                        AS date,
                    COUNT(*)                                AS total,
                    COUNT(*) FILTER (WHERE NOT is_success)  AS failures
             FROM activity_logs
             WHERE ($1::uuid IS NULL OR company_id = $1)
               AND created_at >= $2::date
               AND created_at < ($3::date + INTERVAL '1 day')
             GROUP BY 1
             ORDER BY 1 ASC`,
            [company_id, from, to]
        );
        return result.rows;
    },

    /** Per-company activity volume — "which tenants are actually being used". */
    async volumeByCompany(from, to, limit = 50) {
        const result = await db.query(
            `SELECT c.id AS company_id, c.company_name, c.company_code, c.is_active,
                    COUNT(l.id)                                  AS action_count,
                    COUNT(l.id) FILTER (WHERE NOT l.is_success)  AS failure_count,
                    COUNT(DISTINCT l.user_id)                    AS active_users,
                    MAX(l.created_at)                            AS last_activity_at
             FROM companies c
             LEFT JOIN activity_logs l
                    ON l.company_id = c.id
                   AND l.created_at >= $1::date
                   AND l.created_at < ($2::date + INTERVAL '1 day')
             WHERE c.deleted_at IS NULL
             GROUP BY c.id
             ORDER BY action_count DESC, c.company_name ASC
             LIMIT $3`,
            [from, to, limit]
        );
        return result.rows;
    },

    /** Distinct action names present in the data — populates filter dropdowns. */
    async distinctActions(company_id) {
        const result = await db.query(
            `SELECT DISTINCT action, entity_type
             FROM activity_logs
             WHERE ($1::uuid IS NULL OR company_id = $1)
             ORDER BY action ASC`,
            [company_id]
        );
        return result.rows;
    },

    /** Housekeeping: drop rows older than N days. */
    async purgeOlderThan(days) {
        const result = await db.query(
            `DELETE FROM activity_logs
             WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
            [days]
        );
        return result.rowCount;
    },
};

module.exports = ActivityLog;
