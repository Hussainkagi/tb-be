const db = require("../config/database");

const Payslip = {

    async create(data, client = db) {
        const {
            payroll_id,
            payslip_number,
            pdf_url = null,
            payroll_run_id = null,
        } = data;

        const result = await client.query(
            `INSERT INTO payslips (payroll_id, payslip_number, pdf_url, payroll_run_id)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [payroll_id, payslip_number, pdf_url, payroll_run_id]
        );
        return result.rows[0];
    },

    /**
     * Payslips for a run, with everything the mailer needs. Filtering on
     * email_status is what makes "send" resumable — a retry picks up only
     * the ones that have not landed yet.
     */
    async getAllByRun(payroll_run_id, { statuses = null, column = "email_status" } = {}) {
        // Whitelisted: `column` selects which delivery channel to filter on
        // (email or in-app/push), and is interpolated into the SQL.
        const filterColumn = column === "notification_status" ? "notification_status" : "email_status";

        const params = [payroll_run_id];
        let statusClause = "";
        if (statuses && statuses.length) {
            params.push(statuses);
            statusClause = `AND ps.${filterColumn} = ANY($2::text[])`;
        }

        const result = await db.query(
            `SELECT
                ps.*,
                p.employee_id, p.net_salary, p.gross_salary, p.payroll_status,
                p.company_id, p.branch_id,
                p.overtime_amount, p.overtime_hours,
                p.base_deduction_amount, p.deduction_amount,
                p.bonus_amount, p.tax_amount,
                e.first_name, e.last_name, e.employee_code, e.email AS employee_email,
                pp.period_name,
                pp.start_date::date::text AS period_start_date,
                pp.end_date::date::text   AS period_end_date,
                c.company_name, c.currency
             FROM payslips ps
             JOIN payrolls p             ON ps.payroll_id = p.id
             LEFT JOIN employees e       ON p.employee_id = e.id
             LEFT JOIN payroll_periods pp ON p.payroll_period_id = pp.id
             LEFT JOIN companies c       ON p.company_id = c.id
             WHERE p.payroll_run_id = $1 ${statusClause}
             ORDER BY e.first_name ASC`,
            params
        );
        return result.rows;
    },

    async markNotified(id) {
        const result = await db.query(
            `UPDATE payslips
             SET notification_status = 'sent', notified_at = NOW(), notification_error = NULL
             WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    async markNotificationFailed(id, error_message) {
        const result = await db.query(
            `UPDATE payslips
             SET notification_status = 'failed', notification_error = $2
             WHERE id = $1 RETURNING *`,
            [id, String(error_message || "").slice(0, 1000)]
        );
        return result.rows[0];
    },

    async markEmailSent(id, sent_to_email) {
        const result = await db.query(
            `UPDATE payslips
             SET email_status = 'sent', email_sent_at = NOW(),
                 sent_to_email = $2, email_error = NULL
             WHERE id = $1 RETURNING *`,
            [id, sent_to_email]
        );
        return result.rows[0];
    },

    async markEmailFailed(id, error_message) {
        const result = await db.query(
            `UPDATE payslips
             SET email_status = 'failed', email_error = $2
             WHERE id = $1 RETURNING *`,
            [id, String(error_message || "").slice(0, 1000)]
        );
        return result.rows[0];
    },

    async markEmailSkipped(id, reason) {
        const result = await db.query(
            `UPDATE payslips
             SET email_status = 'skipped', email_error = $2
             WHERE id = $1 RETURNING *`,
            [id, String(reason || "").slice(0, 1000)]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT
                ps.*,
                p.employee_id       AS employee_id,
                p.payroll_period_id AS payroll_period_id,
                p.gross_salary      AS gross_salary,
                p.actual_salary     AS actual_salary,
                p.overtime_hours    AS overtime_hours,
                p.overtime_amount   AS overtime_amount,
                p.base_deduction_amount AS base_deduction_amount,
                p.deduction_amount  AS deduction_amount,
                p.bonus_amount      AS bonus_amount,
                p.tax_amount        AS tax_amount,
                p.net_salary        AS net_salary,
                p.total_working_days, p.total_present_days, p.total_absent_days,
                p.total_paid_leave_days, p.total_unpaid_leave_days,
                p.total_holidays, p.sandwich_days, p.payable_days,
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
            `SELECT
                ps.*,
                p.employee_id       AS employee_id,
                p.payroll_period_id AS payroll_period_id,
                p.gross_salary      AS gross_salary,
                p.actual_salary     AS actual_salary,
                p.overtime_hours    AS overtime_hours,
                p.overtime_amount   AS overtime_amount,
                p.base_deduction_amount AS base_deduction_amount,
                p.deduction_amount  AS deduction_amount,
                p.bonus_amount      AS bonus_amount,
                p.tax_amount        AS tax_amount,
                p.net_salary        AS net_salary,
                p.total_working_days, p.total_present_days, p.total_absent_days,
                p.total_paid_leave_days, p.total_unpaid_leave_days,
                p.total_holidays, p.sandwich_days, p.payable_days,
                p.payroll_status    AS payroll_status,
                e.first_name        AS employee_first_name,
                e.last_name         AS employee_last_name,
                e.employee_code     AS employee_code,
                pp.period_name      AS period_name,
                pp.start_date       AS period_start_date,
                pp.end_date         AS period_end_date,
                c.company_name       AS company_name
             FROM payslips ps
             LEFT JOIN payrolls p        ON ps.payroll_id = p.id
             LEFT JOIN employees e       ON p.employee_id = e.id
             LEFT JOIN companies c        ON p.company_id = c.id
             LEFT JOIN payroll_periods pp ON p.payroll_period_id = pp.id
             WHERE ps.payroll_id = $1`,
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