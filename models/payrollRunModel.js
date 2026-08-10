const db = require("../config/database");

const RUN_SELECT = `
    r.*,
    pp.period_name,
    pp.start_date::date::text AS start_date,
    pp.end_date::date::text   AS end_date,
    pp.status                 AS period_status,
    b.branch_name,
    cu.first_name || ' ' || cu.last_name AS created_by_name,
    su.first_name || ' ' || su.last_name AS submitted_by_name,
    au.first_name || ' ' || au.last_name AS approved_by_name,
    ru.first_name || ' ' || ru.last_name AS rejected_by_name,
    pu.first_name || ' ' || pu.last_name AS paid_by_name
`;

const RUN_JOINS = `
    FROM payroll_runs r
    JOIN payroll_periods pp ON r.payroll_period_id = pp.id
    LEFT JOIN branches b    ON r.branch_id    = b.id
    LEFT JOIN users cu      ON r.created_by   = cu.id
    LEFT JOIN users su      ON r.submitted_by = su.id
    LEFT JOIN users au      ON r.approved_by  = au.id
    LEFT JOIN users ru      ON r.rejected_by  = ru.id
    LEFT JOIN users pu      ON r.paid_by      = pu.id
`;

const UPDATABLE_FIELDS = [
    "current_step", "status",
    "employee_count", "total_gross", "total_deductions",
    "total_overtime", "total_bonus", "total_net",
    "generated_by", "generated_at",
    "submitted_by", "submitted_at",
    "approved_by", "approved_at",
    "rejected_by", "rejected_at", "rejection_reason",
    "paid_by", "paid_at",
    "payslips_generated_at", "payslips_sent_at",
    "completed_at", "cancelled_by", "cancelled_at",
    "notes",
];

const PayrollRun = {

    async create({ company_id, payroll_period_id, branch_id = null, run_number, created_by = null, notes = null }) {
        const result = await db.query(
            `INSERT INTO payroll_runs
                (company_id, payroll_period_id, branch_id, run_number, created_by, notes)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [company_id, payroll_period_id, branch_id, run_number, created_by, notes]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT ${RUN_SELECT} ${RUN_JOINS} WHERE r.id = $1`,
            [id]
        );
        return result.rows[0] || null;
    },

    /** The live (non-cancelled) run for a period+branch, if one exists. */
    async findActiveByPeriod(payroll_period_id, branch_id = null) {
        const result = await db.query(
            `SELECT ${RUN_SELECT} ${RUN_JOINS}
             WHERE r.payroll_period_id = $1
               AND COALESCE(r.branch_id, '00000000-0000-0000-0000-000000000000'::uuid)
                   = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
               AND r.status <> 'cancelled'
             LIMIT 1`,
            [payroll_period_id, branch_id]
        );
        return result.rows[0] || null;
    },

    /**
     * Runs the user can still pick up — this is what powers
     * "continue where you left off".
     */
    async getResumable(company_id, branch_id = null) {
        const params = [company_id];
        let branchClause = "";
        if (branch_id) {
            params.push(branch_id);
            branchClause = `AND (r.branch_id = $2 OR r.branch_id IS NULL)`;
        }
        const result = await db.query(
            `SELECT ${RUN_SELECT} ${RUN_JOINS}
             WHERE r.company_id = $1
               AND r.status NOT IN ('completed', 'cancelled')
               ${branchClause}
             ORDER BY pp.start_date DESC`,
            params
        );
        return result.rows;
    },

    async getAllByCompany(company_id, { status = null, limit = 50, offset = 0 } = {}) {
        const params = [company_id];
        let statusClause = "";
        if (status) {
            params.push(status);
            statusClause = `AND r.status = $${params.length}`;
        }
        params.push(limit, offset);
        const result = await db.query(
            `SELECT ${RUN_SELECT} ${RUN_JOINS}
             WHERE r.company_id = $1 ${statusClause}
             ORDER BY r.created_at DESC
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );
        return result.rows;
    },

    /** Runs waiting on a checker — the approval queue. */
    async getPendingApproval(company_id) {
        const result = await db.query(
            `SELECT ${RUN_SELECT} ${RUN_JOINS}
             WHERE r.company_id = $1 AND r.status = 'pending_approval'
             ORDER BY r.submitted_at ASC`,
            [company_id]
        );
        return result.rows;
    },

    async update(id, data, client = db) {
        const updates = [];
        const values = [];
        let i = 1;

        for (const field of UPDATABLE_FIELDS) {
            if (data[field] === undefined) continue;
            updates.push(`${field} = $${i++}`);
            values.push(data[field]);
        }
        if (updates.length === 0) return this.findById(id);

        values.push(id);
        const result = await client.query(
            `UPDATE payroll_runs SET ${updates.join(", ")} WHERE id = $${i} RETURNING *`,
            values
        );
        return result.rows[0];
    },

    /**
     * Recomputes the header totals straight from the payroll rows so the
     * run summary can never disagree with the employee list beneath it.
     */
    async refreshTotals(id, client = db) {
        const result = await client.query(
            `UPDATE payroll_runs r
             SET employee_count   = t.cnt,
                 total_gross      = t.gross,
                 total_deductions = t.deductions,
                 total_overtime   = t.overtime,
                 total_bonus      = t.bonus,
                 total_net        = t.net
             FROM (
                SELECT
                    COUNT(*)                          AS cnt,
                    COALESCE(SUM(gross_salary), 0)    AS gross,
                    COALESCE(SUM(deduction_amount), 0) AS deductions,
                    COALESCE(SUM(overtime_amount), 0) AS overtime,
                    COALESCE(SUM(bonus_amount), 0)    AS bonus,
                    COALESCE(SUM(net_salary), 0)      AS net
                FROM payrolls
                WHERE payroll_run_id = $1
                  AND payroll_status <> 'cancelled'
             ) t
             WHERE r.id = $1
             RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    // ─── Audit trail ─────────────────────────────────────────
    async logEvent({ payroll_run_id, step = null, action, from_status = null, to_status = null,
                     actor_user_id = null, actor_role = null, notes = null, metadata = null }, client = db) {
        const result = await client.query(
            `INSERT INTO payroll_run_events
                (payroll_run_id, step, action, from_status, to_status,
                 actor_user_id, actor_role, notes, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [payroll_run_id, step, action, from_status, to_status,
                actor_user_id, actor_role, notes, metadata ? JSON.stringify(metadata) : null]
        );
        return result.rows[0];
    },

    async getEvents(payroll_run_id) {
        const result = await db.query(
            `SELECT e.*, u.first_name || ' ' || u.last_name AS actor_name, u.email AS actor_email
             FROM payroll_run_events e
             LEFT JOIN users u ON e.actor_user_id = u.id
             WHERE e.payroll_run_id = $1
             ORDER BY e.created_at ASC`,
            [payroll_run_id]
        );
        return result.rows;
    },
};

module.exports = PayrollRun;
