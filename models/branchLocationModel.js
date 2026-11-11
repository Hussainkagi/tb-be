const db = require("../config/database");

const COLUMNS = `id, company_id, branch_id, location_name, address,
                 latitude, longitude, attendance_radius, is_active,
                 created_at, updated_at`;

const BranchLocationModel = {
    /** Every live site of a branch, for the admin screen. */
    async findAllByBranch(branch_id) {
        const result = await db.query(
            `SELECT ${COLUMNS} FROM branch_locations
             WHERE branch_id = $1 AND deleted_at IS NULL
             ORDER BY location_name ASC`,
            [branch_id]
        );
        return result.rows;
    },

    /** The sites check-in may use. */
    async findActiveByBranch(branch_id) {
        const result = await db.query(
            `SELECT id, location_name, latitude, longitude, attendance_radius
             FROM branch_locations
             WHERE branch_id = $1 AND is_active = TRUE AND deleted_at IS NULL
             ORDER BY location_name ASC`,
            [branch_id]
        );
        return result.rows;
    },

    async findById(id) {
        const result = await db.query(
            `SELECT ${COLUMNS} FROM branch_locations WHERE id = $1 AND deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    },

    async create({ company_id, branch_id, location_name, address = null, latitude, longitude, attendance_radius = 100, is_active = true }) {
        const result = await db.query(
            `INSERT INTO branch_locations
                (company_id, branch_id, location_name, address, latitude, longitude, attendance_radius, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING ${COLUMNS}`,
            [company_id, branch_id, location_name, address, latitude, longitude, attendance_radius, is_active]
        );
        return result.rows[0];
    },

    /** `data` must already be filtered to editable columns by the service. */
    async update(id, data) {
        const keys = Object.keys(data);
        if (keys.length === 0) return this.findById(id);
        const sets = keys.map((key, i) => `${key} = $${i + 1}`);
        const result = await db.query(
            `UPDATE branch_locations SET ${sets.join(", ")}
             WHERE id = $${keys.length + 1} AND deleted_at IS NULL
             RETURNING ${COLUMNS}`,
            [...keys.map((k) => data[k]), id]
        );
        return result.rows[0];
    },

    async softDelete(id) {
        const result = await db.query(
            `UPDATE branch_locations SET deleted_at = NOW(), is_active = FALSE
             WHERE id = $1 AND deleted_at IS NULL
             RETURNING id`,
            [id]
        );
        return result.rows[0];
    },
};

module.exports = BranchLocationModel;
