const db = require("../config/database");

const User = {
    // Find or create — core shared logic used in both registration and invite flows
    async findOrCreate(data) {
        const { first_name, last_name, email, phone } = data;

        const existing = await db.query(
            `SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL`,
            [email]
        );
        if (existing.rows[0]) {
            return { user: existing.rows[0], created: false };
        }

        const result = await db.query(
            `INSERT INTO users (first_name, last_name, email, phone)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [first_name, last_name, email, phone]
        );
        return { user: result.rows[0], created: true };
    },

    async create(data) {
        const { first_name, last_name, email, phone } = data;
        const result = await db.query(
            `INSERT INTO users (first_name, last_name, email, phone)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [first_name, last_name, email, phone]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    },

    async findByEmail(email) {
        const result = await db.query(
            `SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL`,
            [email]
        );
        return result.rows[0];
    },

    async getAll() {
        const result = await db.query(
            `SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at DESC`
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
        const query = `UPDATE users SET ${updates.join(", ")}
                       WHERE id = $${paramCount} AND deleted_at IS NULL
                       RETURNING *`;

        const result = await db.query(query, values);
        return result.rows[0];
    },

    async setRefreshToken(id, token) {
        const result = await db.query(
            `UPDATE users SET refresh_token = $1, last_login_at = NOW()
             WHERE id = $2 RETURNING *`,
            [token, id]
        );
        return result.rows[0];
    },

    async clearRefreshToken(id) {
        const result = await db.query(
            `UPDATE users SET refresh_token = NULL WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    // Soft delete
    async delete(id) {
        const result = await db.query(
            `UPDATE users SET deleted_at = NOW() WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },
};

module.exports = User;