const db = require("../config/database");

// Every read returns the head employee inline + how many employees sit in the
// department, so the caller can tell "headless but empty" (fine) apart from
// "headless with employees" (must be fixed).
const DEPARTMENT_SELECT = `
    SELECT
        d.*,
        h.first_name    AS head_first_name,
        h.last_name     AS head_last_name,
        h.email         AS head_email,
        h.employee_code AS head_employee_code,
        (
            SELECT COUNT(*)::int FROM employees e
            WHERE e.department_id = d.id AND e.deleted_at IS NULL
        ) AS employee_count
    FROM departments d
    LEFT JOIN employees h
        ON h.id = d.head_employee_id
       AND h.deleted_at IS NULL
`;

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
            `${DEPARTMENT_SELECT} WHERE d.id = $1 AND d.deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    },

    async findByName(company_id, branch_id, department_name) {
        const result = await db.query(
            `${DEPARTMENT_SELECT}
             WHERE d.company_id = $1 AND d.branch_id = $2
               AND d.department_name = $3 AND d.deleted_at IS NULL`,
            [company_id, branch_id, department_name]
        );
        return result.rows[0];
    },

    async findAllByCompany(company_id) {
        const result = await db.query(
            `${DEPARTMENT_SELECT}
             WHERE d.company_id = $1 AND d.deleted_at IS NULL
             ORDER BY d.department_name ASC`,
            [company_id]
        );
        return result.rows;
    },

    async findAllByBranch(company_id, branch_id) {
        const result = await db.query(
            `${DEPARTMENT_SELECT}
             WHERE d.company_id = $1 AND d.branch_id = $2 AND d.deleted_at IS NULL
             ORDER BY d.department_name ASC`,
            [company_id, branch_id]
        );
        return result.rows;
    },

    // ── HEAD OF DEPARTMENT ────────────────────────────────────────────────
    async setHead(department_id, employee_id) {
        const result = await db.query(
            `UPDATE departments SET head_employee_id = $1
             WHERE id = $2 AND deleted_at IS NULL
             RETURNING *`,
            [employee_id, department_id]
        );
        return result.rows[0];
    },

    async clearHead(department_id) {
        return this.setHead(department_id, null);
    },

    // Used when an employee leaves / is deleted / changes department:
    // whatever department they were heading loses its head.
    async clearHeadByEmployee(employee_id) {
        const result = await db.query(
            `UPDATE departments SET head_employee_id = NULL
             WHERE head_employee_id = $1
             RETURNING *`,
            [employee_id]
        );
        return result.rows;
    },

    async findByHeadEmployee(employee_id) {
        const result = await db.query(
            `SELECT * FROM departments
             WHERE head_employee_id = $1 AND deleted_at IS NULL`,
            [employee_id]
        );
        return result.rows[0];
    },

    // Departments that HAVE employees but NO head — the rule violations.
    async findHeadlessWithEmployees(company_id) {
        const result = await db.query(
            `${DEPARTMENT_SELECT}
             WHERE d.company_id = $1
               AND d.deleted_at IS NULL
               AND d.head_employee_id IS NULL
               AND EXISTS (
                   SELECT 1 FROM employees e
                   WHERE e.department_id = d.id AND e.deleted_at IS NULL
               )
             ORDER BY d.department_name ASC`,
            [company_id]
        );
        return result.rows;
    },

    async countEmployees(department_id) {
        const result = await db.query(
            `SELECT COUNT(*)::int AS count FROM employees
             WHERE department_id = $1 AND deleted_at IS NULL`,
            [department_id]
        );
        return result.rows[0].count;
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