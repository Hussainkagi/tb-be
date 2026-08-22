const db = require("../config/database");
const { resolveCountryCode } = require("../utils/countryCodes");

const Company = {
    async create(data) {
        const {
            company_name,
            company_code,
            email,
            phone,
            country,
            timezone = "UTC",
            currency = "USD",
            logo_url = null,
            // No plan_id means the company resolves through the fallback, which
            // is `free` — so that is the honest default label. The signup path
            // overrides both with the trial plan (see userCompanyService).
            plan = "free",
            plan_id = null,
            plan_expires_at = null,
            country_code = null,
        } = data;

        // `country` is free text ("UAE", "United Arab Emirates", "uae"), which
        // is fine for display but useless for matching. The normalised alpha-2
        // code is derived once here so every caller gets it — country-scoped
        // Terms & Conditions resolve against this column, and a company created
        // without it would silently receive the global policy.
        const normalisedCode = country_code || resolveCountryCode(country);

        const result = await db.query(
            `INSERT INTO companies (
                company_name, company_code, email, phone,
                country, country_code, timezone, currency, logo_url,
                plan, plan_id, plan_expires_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
            [
                company_name, company_code, email, phone,
                country, normalisedCode, timezone, currency, logo_url,
                plan, plan_id, plan_expires_at,
            ]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT * FROM companies WHERE id = $1 AND deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    },

    async findByCode(company_code) {
        const result = await db.query(
            `SELECT * FROM companies WHERE company_code = $1 AND deleted_at IS NULL`,
            [company_code]
        );
        return result.rows[0];
    },

    async findByEmail(email) {
        const result = await db.query(
            `SELECT * FROM companies WHERE email = $1 AND deleted_at IS NULL`,
            [email]
        );
        return result.rows[0];
    },

    async getAll() {
        const result = await db.query(
            `SELECT * FROM companies WHERE deleted_at IS NULL ORDER BY created_at DESC`
        );
        return result.rows;
    },

    async update(id, data) {
        const updates = [];
        const values = [];
        let paramCount = 1;

        // Moving a company to another country must move the policies it is
        // shown with it. Re-deriving the code here keeps the two columns from
        // drifting when a caller edits only the free-text `country`.
        const payload =
            data.country !== undefined && data.country_code === undefined
                ? { ...data, country_code: resolveCountryCode(data.country) }
                : data;

        for (const [key, value] of Object.entries(payload)) {
            updates.push(`${key} = $${paramCount}`);
            values.push(value);
            paramCount++;
        }

        values.push(id);
        const query = `UPDATE companies SET ${updates.join(", ")}
                       WHERE id = $${paramCount}
                         AND deleted_at IS NULL
                       RETURNING *`;

        const result = await db.query(query, values);
        return result.rows[0];
    },

    // Keeps plan_id (the gating column) and plan (the legacy label) in step.
    // Writing only the text column would leave entitlements resolving against
    // the OLD plan — the upgrade would appear to work and change nothing.
    async updatePlan(id, plan, plan_expires_at) {
        const result = await db.query(
            `UPDATE companies c
             SET plan = $1::VARCHAR,
                 plan_expires_at = $2,
                 plan_id = COALESCE(
                     (SELECT p.id FROM plans p
                       WHERE p.code = $1::VARCHAR AND p.deleted_at IS NULL),
                     c.plan_id
                 )
             WHERE c.id = $3 RETURNING *`,
            [plan, plan_expires_at, id]
        );
        return result.rows[0];
    },

    async deactivate(id) {
        const result = await db.query(
            `UPDATE companies SET is_active = false WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    // Soft delete
    async delete(id) {
        const result = await db.query(
            `UPDATE companies SET deleted_at = NOW() WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },
};

module.exports = Company;