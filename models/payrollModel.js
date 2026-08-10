const db = require("../config/database");

// Columns update() is allowed to write. The old version interpolated whatever
// keys the caller passed straight into the SQL — one stray key was enough to
// produce a syntax error, or worse.
const UPDATABLE_FIELDS = [
    "payroll_run_id", "branch_id",
    "actual_salary", "gross_salary", "per_day_salary",
    "total_working_days", "total_present_days", "total_absent_days",
    "total_paid_leave_days", "total_unpaid_leave_days", "total_holidays",
    "sandwich_days", "payable_days", "not_employed_days",
    "overtime_hours", "overtime_amount",
    "bonus_amount", "deduction_amount",
    "base_deduction_amount", "base_bonus_amount",
    "tax_amount", "net_salary",
    "payroll_status", "paid_at", "remarks",
];

const Payroll = {

    async create(data, client = db) {
        const {
            company_id,
            payroll_period_id,
            payroll_run_id = null,
            employee_id,
            branch_id = null,
            actual_salary = 0,
            gross_salary = 0,
            per_day_salary = 0,
            total_working_days = 0,
            total_present_days = 0,
            total_absent_days = 0,
            total_paid_leave_days = 0,
            total_unpaid_leave_days = 0,
            total_holidays = 0,
            sandwich_days = 0,
            payable_days = 0,
            not_employed_days = 0,
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

        const result = await client.query(
            `INSERT INTO payrolls (
            company_id, payroll_period_id, payroll_run_id, employee_id, branch_id,
            actual_salary, gross_salary, per_day_salary,
            total_working_days, total_present_days, total_absent_days,
            total_paid_leave_days, total_unpaid_leave_days, total_holidays,
            sandwich_days, payable_days, not_employed_days,
            overtime_hours, overtime_amount,
            bonus_amount, deduction_amount, base_deduction_amount, base_bonus_amount,
            tax_amount, net_salary,
            payroll_status, paid_at, remarks
        ) VALUES (
            $1,  $2,  $3,  $4,  $5,
            $6,  $7,  $8,
            $9,  $10, $11,
            $12, $13, $14,
            $15, $16, $17,
            $18, $19,
            $20, $21, $22, $23,
            $24, $25,
            $26, $27, $28
        ) RETURNING *`,
            [
                company_id, payroll_period_id, payroll_run_id, employee_id, branch_id,
                actual_salary, gross_salary, per_day_salary,
                total_working_days, total_present_days, total_absent_days,
                total_paid_leave_days, total_unpaid_leave_days, total_holidays,
                sandwich_days, payable_days, not_employed_days,
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

    async countByPeriod(payroll_period_id) {
        const result = await db.query(
            `SELECT COUNT(*) AS count FROM payrolls WHERE payroll_period_id = $1`,
            [payroll_period_id]
        );
        return parseInt(result.rows[0].count, 10);
    },

    async update(id, data, client = db) {
        const updates = [];
        const values = [];
        let paramCount = 1;

        for (const key of UPDATABLE_FIELDS) {
            if (data[key] === undefined) continue;
            updates.push(`${key} = $${paramCount}`);
            values.push(data[key]);
            paramCount++;
        }

        if (updates.length === 0) return this.findById(id);

        values.push(id);
        const query = `UPDATE payrolls SET ${updates.join(", ")}
                       WHERE id = $${paramCount}
                       RETURNING *`;

        const result = await client.query(query, values);
        return result.rows[0];
    },

    async updateStatus(id, payroll_status, client = db) {
        const result = await client.query(
            `UPDATE payrolls SET payroll_status = $1 WHERE id = $2 RETURNING *`,
            [payroll_status, id]
        );
        return result.rows[0];
    },

    async markAsPaid(id, client = db) {
        const result = await client.query(
            `UPDATE payrolls SET payroll_status = 'paid', paid_at = NOW()
             WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    /** All payrolls belonging to a run, with employee + email for payslip delivery. */
    async getAllByRun(payroll_run_id) {
        const result = await db.query(
            `SELECT
                p.*,
                e.first_name    AS employee_first_name,
                e.last_name     AS employee_last_name,
                e.employee_code AS employee_code,
                e.email         AS employee_email
             FROM payrolls p
             LEFT JOIN employees e ON p.employee_id = e.id
             WHERE p.payroll_run_id = $1
             ORDER BY e.first_name ASC`,
            [payroll_run_id]
        );
        return result.rows;
    },

    /** Status histogram for a run — powers the review screen's progress bar. */
    async countByStatusForRun(payroll_run_id) {
        const result = await db.query(
            `SELECT payroll_status, COUNT(*)::int AS count
             FROM payrolls WHERE payroll_run_id = $1
             GROUP BY payroll_status`,
            [payroll_run_id]
        );
        return result.rows.reduce((acc, r) => {
            acc[r.payroll_status] = r.count;
            return acc;
        }, {});
    },

    async attachToRun(payroll_run_id, company_id, payroll_period_id, client = db) {
        const result = await client.query(
            `UPDATE payrolls SET payroll_run_id = $1
             WHERE company_id = $2 AND payroll_period_id = $3 AND payroll_run_id IS NULL
             RETURNING id`,
            [payroll_run_id, company_id, payroll_period_id]
        );
        return result.rowCount;
    },

    async delete(id, client = db) {
        const result = await client.query(
            `DELETE FROM payrolls WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    UPDATABLE_FIELDS,
};

module.exports = Payroll;