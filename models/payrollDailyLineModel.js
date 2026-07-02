const db = require("../config/database");

const PayrollDailyLineModel = {
    async bulkInsert(payroll_id, dailyRows) {
        if (!dailyRows.length) return [];

        const values = [];
        const placeholders = dailyRows.map((row, i) => {
            const base = i * 14;
            values.push(
                payroll_id, row.date, row.day_of_week, row.day_type,
                row.per_day_salary, row.pay_fraction, row.deduct_fraction,
                row.payable_amount, row.deduction_amount, row.overtime_hours,
                row.overtime_amount, row.net_day_amount, row.total_hours, row.is_sandwich
            );
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14})`;
        });

        // NOTE: corrected column count below — see insertSql builder
        const sql = `
            INSERT INTO payroll_daily_lines
                (payroll_id, work_date, day_of_week, day_type,
                 per_day_salary, pay_fraction, deduct_fraction,
                 payable_amount, deduction_amount, overtime_hours,
                 overtime_amount, net_day_amount, total_hours, is_sandwich)
            VALUES ${placeholders.join(", ")}
            ON CONFLICT (payroll_id, work_date) DO UPDATE SET
                day_type = EXCLUDED.day_type,
                per_day_salary = EXCLUDED.per_day_salary,
                pay_fraction = EXCLUDED.pay_fraction,
                deduct_fraction = EXCLUDED.deduct_fraction,
                payable_amount = EXCLUDED.payable_amount,
                deduction_amount = EXCLUDED.deduction_amount,
                overtime_hours = EXCLUDED.overtime_hours,
                overtime_amount = EXCLUDED.overtime_amount,
                net_day_amount = EXCLUDED.net_day_amount,
                total_hours = EXCLUDED.total_hours,
                is_sandwich = EXCLUDED.is_sandwich
            RETURNING *`;

        const result = await db.query(sql, values);
        return result.rows;
    },

    async findByPayrollId(payroll_id) {
        const result = await db.query(
            `SELECT * FROM payroll_daily_lines WHERE payroll_id = $1 ORDER BY work_date ASC`,
            [payroll_id]
        );
        return result.rows;
    },

    async deleteByPayrollId(payroll_id) {
        await db.query(`DELETE FROM payroll_daily_lines WHERE payroll_id = $1`, [payroll_id]);
    },
};

module.exports = PayrollDailyLineModel;