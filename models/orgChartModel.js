const db = require("../config/database");

// Flat rows for the company org tree. The tree itself is assembled in the
// service — SQL only supplies the pieces:
//   admins          → top of the tree
//   branches        → second level
//   departments     → third level, each headed by an employee (or headless)
//   employees       → leaves, grouped by department
const OrgChart = {
    async findBranches(company_id, branch_id = null) {
        const params = [company_id];
        let branchFilter = "";
        if (branch_id) {
            params.push(branch_id);
            branchFilter = ` AND b.id = $${params.length}`;
        }

        const result = await db.query(
            `SELECT
                b.id,
                b.branch_name,
                b.branch_code,
                b.is_head_office,
                b.city,
                b.country,
                b.is_active
             FROM branches b
             WHERE b.company_id = $1
               AND b.deleted_at IS NULL${branchFilter}
             ORDER BY b.is_head_office DESC, b.branch_name ASC`,
            params
        );
        return result.rows;
    },

    // Employees whose user_companies role is Admin (role 0) in this company.
    async findAdmins(company_id) {
        const result = await db.query(
            `SELECT
                e.id,
                e.employee_code,
                e.first_name,
                e.last_name,
                e.email,
                e.phone,
                e.status,
                e.department_id,
                e.branch_id,
                uc.role::text::int AS role
             FROM employees e
             JOIN user_companies uc
               ON uc.user_id = e.user_id
              AND uc.company_id = e.company_id
             WHERE e.company_id = $1
               AND e.deleted_at IS NULL
               AND uc.role::text::int = 0
               AND uc.is_active = TRUE
             ORDER BY e.first_name ASC`,
            [company_id]
        );
        return result.rows;
    },

    async findDepartments(company_id, branch_id = null) {
        const params = [company_id];
        let branchFilter = "";
        if (branch_id) {
            params.push(branch_id);
            branchFilter = ` AND d.branch_id = $${params.length}`;
        }

        const result = await db.query(
            `SELECT
                d.id,
                d.department_name,
                d.branch_id,
                b.branch_name,
                d.head_employee_id,
                h.first_name    AS head_first_name,
                h.last_name     AS head_last_name,
                h.email         AS head_email,
                h.employee_code AS head_employee_code,
                h.status        AS head_status
             FROM departments d
             LEFT JOIN branches b ON b.id = d.branch_id
             LEFT JOIN employees h
                    ON h.id = d.head_employee_id
                   AND h.deleted_at IS NULL
             WHERE d.company_id = $1
               AND d.deleted_at IS NULL${branchFilter}
             ORDER BY d.department_name ASC`,
            params
        );
        return result.rows;
    },

    async findEmployees(company_id, branch_id = null) {
        const params = [company_id];
        let branchFilter = "";
        if (branch_id) {
            params.push(branch_id);
            branchFilter = ` AND e.branch_id = $${params.length}`;
        }

        const result = await db.query(
            `SELECT
                e.id,
                e.employee_code,
                e.first_name,
                e.last_name,
                e.email,
                e.phone,
                e.status,
                e.department_id,
                e.branch_id,
                uc.role::text::int AS role
             FROM employees e
             LEFT JOIN user_companies uc
                    ON uc.user_id = e.user_id
                   AND uc.company_id = e.company_id
             WHERE e.company_id = $1
               AND e.deleted_at IS NULL${branchFilter}
             ORDER BY e.first_name ASC`,
            params
        );
        return result.rows;
    },
};

module.exports = OrgChart;
