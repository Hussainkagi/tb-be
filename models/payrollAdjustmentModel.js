const db = require("../config/database");

const PayrollAdjustment = {

    async create(data) {
        const {
            payroll_id,
            adjustment_type,
            title,
            amount,
            is_taxable = false,
            remarks = null,
        } = data;

        const result = await db.query(
            `INSERT INTO payroll_adjustments (
                payroll_id, adjustment_type, title, amount, is_taxable, remarks
            ) VALUES (
                $1, $2, $3, $4, $5, $6
            ) RETURNING *`,
            [payroll_id, adjustment_type, title, amount, is_taxable, remarks]
        );
        return result.rows[0];
    },

    async createMany(payroll_id, adjustments) {
        if (!adjustments || adjustments.length === 0) return [];

        const values = [];
        const placeholders = adjustments.map((adj, i) => {
            const offset = i * 6;
            values.push(
                payroll_id,
                adj.adjustment_type,
                adj.title,
                adj.amount,
                adj.is_taxable ?? false,
                adj.remarks ?? null
            );
            return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`;
        });

        const result = await db.query(
            `INSERT INTO payroll_adjustments
                (payroll_id, adjustment_type, title, amount, is_taxable, remarks)
             VALUES ${placeholders.join(", ")}
             RETURNING *`,
            values
        );
        return result.rows;
    },

    async findById(id) {
        const result = await db.query(
            `SELECT * FROM payroll_adjustments WHERE id = $1`,
            [id]
        );
        return result.rows[0];
    },

    async getAllByPayroll(payroll_id) {
        const result = await db.query(
            `SELECT * FROM payroll_adjustments
             WHERE payroll_id = $1
             ORDER BY created_at ASC`,
            [payroll_id]
        );
        return result.rows;
    },

    /**
     * Adjustments for many payrolls in one query, keyed by payroll_id.
     * Payslip generation needs the line items for every employee in a run —
     * fetching them one payroll at a time is a query per employee.
     */
    async getAllByPayrollIds(payroll_ids) {
        if (!payroll_ids || payroll_ids.length === 0) return {};
        const result = await db.query(
            `SELECT * FROM payroll_adjustments
             WHERE payroll_id = ANY($1::uuid[])
             ORDER BY payroll_id, created_at ASC`,
            [payroll_ids]
        );
        return result.rows.reduce((acc, row) => {
            (acc[row.payroll_id] = acc[row.payroll_id] || []).push(row);
            return acc;
        }, {});
    },

    async getAllByPayrollAndType(payroll_id, adjustment_type) {
        const result = await db.query(
            `SELECT * FROM payroll_adjustments
             WHERE payroll_id = $1 AND adjustment_type = $2
             ORDER BY created_at ASC`,
            [payroll_id, adjustment_type]
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
        const query = `UPDATE payroll_adjustments SET ${updates.join(", ")}
                       WHERE id = $${paramCount}
                       RETURNING *`;

        const result = await db.query(query, values);
        return result.rows[0];
    },

    async delete(id) {
        const result = await db.query(
            `DELETE FROM payroll_adjustments WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    async deleteAllByPayroll(payroll_id) {
        const result = await db.query(
            `DELETE FROM payroll_adjustments WHERE payroll_id = $1 RETURNING *`,
            [payroll_id]
        );
        return result.rows;
    },
};

module.exports = PayrollAdjustment;