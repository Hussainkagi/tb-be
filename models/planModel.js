const db = require("../config/database");

/**
 * Plans + the plan × feature grid.
 *
 * The catalog (plan_features) is read-only from here on purpose: rows are
 * created by migrations, because a key that no code enforces is dead config.
 * Everything else on this model is Super Admin editable.
 */

const PlanModel = {
    // ── Catalog (read-only) ───────────────────────────────────────────────────

    async listFeatures() {
        const result = await db.query(
            `SELECT * FROM plan_features ORDER BY sort_order ASC, key ASC`
        );
        return result.rows;
    },

    async findFeature(key) {
        const result = await db.query(
            `SELECT * FROM plan_features WHERE key = $1`,
            [key]
        );
        return result.rows[0];
    },

    // ── Plans ─────────────────────────────────────────────────────────────────

    async listPlans({ include_inactive = false, public_only = false } = {}) {
        const conds = ["deleted_at IS NULL"];
        if (!include_inactive) conds.push("is_active = TRUE");
        if (public_only)       conds.push("is_public = TRUE");

        const result = await db.query(
            `SELECT * FROM plans
             WHERE ${conds.join(" AND ")}
             ORDER BY sort_order ASC, tier ASC`
        );
        return result.rows;
    },

    async findPlanById(id) {
        const result = await db.query(
            `SELECT * FROM plans WHERE id = $1 AND deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    },

    async findPlanByCode(code) {
        const result = await db.query(
            `SELECT * FROM plans WHERE code = $1 AND deleted_at IS NULL`,
            [code]
        );
        return result.rows[0];
    },

    async findFallbackPlan() {
        const result = await db.query(
            `SELECT * FROM plans
             WHERE is_fallback = TRUE AND deleted_at IS NULL
             LIMIT 1`
        );
        return result.rows[0];
    },

    /**
     * The plan a brand-new company starts on.
     *
     * Deliberately NOT findFallbackPlan(). The fallback is the floor every
     * expired or unassigned company resolves to; the signup plan is the
     * 45-day full-feature trial. They were the same row until
     * 43_free_plan_and_full_trial.sql split them, which is why new companies
     * used to see only the free feature set.
     *
     * Falls back to the fallback plan if no plan is flagged — a signup must
     * never fail because nobody ticked a box in the panel.
     */
    async findSignupPlan() {
        const result = await db.query(
            `SELECT * FROM plans
             WHERE is_signup_default = TRUE AND deleted_at IS NULL
             LIMIT 1`
        );
        return result.rows[0] || (await PlanModel.findFallbackPlan());
    },

    async createPlan(data) {
        const {
            code, name, description = null, tagline = null,
            price_amount = 0, price_currency = "USD", billing_period = "monthly",
            tier = 0, duration_days = null, grace_days = 3,
            is_public = true, is_active = true, sort_order = 0,
        } = data;

        const result = await db.query(
            `INSERT INTO plans (
                code, name, description, tagline,
                price_amount, price_currency, billing_period,
                tier, duration_days, grace_days,
                is_public, is_active, sort_order
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             RETURNING *`,
            [code, name, description, tagline,
             price_amount, price_currency, billing_period,
             tier, duration_days, grace_days,
             is_public, is_active, sort_order]
        );
        return result.rows[0];
    },

    async updatePlan(id, data) {
        // Whitelisted so a stray body field can never rewrite id/code/timestamps.
        const ALLOWED = [
            "name", "description", "tagline",
            "price_amount", "price_currency", "billing_period",
            "tier", "duration_days", "grace_days",
            "is_public", "is_active", "sort_order",
        ];

        const updates = [];
        const values = [];
        let i = 1;

        for (const [key, value] of Object.entries(data)) {
            if (!ALLOWED.includes(key)) continue;
            updates.push(`${key} = $${i++}`);
            values.push(value);
        }

        if (updates.length === 0) return this.findPlanById(id);

        values.push(id);
        const result = await db.query(
            `UPDATE plans SET ${updates.join(", ")}
             WHERE id = $${i} AND deleted_at IS NULL
             RETURNING *`,
            values
        );
        return result.rows[0];
    },

    async softDeletePlan(id) {
        const result = await db.query(
            `UPDATE plans SET deleted_at = NOW(), is_active = FALSE
             WHERE id = $1 AND deleted_at IS NULL
             RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    /** How many live companies sit on this plan — a delete guard. */
    async countCompaniesOnPlan(plan_id) {
        const result = await db.query(
            `SELECT COUNT(*)::int AS n FROM companies
             WHERE plan_id = $1 AND deleted_at IS NULL`,
            [plan_id]
        );
        return result.rows[0].n;
    },

    /** Unredeemed coupons pointing at this plan — the other delete guard. */
    async countActiveCouponsForPlan(plan_id) {
        const result = await db.query(
            `SELECT COUNT(*)::int AS n FROM plan_coupons
             WHERE plan_id = $1 AND status = 'active'`,
            [plan_id]
        );
        return result.rows[0].n;
    },

    // ── The grid ──────────────────────────────────────────────────────────────

    /**
     * Full catalog LEFT JOINed to one plan's values. Features the plan has no
     * row for come back with NULLs — that is what the Super Admin grid renders
     * as an unticked box, and what the resolver treats as denied.
     */
    async getPlanGrid(plan_id) {
        const result = await db.query(
            `SELECT
                pf.key, pf.category, pf.label, pf.description,
                pf.value_type, pf.is_enforceable, pf.is_visible, pf.sort_order,
                v.bool_value, v.limit_value, v.is_unlimited, v.json_value, v.note,
                (v.plan_id IS NOT NULL) AS is_configured
             FROM plan_features pf
             LEFT JOIN plan_feature_values v
                    ON v.feature_key = pf.key AND v.plan_id = $1
             ORDER BY pf.sort_order ASC, pf.key ASC`,
            [plan_id]
        );
        return result.rows;
    },

    /** The grid for every plan at once — powers the pricing page. */
    async getGridForPlans(plan_ids) {
        const result = await db.query(
            `SELECT
                v.plan_id,
                pf.key, pf.category, pf.label, pf.value_type,
                pf.is_visible, pf.sort_order,
                v.bool_value, v.limit_value, v.is_unlimited, v.json_value, v.note
             FROM plan_feature_values v
             JOIN plan_features pf ON pf.key = v.feature_key
             WHERE v.plan_id = ANY($1::uuid[])
             ORDER BY pf.sort_order ASC`,
            [plan_ids]
        );
        return result.rows;
    },

    /**
     * Replaces one cell of the grid.
     *
     * Every write is a full upsert of all four value columns so switching a
     * feature's value_type can never leave a stale limit_value shadowing a new
     * bool_value.
     */
    async upsertPlanFeatureValue(plan_id, feature_key, values) {
        const {
            bool_value = null, limit_value = null,
            is_unlimited = false, json_value = null, note = null,
        } = values;

        const result = await db.query(
            `INSERT INTO plan_feature_values (
                plan_id, feature_key, bool_value, limit_value,
                is_unlimited, json_value, note
             ) VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (plan_id, feature_key) DO UPDATE SET
                bool_value   = EXCLUDED.bool_value,
                limit_value  = EXCLUDED.limit_value,
                is_unlimited = EXCLUDED.is_unlimited,
                json_value   = EXCLUDED.json_value,
                note         = EXCLUDED.note
             RETURNING *`,
            [plan_id, feature_key, bool_value, limit_value,
             is_unlimited, json_value, note]
        );
        return result.rows[0];
    },

    /** Bulk grid save — the whole panel screen submits in one transaction. */
    async replacePlanGrid(plan_id, cells) {
        const client = await db.getClient();
        try {
            await client.query("BEGIN");

            for (const cell of cells) {
                await client.query(
                    `INSERT INTO plan_feature_values (
                        plan_id, feature_key, bool_value, limit_value,
                        is_unlimited, json_value, note
                     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
                     ON CONFLICT (plan_id, feature_key) DO UPDATE SET
                        bool_value   = EXCLUDED.bool_value,
                        limit_value  = EXCLUDED.limit_value,
                        is_unlimited = EXCLUDED.is_unlimited,
                        json_value   = EXCLUDED.json_value,
                        note         = EXCLUDED.note`,
                    [
                        plan_id,
                        cell.feature_key,
                        cell.bool_value ?? null,
                        cell.limit_value ?? null,
                        cell.is_unlimited ?? false,
                        cell.json_value ?? null,
                        cell.note ?? null,
                    ]
                );
            }

            await client.query("COMMIT");
            return this.getPlanGrid(plan_id);
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    },

    async deletePlanFeatureValue(plan_id, feature_key) {
        const result = await db.query(
            `DELETE FROM plan_feature_values
             WHERE plan_id = $1 AND feature_key = $2
             RETURNING *`,
            [plan_id, feature_key]
        );
        return result.rows[0];
    },
};

module.exports = PlanModel;
