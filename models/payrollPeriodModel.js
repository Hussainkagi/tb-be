const db = require("../config/database");

const PayrollPeriod = {

    async create(data) {
        const {
            company_id,
            period_name,
            start_date,
            end_date,
            status = "open",
        } = data;

        const result = await db.query(
            `INSERT INTO payroll_periods (
                company_id,
                period_name, start_date, end_date,
                status
            ) VALUES (
                $1,
                $2, $3, $4,
                $5
            ) RETURNING *`,
            [
                company_id,
                period_name, start_date, end_date,
                status,
            ]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT
                pp.*,
                u.first_name || ' ' || u.last_name AS processed_by_name
             FROM payroll_periods pp
             LEFT JOIN users u
                ON pp.processed_by = u.id
             WHERE pp.id = $1`,
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
            `SELECT * FROM payroll_periods
             WHERE company_id = $1 AND status = $2
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
                       RETURNING *`;

        const result = await db.query(query, values);
        return result.rows[0];
    },

    async updateStatus(id, status) {
        const result = await db.query(
            `UPDATE payroll_periods SET status = $1
             WHERE id = $2
             RETURNING *`,
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

    async delete(id) {
        const result = await db.query(
            `DELETE FROM payroll_periods WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },
};

module.exports = PayrollPeriod;