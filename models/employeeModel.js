const db = require("../config/database");

const Employee = {

    async create(data) {
        const {
            company_id,
            branch_id = null,
            department_id = null,
            shift_id = null,
            user_id,
            employee_code,
            first_name,
            last_name,
            email,
            phone = null,
            gender = null,
            date_of_birth = null,
            address = null,
            joining_date = null,
            employment_type = null,
            employee_person_code = null,
            is_remote_job = false,
        } = data;

        const result = await db.query(
            `INSERT INTO employees (
            company_id, branch_id, department_id, shift_id, user_id,
            employee_code, first_name, last_name, email, phone,
            gender, date_of_birth, address,
            joining_date, employment_type,
            employee_person_code,              -- ✅ 2. column
            is_remote_job
        ) VALUES (
            $1,  $2,  $3,  $4,  $5,
            $6,  $7,  $8,  $9,  $10,
            $11, $12, $13,
            $14, $15,
            $16,                               -- ✅ 3. param
            $17
        ) RETURNING *`,
            [
                company_id, branch_id, department_id, shift_id, user_id,
                employee_code, first_name, last_name, email, phone,
                gender, date_of_birth, address,
                joining_date, employment_type,
                employee_person_code,
                is_remote_job,
            ]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT
                e.*,
                s.shift_name      AS shift_name,
                d.department_name AS department_name,
                uc.role           AS role
             FROM employees e
             LEFT JOIN shifts s
                ON e.shift_id = s.id
             LEFT JOIN departments d
                ON e.department_id = d.id
             LEFT JOIN user_companies uc
                ON uc.user_id = e.user_id
               AND uc.company_id = e.company_id
             WHERE e.id = $1
               AND e.deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    },

    async findByCode(company_id, employee_code) {
        const result = await db.query(
            `SELECT * FROM employees
             WHERE company_id = $1 AND employee_code = $2 AND deleted_at IS NULL`,
            [company_id, employee_code]
        );
        return result.rows[0];
    },

    async findByUserId(user_id) {
        const result = await db.query(
            `SELECT
                e.*,
                s.shift_name      AS shift_name,
                d.department_name AS department_name
             FROM employees e
             LEFT JOIN shifts s ON e.shift_id = s.id
             LEFT JOIN departments d ON e.department_id = d.id
             WHERE e.user_id = $1 AND e.deleted_at IS NULL`,
            [user_id]
        );
        return result.rows;
    },

    async findByUserAndCompany(user_id, company_id) {
        const result = await db.query(
            `SELECT * FROM employees
             WHERE user_id = $1 AND company_id = $2 AND deleted_at IS NULL`,
            [user_id, company_id]
        );
        return result.rows[0];
    },

    async getAllByCompany(company_id) {
        const result = await db.query(
            `SELECT * FROM employees
             WHERE company_id = $1 AND deleted_at IS NULL
             ORDER BY created_at DESC`,
            [company_id]
        );
        return result.rows;
    },

    async getAllByBranch(company_id, branch_id) {
        const result = await db.query(
            `SELECT
                e.*,
                s.shift_name      AS shift_name,
                d.department_name AS department_name
             FROM employees e
             LEFT JOIN shifts s ON e.shift_id = s.id
             LEFT JOIN departments d ON e.department_id = d.id
             WHERE e.company_id = $1 AND e.branch_id = $2 AND e.deleted_at IS NULL
             ORDER BY e.created_at DESC`,
            [company_id, branch_id]
        );
        return result.rows;
    },

    async getAllByDepartment(company_id, department_id) {
        const result = await db.query(
            `SELECT * FROM employees
             WHERE company_id = $1 AND department_id = $2 AND deleted_at IS NULL
             ORDER BY created_at DESC`,
            [company_id, department_id]
        );
        return result.rows;
    },

    async update(id, data) {
        // Prevent updating salary/bank fields — managed via employee_salary_structures
        const SALARY_BANK_FIELDS = [
            "actual_salary",
            "housing_allowance",
            "transport_allowance",
            "other_allowance",
            "gross_salary",
            "bank_name",
            "bank_account_number",
            "iban",
        ];
        for (const field of SALARY_BANK_FIELDS) {
            delete data[field];
        }

        // Prevent updating is_remote_job to non-boolean
        if ("is_remote_job" in data && typeof data.is_remote_job !== "boolean") {
            data.is_remote_job = Boolean(data.is_remote_job);
        }

        const updates = [];
        const values = [];
        let paramCount = 1;

        for (const [key, value] of Object.entries(data)) {
            updates.push(`${key} = $${paramCount}`);
            values.push(value);
            paramCount++;
        }

        values.push(id);
        const query = `UPDATE employees SET ${updates.join(", ")}
                       WHERE id = $${paramCount}
                         AND deleted_at IS NULL
                       RETURNING *`;

        const result = await db.query(query, values);
        return result.rows[0];
    },

    async updateStatus(id, status) {
        const result = await db.query(
            `UPDATE employees SET status = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING *`,
            [status, id]
        );
        return result.rows[0];
    },

    async deactivate(id) {
        const result = await db.query(
            `UPDATE employees SET is_active = false WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    async delete(id) {
        const result = await db.query(
            `UPDATE employees SET deleted_at = NOW() WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },
};

module.exports = Employee;