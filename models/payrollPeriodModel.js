const db = require("../config/database");

/**
 * Dates as plain YYYY-MM-DD strings, and the month/year already split out.
 *
 * node-pg turns a DATE column into a JS Date at midnight in the SERVER's
 * timezone. Serialised to JSON it becomes a full ISO timestamp, and a browser
 * in a negative-offset zone renders 2026-08-01 as 31 July — a period that
 * silently starts a day early, in the module where a day is money.
 *
 * employeeModel already does this for joining_date and friends; same reasoning.
 * The `pp.` prefix is required, so queries without an alias use DATE_AS_TEXT_NP.
 */
const DATE_AS_TEXT = `
    to_char(pp.start_date, 'YYYY-MM-DD')   AS start_date,
    to_char(pp.end_date,   'YYYY-MM-DD')   AS end_date,
    EXTRACT(YEAR  FROM pp.start_date)::int AS period_year,
    EXTRACT(MONTH FROM pp.start_date)::int AS period_month
`;

const DATE_AS_TEXT_NP = DATE_AS_TEXT.replace(/pp\./g, "");

const PayrollPeriod = {

    async create(data) {
        const {
            company_id,
            period_name,
            start_date,
            end_date,
            status = "open",
            // Set by the service when a caller explicitly asks for a partial
            // range. Without persisting it, a two-day period in the table
            // cannot be told apart from an accidental one.
            is_off_cycle = false,
        } = data;

        const result = await db.query(
            `INSERT INTO payroll_periods (
                company_id,
                period_name, start_date, end_date,
                status, is_off_cycle
            ) VALUES (
                $1,
                $2, $3, $4,
                $5, $6
            ) RETURNING *, ${DATE_AS_TEXT_NP}`,
            [
                company_id,
                period_name, start_date, end_date,
                status, is_off_cycle,
            ]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT pp.*, ${DATE_AS_TEXT} FROM payroll_periods pp WHERE pp.id = $1`,
            [id]
        );
        return result.rows[0];
    },

    async findByName(company_id, period_name) {
        const result = await db.query(
            `SELECT * FROM payroll_periods
             WHERE company_id = $1 AND period_name = $2`,
            [company_id, period_name]
        );
        return result.rows[0];
    },

    async findOverlapping(company_id, start_date, end_date, excludeId = null) {
        const query = `
        SELECT id, period_name, start_date, end_date
        FROM payroll_periods
        WHERE company_id = $1
          AND start_date < $3
          AND end_date   > $2
          ${excludeId ? "AND id != $4" : ""}
        LIMIT 1
    `;

        const params = excludeId
            ? [company_id, start_date, end_date, excludeId]
            : [company_id, start_date, end_date];

        const result = await db.query(query, params);
        return result.rows[0] ?? null;
    },

    async getAllByCompany(company_id) {
        const result = await db.query(
            `SELECT
                pp.*,
                ${DATE_AS_TEXT},
                u.first_name || ' ' || u.last_name AS processed_by_name
             FROM payroll_periods pp
             LEFT JOIN users u
                ON pp.processed_by = u.id
             WHERE pp.company_id = $1
             ORDER BY pp.start_date DESC`,
            [company_id]
        );
        return result.rows;
    },

    async getAllByStatus(company_id, status) {
        const result = await db.query(
            `SELECT pp.*, ${DATE_AS_TEXT} FROM payroll_periods pp
             WHERE pp.company_id = $1 AND pp.status = $2
             ORDER BY start_date DESC`,
            [company_id, status]
        );
        return result.rows;
    },

    async getByDateRange(company_id, start_date, end_date) {
        const result = await db.query(
            `SELECT * FROM payroll_periods
             WHERE company_id = $1
               AND start_date >= $2
               AND end_date   <= $3
             ORDER BY start_date ASC`,
            [company_id, start_date, end_date]
        );
        return result.rows;
    },

    async update(id, data) {
        // Prevent updating audit/processing fields directly — use markAsProcessed()
        const PROTECTED_FIELDS = ["processed_at", "processed_by", "company_id"];
        for (const field of PROTECTED_FIELDS) {
            delete data[field];
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
        const query = `UPDATE payroll_periods SET ${updates.join(", ")}
                       WHERE id = $${paramCount}
                       RETURNING *, ${DATE_AS_TEXT_NP}`;

        const result = await db.query(query, values);
        return result.rows[0];
    },

    async updateStatus(id, status) {
        const result = await db.query(
            `UPDATE payroll_periods SET status = $1
             WHERE id = $2
             RETURNING *, ${DATE_AS_TEXT_NP}`,
            [status, id]
        );
        return result.rows[0];
    },

    async markAsProcessed(id, processed_by) {
        const result = await db.query(
            `UPDATE payroll_periods
             SET status       = 'completed',
                 processed_at = NOW(),
                 processed_by = $1
             WHERE id = $2
             RETURNING *`,
            [processed_by, id]
        );
        return result.rows[0];
    },

    async lock(id) {
        const result = await db.query(
            `UPDATE payroll_periods SET status = 'locked'
             WHERE id = $1
             RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    /**
     * What, if anything, stands in the way of deleting this period.
     *
     * The FK from payrolls is ON DELETE RESTRICT, so a period with any
     * generated payroll cannot be removed by the plain delete below — Postgres
     * throws and the constraint text ends up in front of an admin. This
     * answers the question up front, in terms the service can turn into a
     * sentence.
     */
    async getDeletionBlockers(id) {
        const result = await db.query(
            `SELECT
                (SELECT COUNT(*)::int FROM payrolls
                  WHERE payroll_period_id = $1)                                  AS total_payrolls,
                (SELECT COUNT(*)::int FROM payrolls
                  WHERE payroll_period_id = $1 AND payroll_status = 'paid')      AS paid_payrolls,
                (SELECT COUNT(*)::int FROM payslips ps
                   JOIN payrolls p ON p.id = ps.payroll_id
                  WHERE p.payroll_period_id = $1)                                AS payslips,
                (SELECT COUNT(*)::int FROM payroll_runs
                  WHERE payroll_period_id = $1)                                  AS runs`,
            [id]
        );
        return result.rows[0];
    },

    /**
     * Delete the period and everything generated under it, in one transaction.
     *
     * Only two statements are needed: payroll_adjustments, payslips and
     * payroll_daily_lines all cascade from payrolls, and payroll_runs (with
     * their events) cascade from the period. Payrolls themselves are RESTRICT,
     * which is why they have to go first and explicitly.
     *
     * The caller is responsible for refusing when money has moved — see
     * payrollPeriodService.deletePayrollPeriod.
     */
    async deleteWithPayrolls(id) {
        const client = await db.getClient();
        try {
            await client.query("BEGIN");

            const payrolls = await client.query(
                `DELETE FROM payrolls WHERE payroll_period_id = $1 RETURNING id`, [id]
            );
            const period = await client.query(
                `DELETE FROM payroll_periods WHERE id = $1 RETURNING *`, [id]
            );

            await client.query("COMMIT");

            return {
                period: period.rows[0] || null,
                deleted_payrolls: payrolls.rowCount,
            };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    },

    async delete(id) {
        const result = await db.query(
            `DELETE FROM payroll_periods WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },
};

module.exports = PayrollPeriod;