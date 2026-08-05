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
            work_country = null,        // where the employee works from
            salary_currency = null,     // snapshot of companies.currency
            bank_account_id = null,     // optional payout account
        } = data;

        const result = await db.query(
            `INSERT INTO employee_salary_structures (
            company_id, employee_id,
            effective_from, effective_to,
            actual_salary, basic_salary,
            housing_allowance, transport_allowance, other_allowance,
            overtime_enabled, overtime_rate_per_hour,
            payment_type, is_active,
            work_country, salary_currency, bank_account_id
        ) VALUES (
            $1,  $2,
            $3,  $4,
            $5,  $6,
            $7,  $8,  $9,
            $10, $11,
            $12, $13,
            $14, $15, $16
        ) RETURNING *`,
            [
                company_id, employee_id,
                effective_from, effective_to,
                actual_salary, basic_salary,
                housing_allowance, transport_allowance, other_allowance,
                overtime_enabled, overtime_rate_per_hour,
                payment_type, is_active,
                work_country, salary_currency, bank_account_id,
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
                e.employee_code     AS employee_code,
                bk.bank             AS bank_account
             FROM employee_salary_structures ess
             LEFT JOIN employees e ON ess.employee_id = e.id
             LEFT JOIN LATERAL (
                 SELECT to_jsonb(b) - 'company_id' - 'deleted_at' AS bank
                 FROM employee_bank_accounts b
                 WHERE b.id = ess.bank_account_id AND b.deleted_at IS NULL
             ) bk ON TRUE
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
            `SELECT ess.*, bk.bank AS bank_account
             FROM employee_salary_structures ess
             LEFT JOIN LATERAL (
                 SELECT to_jsonb(b) - 'company_id' - 'deleted_at' AS bank
                 FROM employee_bank_accounts b
                 WHERE b.id = ess.bank_account_id AND b.deleted_at IS NULL
             ) bk ON TRUE
             WHERE ess.employee_id = $1
               AND ess.is_active = true
               AND ess.effective_from <= CURRENT_DATE
               AND (ess.effective_to IS NULL OR ess.effective_to >= CURRENT_DATE)
             ORDER BY ess.effective_from DESC
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
            `SELECT ess.*, bk.bank AS bank_account
             FROM employee_salary_structures ess
             LEFT JOIN LATERAL (
                 SELECT to_jsonb(b) - 'company_id' - 'deleted_at' AS bank
                 FROM employee_bank_accounts b
                 WHERE b.id = ess.bank_account_id AND b.deleted_at IS NULL
             ) bk ON TRUE
             WHERE ess.employee_id = $1
             ORDER BY ess.effective_from DESC`,
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
                e.employee_code AS employee_code,
                bk.bank         AS bank_account
             FROM employee_salary_structures ess
             LEFT JOIN employees e ON ess.employee_id = e.id
             LEFT JOIN LATERAL (
                 SELECT to_jsonb(b) - 'company_id' - 'deleted_at' AS bank
                 FROM employee_bank_accounts b
                 WHERE b.id = ess.bank_account_id AND b.deleted_at IS NULL
             ) bk ON TRUE
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