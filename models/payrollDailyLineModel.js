const db = require("../config/database");

const COLUMNS = [
    "payroll_id", "work_date", "day_of_week", "day_type",
    "per_day_salary", "pay_fraction", "deduct_fraction",
    "payable_amount", "deduction_amount", "overtime_hours",
    "overtime_amount", "net_day_amount", "total_hours", "is_sandwich",
    "attendance_status", "remarks",
];

const PayrollDailyLineModel = {
    async bulkInsert(payroll_id, dailyRows, client = db) {
        if (!dailyRows.length) return [];

        const values = [];
        const placeholders = dailyRows.map((row, i) => {
            const base = i * COLUMNS.length;
            values.push(
                payroll_id, row.date, row.day_of_week, row.day_type,
                row.per_day_salary, row.pay_fraction, row.deduct_fraction,
                row.payable_amount, row.deduction_amount, row.overtime_hours,
                row.overtime_amount, row.net_day_amount, row.total_hours, row.is_sandwich,
                row.attendance_status ?? null, row.remarks ?? null
            );
            const slots = COLUMNS.map((_, c) => `$${base + c + 1}`).join(", ");
            return `(${slots})`;
        });

        const sql = `
            INSERT INTO payroll_daily_lines (${COLUMNS.join(", ")})
            VALUES ${placeholders.join(", ")}
            ON CONFLICT (payroll_id, work_date) DO UPDATE SET
                day_type = EXCLUDED.day_type,
                day_of_week = EXCLUDED.day_of_week,
                per_day_salary = EXCLUDED.per_day_salary,
                pay_fraction = EXCLUDED.pay_fraction,
                deduct_fraction = EXCLUDED.deduct_fraction,
                payable_amount = EXCLUDED.payable_amount,
                deduction_amount = EXCLUDED.deduction_amount,
                overtime_hours = EXCLUDED.overtime_hours,
                overtime_amount = EXCLUDED.overtime_amount,
                net_day_amount = EXCLUDED.net_day_amount,
                total_hours = EXCLUDED.total_hours,
                is_sandwich = EXCLUDED.is_sandwich,
                attendance_status = EXCLUDED.attendance_status,
                remarks = EXCLUDED.remarks
            RETURNING *`;

        const result = await client.query(sql, values);
        return result.rows;
    },

    async findByPayrollId(payroll_id) {
        const result = await db.query(
            // ORDER BY must be table-qualified: the aliased text column shares
            // its name with the real date column, and an unqualified ORDER BY
            // is ambiguous to Postgres.
            `SELECT *, work_date::date::text AS work_date
             FROM payroll_daily_lines
             WHERE payroll_id = $1
             ORDER BY payroll_daily_lines.work_date ASC`,
            [payroll_id]
        );
        return result.rows;
    },

    /** Day-by-day lines for every employee in a run, keyed by payroll_id. */
    async findByRunId(payroll_run_id) {
        const result = await db.query(
            `SELECT l.*, l.work_date::date::text AS work_date
             FROM payroll_daily_lines l
             JOIN payrolls p ON l.payroll_id = p.id
             WHERE p.payroll_run_id = $1
             ORDER BY l.payroll_id, l.work_date ASC`,
            [payroll_run_id]
        );
        return result.rows.reduce((acc, row) => {
            (acc[row.payroll_id] = acc[row.payroll_id] || []).push(row);
            return acc;
        }, {});
    },

    async deleteByPayrollId(payroll_id, client = db) {
        await client.query(`DELETE FROM payroll_daily_lines WHERE payroll_id = $1`, [payroll_id]);
    },
};

module.exports = PayrollDailyLineModel;
