const db = require("../config/database");

const Department = {
    async create(data) {
        const {
            company_id,
            branch_id,
            department_name,
        } = data;

        const result = await db.query(
            `INSERT INTO departments (
                company_id, branch_id, department_name
            ) VALUES ($1, $2, $3) RETURNING *`,
            [company_id, branch_id, department_name]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT * FROM departments WHERE id = $1 AND deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    },

    async findByName(company_id, branch_id, department_name) {
        const result = await db.query(
            `SELECT * FROM departments
             WHERE company_id = $1 AND branch_id = $2
               AND department_name = $3 AND deleted_at IS NULL`,
            [company_id, branch_id, department_name]
        );
        return result.rows[0];
    },

    async findAllByCompany(company_id) {
        const result = await db.query(
            `SELECT * FROM departments
             WHERE company_id = $1 AND deleted_at IS NULL
             ORDER BY department_name ASC`,
            [company_id]
        );
        return result.rows;
    },

    async findAllByBranch(company_id, branch_id) {
        const result = await db.query(
            `SELECT * FROM departments
             WHERE company_id = $1 AND branch_id = $2 AND deleted_at IS NULL
             ORDER BY department_name ASC`,
            [company_id, branch_id]
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
        const query = `UPDATE departments SET ${updates.join(", ")}
                       WHERE id = $${paramCount} AND deleted_at IS NULL
                       RETURNING *`;

        const result = await db.query(query, values);
        return result.rows[0];
    },

    async deactivate(id) {
        const result = await db.query(
            `UPDATE departments SET is_active = false WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    async delete(id) {
        const result = await db.query(
            `UPDATE departments SET deleted_at = NOW() WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },
};

module.exports = Department;