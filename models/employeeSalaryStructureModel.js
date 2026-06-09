const db = require("../config/database");

const EmployeeSalaryStructure = {

    async create(data) {
        const {
            company_id,
            employee_id,
            effective_from,
            effective_to = null,
            actual_salary = 0,
            basic_salary = 0,          // ← add this
            housing_allowance = 0,
            transport_allowance = 0,
            other_allowance = 0,
            overtime_enabled = false,
            overtime_rate_per_hour = null,
            payment_type = "monthly",
            is_active = true,
        } = data;

        const result = await db.query(
            `INSERT INTO employee_salary_structures (
            company_id, employee_id,
            effective_from, effective_to,
            actual_salary, basic_salary,       
            housing_allowance, transport_allowance, other_allowance,
            overtime_enabled, overtime_rate_per_hour,
            payment_type, is_active
        ) VALUES (
            $1,  $2,
            $3,  $4,
            $5,  $6,                             
            $7,  $8,  $9,
            $10, $11,
            $12, $13
        ) RETURNING *`,
            [
                company_id, employee_id,
                effective_from, effective_to,
                actual_salary, basic_salary,
                housing_allowance, transport_allowance, other_allowance,
                overtime_enabled, overtime_rate_per_hour,
                payment_type, is_active,
            ]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT
                ess.*,
                e.first_name        AS employee_first_name,
                e.last_name         AS employee_last_name,
                e.employee_code     AS employee_code
             FROM employee_salary_structures ess
             LEFT JOIN employees e ON ess.employee_id = e.id
             WHERE ess.id = $1`,
            [id]
        );
        return result.rows[0];
    },

    /**
     * Get the currently active salary structure for an employee.
     * "Active" means is_active = true and effective_from <= today
     * and (effective_to IS NULL or effective_to >= today).
     */
    async findActiveByEmployee(employee_id) {
        const result = await db.query(
            `SELECT * FROM employee_salary_structures
             WHERE employee_id = $1
               AND is_active = true
               AND effective_from <= CURRENT_DATE
               AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
             ORDER BY effective_from DESC
             LIMIT 1`,
            [employee_id]
        );
        return result.rows[0];
    },

    /**
     * Get all salary structures for an employee (full history).
     */
    async getAllByEmployee(employee_id) {
        const result = await db.query(
            `SELECT * FROM employee_salary_structures
             WHERE employee_id = $1
             ORDER BY effective_from DESC`,
            [employee_id]
        );
        return result.rows;
    },

    /**
     * Get all salary structures for a company.
     */
    async getAllByCompany(company_id) {
        const result = await db.query(
            `SELECT
                ess.*,
                e.first_name    AS employee_first_name,
                e.last_name     AS employee_last_name,
                e.employee_code AS employee_code
             FROM employee_salary_structures ess
             LEFT JOIN employees e ON ess.employee_id = e.id
             WHERE ess.company_id = $1
             ORDER BY ess.effective_from DESC`,
            [company_id]
        );
        return result.rows;
    },

    async update(id, data) {
        const updates = [];
        const values = [];
        let paramCount = 1;

        // Coerce overtime_enabled to boolean if present
        if ("overtime_enabled" in data && typeof data.overtime_enabled !== "boolean") {
            data.overtime_enabled = Boolean(data.overtime_enabled);
        }

        // Coerce is_active to boolean if present
        if ("is_active" in data && typeof data.is_active !== "boolean") {
            data.is_active = Boolean(data.is_active);
        }

        for (const [key, value] of Object.entries(data)) {
            updates.push(`${key} = $${paramCount}`);
            values.push(value);
            paramCount++;
        }

        values.push(id);
        const query = `UPDATE employee_salary_structures
                       SET ${updates.join(", ")}
                       WHERE id = $${paramCount}
                       RETURNING *`;

        const result = await db.query(query, values);
        return result.rows[0];
    },

    /**
     * Deactivate a salary structure (soft disable without deleting).
     */
    async deactivate(id) {
        const result = await db.query(
            `UPDATE employee_salary_structures
             SET is_active = false
             WHERE id = $1
             RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    /**
     * Deactivate all currently active structures for an employee.
     * Useful before inserting a new structure to avoid overlaps.
     */
    async deactivateAllByEmployee(employee_id) {
        const result = await db.query(
            `UPDATE employee_salary_structures
             SET is_active = false
             WHERE employee_id = $1
               AND is_active = true
             RETURNING *`,
            [employee_id]
        );
        return result.rows;
    },

    async delete(id) {
        const result = await db.query(
            `DELETE FROM employee_salary_structures
             WHERE id = $1
             RETURNING *`,
            [id]
        );
        return result.rows[0];
    },
};

module.exports = EmployeeSalaryStructure;