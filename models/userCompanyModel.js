const db = require("../config/database");

const UserCompany = {
    async create(data) {
        const {
            user_id,
            company_id,
            branch_id = null,
            username,
            password_hash = null,
            role = "2",
            is_invited = false,
        } = data;

        const result = await db.query(
            `INSERT INTO user_companies
                (user_id, company_id, branch_id, username, password_hash, role, is_invited)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [user_id, company_id, branch_id, username, password_hash, role, is_invited]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT * FROM user_companies WHERE id = $1 AND deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    },

    // Primary login lookup
    async findByUsername(username) {
        const result = await db.query(
            `SELECT uc.*,
                    u.first_name, u.last_name, u.email,
                    u.is_active AS user_is_active
             FROM user_companies uc
             JOIN users u ON u.id = uc.user_id
             WHERE uc.username = $1
               AND uc.is_active = true
               AND uc.deleted_at IS NULL
               AND u.deleted_at IS NULL`,
            [username]
        );
        return result.rows[0];
    },

    async findByUserAndCompany(user_id, company_id) {
        const result = await db.query(
            `SELECT * FROM user_companies
             WHERE user_id = $1 AND company_id = $2 AND deleted_at IS NULL`,
            [user_id, company_id]
        );
        return result.rows[0];
    },

    // All companies a user belongs to (for multi-company switcher)
    async findAllByUserId(user_id) {
        const result = await db.query(
            `SELECT uc.*, c.company_name, c.company_code, c.logo_url
             FROM user_companies uc
             JOIN companies c ON c.id = uc.company_id
             WHERE uc.user_id = $1
               AND uc.is_active = true
               AND uc.deleted_at IS NULL
             ORDER BY uc.created_at ASC`,
            [user_id]
        );
        return result.rows;
    },

    // All users in a company (admin panel)
    async findAllByCompanyId(company_id) {
        const result = await db.query(
            `SELECT uc.*, u.first_name, u.last_name, u.email, u.phone
             FROM user_companies uc
             JOIN users u ON u.id = uc.user_id
             WHERE uc.company_id = $1
               AND uc.is_active = true
               AND uc.deleted_at IS NULL
             ORDER BY uc.username ASC`,
            [company_id]
        );
        return result.rows;
    },

    // Used by username generator — fetches last assigned username globally
    async findLastUsername() {
        const result = await db.query(
            `SELECT username FROM user_companies
             ORDER BY username DESC
             LIMIT 1`
        );
        return result.rows[0];
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
        const query = `UPDATE user_companies SET ${updates.join(", ")}
                       WHERE id = $${paramCount} AND deleted_at IS NULL RETURNING *`;

        const result = await db.query(query, values);
        return result.rows[0];
    },

    async incrementFailedLogins(id) {
        const result = await db.query(
            `UPDATE user_companies
             SET failed_login_attempts = failed_login_attempts + 1
             WHERE id = $1 RETURNING failed_login_attempts`,
            [id]
        );
        return result.rows[0];
    },

    async lockAccount(id) {
        const result = await db.query(
            `UPDATE user_companies SET locked_at = NOW() WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    async resetFailedLogins(id) {
        const result = await db.query(
            `UPDATE user_companies
             SET failed_login_attempts = 0, locked_at = NULL
             WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    async setPassword(id, password_hash) {
        const result = await db.query(
            `UPDATE user_companies
             SET password_hash = $1,
                 invite_accepted_at = NOW(),
                 is_invited = false
             WHERE id = $2 RETURNING *`,
            [password_hash, id]
        );
        return result.rows[0];
    },

    async deactivate(id) {
        const result = await db.query(
            `UPDATE user_companies SET is_active = false WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    async delete(id) {
        const result = await db.query(
            `UPDATE user_companies SET deleted_at = NOW() WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },
};

module.exports = UserCompany;