const db = require("../config/database");

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
            plan = "trial",
            plan_expires_at = null,
        } = data;

        const result = await db.query(
            `INSERT INTO companies (
                company_name, company_code, email, phone,
                country, timezone, currency, logo_url,
                plan, plan_expires_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [
                company_name, company_code, email, phone,
                country, timezone, currency, logo_url,
                plan, plan_expires_at,
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

        for (const [key, value] of Object.entries(data)) {
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

    async updatePlan(id, plan, plan_expires_at) {
        const result = await db.query(
            `UPDATE companies
             SET plan = $1, plan_expires_at = $2
             WHERE id = $3 RETURNING *`,
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