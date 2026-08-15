const db = require("../config/database");

/**
 * DATE columns, re-projected as plain 'YYYY-MM-DD' strings.
 *
 * node-pg hands a DATE back as a JS Date built at the SERVER's local midnight,
 * which serializes to JSON as the previous evening in UTC — 14 August on a
 * GMT+4 box becomes "2026-08-13T20:00:00.000Z". Every consumer then has to know
 * to parse-and-localise rather than slice, and the ones that slice are a day
 * early on joining dates, birthdays and exit dates.
 *
 * Selected AFTER `e.*` so these win over the raw columns (Postgres allows the
 * duplicate name; node-pg keeps the last). Done this way rather than by listing
 * every column explicitly, because the employees table grows by migration —
 * exit_date itself arrived in 30_payroll_run.sql — and an explicit list would
 * silently start dropping new columns.
 */
const DATE_COLUMNS_AS_TEXT = `
    to_char(e.joining_date,   'YYYY-MM-DD') AS joining_date,
    to_char(e.date_of_birth,  'YYYY-MM-DD') AS date_of_birth,
    to_char(e.exit_date,      'YYYY-MM-DD') AS exit_date
`;

/**
 * Employment-state filter for the list endpoints.
 *
 *   active  → currently employed
 *   former  → left or stood down (resigned, terminated, inactive)
 *   all     → everything (the default, so existing callers are unaffected)
 *
 * `active` deliberately tests BOTH flags. `is_active` alone cannot distinguish
 * a resigned employee from a terminated one, and `status` alone misses someone
 * deactivated without a separation case.
 */
const STATE_CLAUSE = `
    AND (
        $STATE::text IS NULL OR $STATE = 'all'
        OR ($STATE = 'active' AND e.is_active = TRUE  AND e.status = 'active')
        OR ($STATE = 'former' AND (e.is_active = FALSE OR e.status <> 'active'))
    )
`;

/** Bind STATE_CLAUSE to a parameter number. */
const stateClause = (n) => STATE_CLAUSE.replace(/\$STATE/g, `$${n}`);

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
                ${DATE_COLUMNS_AS_TEXT},
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
            `SELECT e.*, ${DATE_COLUMNS_AS_TEXT}
             FROM employees e
             WHERE e.company_id = $1 AND e.employee_code = $2 AND e.deleted_at IS NULL`,
            [company_id, employee_code]
        );
        return result.rows[0];
    },

    async findByUserId(user_id) {
        const result = await db.query(
            `SELECT
                e.*,
                ${DATE_COLUMNS_AS_TEXT},
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
            `SELECT e.*, ${DATE_COLUMNS_AS_TEXT}
             FROM employees e
             WHERE e.user_id = $1 AND e.company_id = $2 AND e.deleted_at IS NULL`,
            [user_id, company_id]
        );
        return result.rows[0];
    },

    /**
     * @param {object} [filters]
     * @param {string} [filters.state]   active | former | all  (default all)
     * @param {string} [filters.status]  exact employees.status match
     *
     * Leavers are RETURNED BY DEFAULT and always have been — their records,
     * payroll history and documents have to stay reachable. Filtering is the
     * caller's choice, never the default.
     */
    async getAllByCompany(company_id, { state = null, status = null } = {}) {
        const result = await db.query(
            `SELECT
                e.*,
                ${DATE_COLUMNS_AS_TEXT},
                s.shift_name      AS shift_name,
                d.department_name AS department_name
             FROM employees e
             LEFT JOIN shifts s ON e.shift_id = s.id
             LEFT JOIN departments d ON e.department_id = d.id
             WHERE e.company_id = $1
               AND e.deleted_at IS NULL
               AND ($3::text IS NULL OR e.status = $3)
               ${stateClause(2)}
             ORDER BY e.created_at DESC`,
            [company_id, state, status]
        );
        return result.rows;
    },

    async getAllByBranch(company_id, branch_id, { state = null, status = null } = {}) {
        const result = await db.query(
            `SELECT
                e.*,
                ${DATE_COLUMNS_AS_TEXT},
                s.shift_name      AS shift_name,
                d.department_name AS department_name
             FROM employees e
             LEFT JOIN shifts s ON e.shift_id = s.id
             LEFT JOIN departments d ON e.department_id = d.id
             WHERE e.company_id = $1
               AND e.branch_id = $2
               AND e.deleted_at IS NULL
               AND ($4::text IS NULL OR e.status = $4)
               ${stateClause(3)}
             ORDER BY e.created_at DESC`,
            [company_id, branch_id, state, status]
        );
        return result.rows;
    },

    async getAllByDepartment(company_id, department_id, { state = null, status = null } = {}) {
        const result = await db.query(
            `SELECT
                e.*,
                ${DATE_COLUMNS_AS_TEXT},
                s.shift_name      AS shift_name,
                d.department_name AS department_name
             FROM employees e
             LEFT JOIN shifts s ON e.shift_id = s.id
             LEFT JOIN departments d ON e.department_id = d.id
             WHERE e.company_id = $1
               AND e.department_id = $2
               AND e.deleted_at IS NULL
               AND ($4::text IS NULL OR e.status = $4)
               ${stateClause(3)}
             ORDER BY e.created_at DESC`,
            [company_id, department_id, state, status]
        );
        return result.rows;
    },

    /** Headcount by state — powers the filter chips' counts in one round trip. */
    async countsByState(company_id) {
        const result = await db.query(
            `SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE is_active = TRUE  AND status = 'active')::int  AS active,
                COUNT(*) FILTER (WHERE is_active = FALSE OR  status <> 'active')::int AS former,
                COUNT(*) FILTER (WHERE status = 'resigned')::int   AS resigned,
                COUNT(*) FILTER (WHERE status = 'terminated')::int AS terminated
             FROM employees
             WHERE company_id = $1 AND deleted_at IS NULL`,
            [company_id]
        );
        return result.rows[0];
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