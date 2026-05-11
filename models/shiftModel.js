const db = require("../config/database");

const Shift = {
    async create(data) {
        const {
            company_id,
            branch_id,
            shift_name,
            start_time,
            end_time,
            late_grace_minutes = 0,
            half_day_hours = 0.00,
            working_hours = 8.00,
            is_night_shift = false,
        } = data;

        const result = await db.query(
            `INSERT INTO shifts (
                company_id, branch_id, shift_name,
                start_time, end_time,
                late_grace_minutes, half_day_hours, working_hours, is_night_shift
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
            [
                company_id, branch_id, shift_name,
                start_time, end_time,
                late_grace_minutes, half_day_hours, working_hours, is_night_shift,
            ]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT * FROM shifts WHERE id = $1 AND deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    },

    async findByName(company_id, branch_id, shift_name) {
        const result = await db.query(
            `SELECT * FROM shifts
             WHERE company_id = $1 AND branch_id = $2
               AND shift_name = $3 AND deleted_at IS NULL`,
            [company_id, branch_id, shift_name]
        );
        return result.rows[0];
    },

    async findAllByCompany(company_id) {
        const result = await db.query(
            `SELECT * FROM shifts
             WHERE company_id = $1 AND deleted_at IS NULL
             ORDER BY shift_name ASC`,
            [company_id]
        );
        return result.rows;
    },

    async findAllByBranch(company_id, branch_id) {
        const result = await db.query(
            `SELECT * FROM shifts
             WHERE company_id = $1 AND branch_id = $2 AND deleted_at IS NULL
             ORDER BY start_time ASC`,
            [company_id, branch_id]
        );
        return result.rows;
    },

    // Used by attendance service — fetch shift timing data
    async findTiming(id) {
        const result = await db.query(
            `SELECT id, shift_name, start_time, end_time,
                    late_grace_minutes, half_day_hours, working_hours, is_night_shift
             FROM shifts
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
        const query = `UPDATE shifts SET ${updates.join(", ")}
                       WHERE id = $${paramCount} AND deleted_at IS NULL
                       RETURNING *`;

        const result = await db.query(query, values);
        return result.rows[0];
    },

    async deactivate(id) {
        const result = await db.query(
            `UPDATE shifts SET is_active = false WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    async delete(id) {
        const result = await db.query(
            `UPDATE shifts SET deleted_at = NOW() WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },
};

module.exports = Shift;