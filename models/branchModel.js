const db = require("../config/database");

const Branch = {
    async create(data) {
        const {
            company_id,
            branch_name,
            branch_code,
            manager_name = null,
            is_head_office = false,
            country = null,
            state = null,
            city = null,
            address = null,
            phone = null,
            email = null,
            latitude = null,
            longitude = null,
            attendance_radius = 100,
        } = data;

        const result = await db.query(
            `INSERT INTO branches (
                company_id, branch_name, branch_code, manager_name, is_head_office,
                country, state, city, address, phone, email,
                latitude, longitude, attendance_radius
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
            [
                company_id, branch_name, branch_code, manager_name, is_head_office,
                country, state, city, address, phone, email,
                latitude, longitude, attendance_radius,
            ]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT * FROM branches WHERE id = $1 AND deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    },

    async findByCode(company_id, branch_code) {
        const result = await db.query(
            `SELECT * FROM branches
             WHERE company_id = $1 AND branch_code = $2 AND deleted_at IS NULL`,
            [company_id, branch_code]
        );
        return result.rows[0];
    },

    async findAllByCompany(company_id) {
        const result = await db.query(
            `SELECT * FROM branches
             WHERE company_id = $1 AND deleted_at IS NULL
             ORDER BY is_head_office DESC, branch_name ASC`,
            [company_id]
        );
        return result.rows;
    },

    // Used by attendance service — fetch branch geofence data
    async findGeofence(id) {
        const result = await db.query(
            `SELECT id, branch_name, latitude, longitude, attendance_radius
             FROM branches
             WHERE id = $1 AND is_active = true AND deleted_at IS NULL`,
            [id]
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
        const query = `UPDATE branches SET ${updates.join(", ")}
                       WHERE id = $${paramCount} AND deleted_at IS NULL
                       RETURNING *`;

        const result = await db.query(query, values);
        return result.rows[0];
    },

    async deactivate(id) {
        const result = await db.query(
            `UPDATE branches SET is_active = false WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    async delete(id) {
        const result = await db.query(
            `UPDATE branches SET deleted_at = NOW() WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },
};

module.exports = Branch;