const db = require("../config/database");

const Payslip = {

    async create(data) {
        const {
            payroll_id,
            payslip_number,
            pdf_url = null,
        } = data;

        const result = await db.query(
            `INSERT INTO payslips (payroll_id, payslip_number, pdf_url)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [payroll_id, payslip_number, pdf_url]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT
                ps.*,
                p.employee_id       AS employee_id,
                p.payroll_period_id AS payroll_period_id,
                p.net_salary        AS net_salary,
                p.payroll_status    AS payroll_status,
                e.first_name        AS employee_first_name,
                e.last_name         AS employee_last_name,
                e.employee_code     AS employee_code,
                pp.period_name      AS period_name,
                pp.start_date       AS period_start_date,
                pp.end_date         AS period_end_date
             FROM payslips ps
             LEFT JOIN payrolls p        ON ps.payroll_id = p.id
             LEFT JOIN employees e       ON p.employee_id = e.id
             LEFT JOIN payroll_periods pp ON p.payroll_period_id = pp.id
             WHERE ps.id = $1`,
            [id]
        );
        return result.rows[0];
    },

    async findByPayrollId(payroll_id) {
        const result = await db.query(
            `SELECT * FROM payslips WHERE payroll_id = $1`,
            [payroll_id]
        );
        return result.rows[0];
    },

    async findByPayslipNumber(payslip_number) {
        const result = await db.query(
            `SELECT * FROM payslips WHERE payslip_number = $1`,
            [payslip_number]
        );
        return result.rows[0];
    },

    async getAllByEmployee(employee_id) {
        const result = await db.query(
            `SELECT
                ps.*,
                pp.period_name AS period_name,
                pp.start_date  AS period_start_date,
                pp.end_date    AS period_end_date,
                p.net_salary   AS net_salary,
                p.payroll_status AS payroll_status
             FROM payslips ps
             LEFT JOIN payrolls p        ON ps.payroll_id = p.id
             LEFT JOIN payroll_periods pp ON p.payroll_period_id = pp.id
             WHERE p.employee_id = $1
             ORDER BY ps.generated_at DESC`,
            [employee_id]
        );
        return result.rows;
    },

    async getAllByPeriod(payroll_period_id) {
        const result = await db.query(
            `SELECT
                ps.*,
                e.first_name    AS employee_first_name,
                e.last_name     AS employee_last_name,
                e.employee_code AS employee_code,
                p.net_salary    AS net_salary
             FROM payslips ps
             LEFT JOIN payrolls p  ON ps.payroll_id = p.id
             LEFT JOIN employees e ON p.employee_id = e.id
             WHERE p.payroll_period_id = $1
             ORDER BY e.first_name ASC`,
            [payroll_period_id]
        );
        return result.rows;
    },

    async updatePdfUrl(id, pdf_url) {
        const result = await db.query(
            `UPDATE payslips SET pdf_url = $1 WHERE id = $2 RETURNING *`,
            [pdf_url, id]
        );
        return result.rows[0];
    },

    async delete(id) {
        const result = await db.query(
            `DELETE FROM payslips WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    async deleteByPayrollId(payroll_id) {
        const result = await db.query(
            `DELETE FROM payslips WHERE payroll_id = $1 RETURNING *`,
            [payroll_id]
        );
        return result.rows[0];
    },
};

module.exports = Payslip;