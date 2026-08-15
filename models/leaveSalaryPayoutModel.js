const db = require("../config/database");

/**
 * The two ways money leaves the leave-salary bucket:
 *
 *   advances     leave salary paid BEFORE annual leave starts (UAE Art. 29).
 *                A timing record — the days themselves are consumed by the
 *                approved leave request, not by this row.
 *   encashments  unused balance cashed out. These DO consume days.
 *
 * Every state change is a conditional UPDATE that names the status it expects
 * (`WHERE status = 'approved'`) and returns the row. A double-clicked "mark
 * paid" therefore updates one row and finds nothing the second time, instead of
 * both requests reading 'approved' and paying twice. Same reasoning as the
 * coupon redemption lock in planCouponModel.js — one payment, one record.
 */

const ADVANCE_SELECT = `
    a.*,
    e.first_name, e.last_name, e.employee_code, e.email,
    e.branch_id,
    b.branch_name
`;

const ENCASHMENT_SELECT = `
    en.*,
    e.first_name, e.last_name, e.employee_code, e.email,
    e.branch_id,
    b.branch_name
`;

const LeaveSalaryPayoutModel = {
    // ─────────────────────────────────────────────────────────────────────────
    // ADVANCE LEAVE SALARY
    // ─────────────────────────────────────────────────────────────────────────

    async createAdvance(data) {
        const {
            company_id, employee_id, leave_request_id = null,
            leave_from_date, leave_to_date, calendar_days,
            calculation_base, basis_amount, days_in_month, daily_rate, amount,
            payroll_month = null, notes = null, created_by = null,
        } = data;

        const result = await db.query(
            `INSERT INTO leave_salary_advances (
                company_id, employee_id, leave_request_id,
                leave_from_date, leave_to_date, calendar_days,
                calculation_base, basis_amount, days_in_month, daily_rate, amount,
                payroll_month, notes, created_by
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             RETURNING *`,
            [company_id, employee_id, leave_request_id,
             leave_from_date, leave_to_date, calendar_days,
             calculation_base, basis_amount, days_in_month, daily_rate, amount,
             payroll_month, notes, created_by]
        );
        return result.rows[0];
    },

    async findAdvanceById(id) {
        const result = await db.query(
            `SELECT ${ADVANCE_SELECT}
             FROM leave_salary_advances a
             JOIN employees e     ON e.id = a.employee_id
             LEFT JOIN branches b ON b.id = e.branch_id
             WHERE a.id = $1`,
            [id]
        );
        return result.rows[0];
    },

    /** The live advance against a leave request, if one exists. */
    async findAdvanceByLeaveRequest(leave_request_id) {
        const result = await db.query(
            `SELECT * FROM leave_salary_advances
             WHERE leave_request_id = $1 AND status <> 'cancelled'`,
            [leave_request_id]
        );
        return result.rows[0];
    },

    async listAdvances({
        company_id, employee_id = null, status = null,
        payroll_month = null, from_date = null, to_date = null,
    }) {
        const result = await db.query(
            `SELECT ${ADVANCE_SELECT}
             FROM leave_salary_advances a
             JOIN employees e     ON e.id = a.employee_id
             LEFT JOIN branches b ON b.id = e.branch_id
             WHERE a.company_id = $1
               AND ($2::uuid IS NULL OR a.employee_id = $2)
               AND ($3::text IS NULL OR a.status = $3)
               AND ($4::text IS NULL OR a.payroll_month = $4)
               AND ($5::date IS NULL OR a.leave_to_date   >= $5::date)
               AND ($6::date IS NULL OR a.leave_from_date <= $6::date)
             ORDER BY a.leave_from_date DESC, a.created_at DESC`,
            [company_id, employee_id, status, payroll_month, from_date, to_date]
        );
        return result.rows;
    },

    async approveAdvance(id, approved_by) {
        const result = await db.query(
            `UPDATE leave_salary_advances
             SET status = 'approved', approved_by = $2, approved_at = NOW()
             WHERE id = $1 AND status = 'pending'
             RETURNING *`,
            [id, approved_by]
        );
        return result.rows[0];
    },

    async markAdvancePaid(id, { payment_reference = null, payroll_month = null } = {}) {
        const result = await db.query(
            `UPDATE leave_salary_advances
             SET status = 'paid',
                 paid_at = NOW(),
                 payment_reference = COALESCE($2, payment_reference),
                 payroll_month     = COALESCE($3, payroll_month)
             WHERE id = $1 AND status = 'approved'
             RETURNING *`,
            [id, payment_reference, payroll_month]
        );
        return result.rows[0];
    },

    /** Paid advances are final — reversing one is a payroll adjustment. */
    async cancelAdvance(id, cancelled_reason) {
        const result = await db.query(
            `UPDATE leave_salary_advances
             SET status = 'cancelled', cancelled_reason = $2
             WHERE id = $1 AND status IN ('pending', 'approved')
             RETURNING *`,
            [id, cancelled_reason]
        );
        return result.rows[0];
    },

    // ─────────────────────────────────────────────────────────────────────────
    // ENCASHMENT
    // ─────────────────────────────────────────────────────────────────────────

    async createEncashment(data) {
        const {
            company_id, employee_id, separation_id = null,
            encashment_type = "in_service", effective_date, days_encashed,
            calculation_base, basis_amount, days_in_month, daily_rate, amount,
            payroll_month = null, notes = null, created_by = null,
        } = data;

        const result = await db.query(
            `INSERT INTO leave_salary_encashments (
                company_id, employee_id, separation_id,
                encashment_type, effective_date, days_encashed,
                calculation_base, basis_amount, days_in_month, daily_rate, amount,
                payroll_month, notes, created_by
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             RETURNING *`,
            [company_id, employee_id, separation_id,
             encashment_type, effective_date, days_encashed,
             calculation_base, basis_amount, days_in_month, daily_rate, amount,
             payroll_month, notes, created_by]
        );
        return result.rows[0];
    },

    async findEncashmentById(id) {
        const result = await db.query(
            `SELECT ${ENCASHMENT_SELECT}
             FROM leave_salary_encashments en
             JOIN employees e     ON e.id = en.employee_id
             LEFT JOIN branches b ON b.id = e.branch_id
             WHERE en.id = $1`,
            [id]
        );
        return result.rows[0];
    },

    async findEncashmentBySeparation(separation_id) {
        const result = await db.query(
            `SELECT * FROM leave_salary_encashments
             WHERE separation_id = $1 AND status <> 'cancelled'`,
            [separation_id]
        );
        return result.rows[0];
    },

    async listEncashments({
        company_id, employee_id = null, status = null,
        encashment_type = null, payroll_month = null,
    }) {
        const result = await db.query(
            `SELECT ${ENCASHMENT_SELECT}
             FROM leave_salary_encashments en
             JOIN employees e     ON e.id = en.employee_id
             LEFT JOIN branches b ON b.id = e.branch_id
             WHERE en.company_id = $1
               AND ($2::uuid IS NULL OR en.employee_id = $2)
               AND ($3::text IS NULL OR en.status = $3)
               AND ($4::text IS NULL OR en.encashment_type = $4)
               AND ($5::text IS NULL OR en.payroll_month = $5)
             ORDER BY en.effective_date DESC, en.created_at DESC`,
            [company_id, employee_id, status, encashment_type, payroll_month]
        );
        return result.rows;
    },

    async approveEncashment(id, approved_by) {
        const result = await db.query(
            `UPDATE leave_salary_encashments
             SET status = 'approved', approved_by = $2, approved_at = NOW()
             WHERE id = $1 AND status = 'pending'
             RETURNING *`,
            [id, approved_by]
        );
        return result.rows[0];
    },

    async markEncashmentPaid(id, { payment_reference = null, payroll_month = null } = {}) {
        const result = await db.query(
            `UPDATE leave_salary_encashments
             SET status = 'paid',
                 paid_at = NOW(),
                 payment_reference = COALESCE($2, payment_reference),
                 payroll_month     = COALESCE($3, payroll_month)
             WHERE id = $1 AND status = 'approved'
             RETURNING *`,
            [id, payment_reference, payroll_month]
        );
        return result.rows[0];
    },

    async cancelEncashment(id, cancelled_reason) {
        const result = await db.query(
            `UPDATE leave_salary_encashments
             SET status = 'cancelled', cancelled_reason = $2
             WHERE id = $1 AND status IN ('pending', 'approved')
             RETURNING *`,
            [id, cancelled_reason]
        );
        return result.rows[0];
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Company-wide totals for the summary screen
    // ─────────────────────────────────────────────────────────────────────────

    async getCompanyPayoutTotals(company_id) {
        const result = await db.query(
            `SELECT
                (SELECT COALESCE(SUM(amount), 0) FROM leave_salary_advances
                  WHERE company_id = $1 AND status = 'pending')   AS advances_pending_amount,
                (SELECT COUNT(*)::int FROM leave_salary_advances
                  WHERE company_id = $1 AND status = 'pending')   AS advances_pending_count,
                (SELECT COALESCE(SUM(amount), 0) FROM leave_salary_advances
                  WHERE company_id = $1 AND status = 'paid')      AS advances_paid_amount,
                (SELECT COALESCE(SUM(amount), 0) FROM leave_salary_encashments
                  WHERE company_id = $1 AND status = 'pending')   AS encashments_pending_amount,
                (SELECT COUNT(*)::int FROM leave_salary_encashments
                  WHERE company_id = $1 AND status = 'pending')   AS encashments_pending_count,
                (SELECT COALESCE(SUM(amount), 0) FROM leave_salary_encashments
                  WHERE company_id = $1 AND status = 'paid')      AS encashments_paid_amount`,
            [company_id]
        );

        const row = result.rows[0] ?? {};
        return {
            advances_pending_amount: Number(row.advances_pending_amount ?? 0),
            advances_pending_count: Number(row.advances_pending_count ?? 0),
            advances_paid_amount: Number(row.advances_paid_amount ?? 0),
            encashments_pending_amount: Number(row.encashments_pending_amount ?? 0),
            encashments_pending_count: Number(row.encashments_pending_count ?? 0),
            encashments_paid_amount: Number(row.encashments_paid_amount ?? 0),
        };
    },
};

module.exports = LeaveSalaryPayoutModel;
