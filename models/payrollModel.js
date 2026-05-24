const db = require("../config/database");

const Payroll = {

    async create(data) {
        const {
            company_id,
            payroll_period_id,
            employee_id,
            branch_id = null,
            basic_salary = 0,
            gross_salary = 0,
            total_working_days = 0,
            total_present_days = 0,
            total_absent_days = 0,
            total_paid_leave_days = 0,
            total_unpaid_leave_days = 0,
            total_holidays = 0,
            overtime_hours = 0,
            overtime_amount = 0,
            bonus_amount = 0,
            deduction_amount = 0,
            base_deduction_amount = 0,
            base_bonus_amount = 0,
            tax_amount = 0,
            net_salary = 0,
            payroll_status = "draft",
            paid_at = null,
            remarks = null,
        } = data;

        const result = await db.query(
            `INSERT INTO payrolls (
            company_id, payroll_period_id, employee_id, branch_id,
            basic_salary, gross_salary,
            total_working_days, total_present_days, total_absent_days,
            total_paid_leave_days, total_unpaid_leave_days, total_holidays,
            overtime_hours, overtime_amount,
            bonus_amount, deduction_amount, base_deduction_amount, base_bonus_amount,
            tax_amount, net_salary,
            payroll_status, paid_at, remarks
        ) VALUES (
            $1,  $2,  $3,  $4,
            $5,  $6,
            $7,  $8,  $9,
            $10, $11, $12,
            $13, $14,
            $15, $16, $17, $18,
            $19, $20,
            $21, $22, $23
        ) RETURNING *`,
            [
                company_id, payroll_period_id, employee_id, branch_id,
                basic_salary, gross_salary,
                total_working_days, total_present_days, total_absent_days,
                total_paid_leave_days, total_unpaid_leave_days, total_holidays,
                overtime_hours, overtime_amount,
                bonus_amount, deduction_amount, base_deduction_amount, base_bonus_amount,
                tax_amount, net_salary,
                payroll_status, paid_at, remarks,
            ]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT
                p.*,
                e.first_name       AS employee_first_name,
                e.last_name        AS employee_last_name,
                e.employee_code    AS employee_code,
                pp.period_name     AS period_name,
                pp.start_date      AS period_start_date,
                pp.end_date        AS period_end_date,
                b.branch_name      AS branch_name
             FROM payrolls p
             LEFT JOIN employees e
                ON p.employee_id = e.id
             LEFT JOIN payroll_periods pp
                ON p.payroll_period_id = pp.id
             LEFT JOIN branches b
                ON p.branch_id = b.id
             WHERE p.id = $1`,
            [id]
        );
        return result.rows[0];
    },

    async findByEmployeeAndPeriod(employee_id, payroll_period_id) {
        const result = await db.query(
            `SELECT * FROM payrolls
             WHERE employee_id = $1 AND payroll_period_id = $2`,
            [employee_id, payroll_period_id]
        );
        return result.rows[0];
    },

    async getAllByCompany(company_id) {
        const result = await db.query(
            `SELECT
                p.*,
                e.first_name    AS employee_first_name,
                e.last_name     AS employee_last_name,
                e.employee_code AS employee_code,
                pp.period_name  AS period_name
             FROM payrolls p
             LEFT JOIN employees e  ON p.employee_id = e.id
             LEFT JOIN payroll_periods pp ON p.payroll_period_id = pp.id
             WHERE p.company_id = $1
             ORDER BY p.created_at DESC`,
            [company_id]
        );
        return result.rows;
    },

    async getAllByPeriod(company_id, payroll_period_id) {
        const result = await db.query(
            `SELECT
                p.*,
                e.first_name    AS employee_first_name,
                e.last_name     AS employee_last_name,
                e.employee_code AS employee_code
             FROM payrolls p
             LEFT JOIN employees e ON p.employee_id = e.id
             WHERE p.company_id = $1 AND p.payroll_period_id = $2
             ORDER BY e.first_name ASC`,
            [company_id, payroll_period_id]
        );
        return result.rows;
    },

    async getAllByEmployee(employee_id) {
        const result = await db.query(
            `SELECT
                p.*,
                pp.period_name AS period_name,
                pp.start_date  AS period_start_date,
                pp.end_date    AS period_end_date
             FROM payrolls p
             LEFT JOIN payroll_periods pp ON p.payroll_period_id = pp.id
             WHERE p.employee_id = $1
             ORDER BY p.created_at DESC`,
            [employee_id]
        );
        return result.rows;
    },

    async getAllByBranch(company_id, branch_id) {
        const result = await db.query(
            `SELECT
                p.*,
                e.first_name    AS employee_first_name,
                e.last_name     AS employee_last_name,
                e.employee_code AS employee_code,
                pp.period_name  AS period_name
             FROM payrolls p
             LEFT JOIN employees e ON p.employee_id = e.id
             LEFT JOIN payroll_periods pp ON p.payroll_period_id = pp.id
             WHERE p.company_id = $1 AND p.branch_id = $2
             ORDER BY p.created_at DESC`,
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
        const query = `UPDATE payrolls SET ${updates.join(", ")}
                       WHERE id = $${paramCount}
                       RETURNING *`;

        const result = await db.query(query, values);
        return result.rows[0];
    },

    async updateStatus(id, payroll_status) {
        const result = await db.query(
            `UPDATE payrolls SET payroll_status = $1 WHERE id = $2 RETURNING *`,
            [payroll_status, id]
        );
        return result.rows[0];
    },

    async markAsPaid(id) {
        const result = await db.query(
            `UPDATE payrolls SET payroll_status = 'paid', paid_at = NOW()
             WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    async delete(id) {
        const result = await db.query(
            `DELETE FROM payrolls WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },
};

module.exports = Payroll;