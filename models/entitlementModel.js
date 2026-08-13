const db = require("../config/database");
const { Limit } = require("../enums/features");

/**
 * Reads the resolved entitlement picture for a company.
 *
 * Resolution order, applied per feature key:
 *
 *   1. company_feature_overrides  (unexpired)   → wins
 *   2. plan_feature_values for the EFFECTIVE plan
 *   3. nothing                                  → denied / zero
 *
 * The "effective plan" is not simply companies.plan_id. A company whose
 * plan_expires_at has passed (plus the plan's grace_days) falls back to the
 * plan flagged is_fallback — otherwise an expired Gold company would keep
 * every Gold feature forever.
 */

const EntitlementModel = {
    /**
     * The company's plan as it stands right now, including whether it has
     * lapsed and which plan it is actually being served under.
     */
    async getCompanyPlanState(company_id) {
        const result = await db.query(
            `WITH fallback AS (
                SELECT id, code, name, tier
                FROM plans
                WHERE is_fallback = TRUE AND deleted_at IS NULL
                LIMIT 1
             )
             SELECT
                c.id                    AS company_id,
                c.company_name,
                c.plan_id               AS assigned_plan_id,
                c.plan_expires_at,

                p.code                  AS assigned_plan_code,
                p.name                  AS assigned_plan_name,
                p.tier                  AS assigned_plan_tier,
                p.grace_days,

                -- Lapsed the moment expiry + grace is behind us.
                (c.plan_expires_at IS NOT NULL
                 AND c.plan_expires_at + (COALESCE(p.grace_days, 0) || ' days')::INTERVAL < NOW())
                                        AS is_expired,

                -- Inside the grace window: expired, but still fully entitled.
                (c.plan_expires_at IS NOT NULL
                 AND c.plan_expires_at < NOW()
                 AND c.plan_expires_at + (COALESCE(p.grace_days, 0) || ' days')::INTERVAL >= NOW())
                                        AS is_in_grace,

                f.id                    AS fallback_plan_id,
                f.code                  AS fallback_plan_code,
                f.name                  AS fallback_plan_name
             FROM companies c
             LEFT JOIN plans p    ON p.id = c.plan_id
             LEFT JOIN fallback f ON TRUE
             WHERE c.id = $1 AND c.deleted_at IS NULL`,
            [company_id]
        );

        const row = result.rows[0];
        if (!row) return null;

        // A company with no plan row at all (created before this module, or
        // whose plan was deleted) is served the fallback plan rather than
        // being denied everything.
        const useFallback = row.is_expired || !row.assigned_plan_id;

        return {
            ...row,
            effective_plan_id:   useFallback ? row.fallback_plan_id   : row.assigned_plan_id,
            effective_plan_code: useFallback ? row.fallback_plan_code : row.assigned_plan_code,
            effective_plan_name: useFallback ? row.fallback_plan_name : row.assigned_plan_name,
            is_downgraded_by_expiry: useFallback && Boolean(row.assigned_plan_id),
        };
    },

    /**
     * Every feature key with its resolved value for this company.
     *
     * One query, LEFT JOINed from the catalog so features the plan has no row
     * for still come back (denied) — the pricing page needs the full list to
     * show what an upgrade would unlock.
     */
    async getResolvedFeatures(company_id, effective_plan_id) {
        const result = await db.query(
            `SELECT
                pf.key,
                pf.category,
                pf.label,
                pf.value_type,
                pf.is_enforceable,
                pf.is_visible,
                pf.sort_order,

                -- COALESCE picks the override first, then the plan value.
                COALESCE(o.bool_value,   v.bool_value,  FALSE) AS bool_value,
                COALESCE(o.limit_value,  v.limit_value)        AS limit_value,
                COALESCE(o.is_unlimited, v.is_unlimited, FALSE) AS is_unlimited,
                COALESCE(o.json_value,   v.json_value)         AS json_value,
                v.note,

                (o.company_id IS NOT NULL)                     AS is_overridden,
                o.reason                                       AS override_reason,
                o.expires_at                                   AS override_expires_at

             FROM plan_features pf
             LEFT JOIN plan_feature_values v
                    ON v.feature_key = pf.key
                   AND v.plan_id     = $2
             LEFT JOIN company_feature_overrides o
                    ON o.feature_key = pf.key
                   AND o.company_id  = $1
                   AND (o.expires_at IS NULL OR o.expires_at > NOW())
             ORDER BY pf.sort_order ASC, pf.key ASC`,
            [company_id, effective_plan_id]
        );
        return result.rows;
    },

    /**
     * Live counts behind every numeric cap, in one round trip.
     *
     * Counted the same way the modules themselves count: not soft-deleted.
     * Employees additionally exclude 'terminated' — a company that offboards
     * someone should get that seat back, otherwise the cap ratchets shut over
     * time and looks like a bug.
     */
    async countUsage(company_id) {
        const result = await db.query(
            `SELECT
                (SELECT COUNT(*)::int FROM employees
                  WHERE company_id = $1
                    AND deleted_at IS NULL
                    AND status <> 'terminated')            AS employees,

                (SELECT COUNT(*)::int FROM branches
                  WHERE company_id = $1 AND deleted_at IS NULL)   AS branches,

                (SELECT COUNT(*)::int FROM departments
                  WHERE company_id = $1 AND deleted_at IS NULL)   AS departments,

                (SELECT COUNT(*)::int FROM shifts
                  WHERE company_id = $1 AND deleted_at IS NULL)   AS shifts`,
            [company_id]
        );

        const row = result.rows[0];
        return {
            [Limit.EMPLOYEES]:   row.employees,
            [Limit.BRANCHES]:    row.branches,
            [Limit.DEPARTMENTS]: row.departments,
            [Limit.SHIFTS]:      row.shifts,
        };
    },

    /**
     * Count for a single limit key. Used on the create path, where paying for
     * four COUNT(*)s to check one cap would be wasteful.
     */
    async countUsageFor(company_id, limit_key) {
        const QUERIES = {
            [Limit.EMPLOYEES]:
                `SELECT COUNT(*)::int AS n FROM employees
                  WHERE company_id = $1 AND deleted_at IS NULL AND status <> 'terminated'`,
            [Limit.BRANCHES]:
                `SELECT COUNT(*)::int AS n FROM branches
                  WHERE company_id = $1 AND deleted_at IS NULL`,
            [Limit.DEPARTMENTS]:
                `SELECT COUNT(*)::int AS n FROM departments
                  WHERE company_id = $1 AND deleted_at IS NULL`,
            [Limit.SHIFTS]:
                `SELECT COUNT(*)::int AS n FROM shifts
                  WHERE company_id = $1 AND deleted_at IS NULL`,
        };

        const sql = QUERIES[limit_key];
        if (!sql) throw new Error(`No usage counter defined for limit "${limit_key}"`);

        const result = await db.query(sql, [company_id]);
        return result.rows[0].n;
    },

    // ── Company overrides (Super Admin) ───────────────────────────────────────

    async listOverrides(company_id) {
        const result = await db.query(
            `SELECT o.*, pf.label, pf.value_type, pf.category
             FROM company_feature_overrides o
             JOIN plan_features pf ON pf.key = o.feature_key
             WHERE o.company_id = $1
             ORDER BY pf.sort_order ASC`,
            [company_id]
        );
        return result.rows;
    },

    async upsertOverride(data) {
        const {
            company_id, feature_key,
            bool_value = null, limit_value = null, is_unlimited = false,
            json_value = null, reason = null, expires_at = null, created_by = null,
        } = data;

        const result = await db.query(
            `INSERT INTO company_feature_overrides (
                company_id, feature_key, bool_value, limit_value,
                is_unlimited, json_value, reason, expires_at, created_by
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (company_id, feature_key) DO UPDATE SET
                bool_value   = EXCLUDED.bool_value,
                limit_value  = EXCLUDED.limit_value,
                is_unlimited = EXCLUDED.is_unlimited,
                json_value   = EXCLUDED.json_value,
                reason       = EXCLUDED.reason,
                expires_at   = EXCLUDED.expires_at,
                created_by   = EXCLUDED.created_by
             RETURNING *`,
            [company_id, feature_key, bool_value, limit_value,
             is_unlimited, json_value, reason, expires_at, created_by]
        );
        return result.rows[0];
    },

    async deleteOverride(company_id, feature_key) {
        const result = await db.query(
            `DELETE FROM company_feature_overrides
             WHERE company_id = $1 AND feature_key = $2
             RETURNING *`,
            [company_id, feature_key]
        );
        return result.rows[0];
    },
};

module.exports = EntitlementModel;
