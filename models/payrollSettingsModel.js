const db = require("../config/database");

const ALLOWED_FIELDS = [
    "per_day_basis",
    "sandwich_enabled",
    "sandwich_applies_to",
    "sandwich_requires_full_day",
    "sandwich_max_bridge_days",
    "half_day_leave_is_payable",
    "prorate_joiners_leavers",
    "overtime_on_off_days",
    "require_approval",
    "allow_self_approval",
    "auto_email_payslips",
];

const PayrollSettings = {

    /**
     * Always returns a row. A company created before this table existed
     * (or one whose seed was missed) gets defaults inserted on first read,
     * so no caller ever has to handle a null settings object.
     */
    async getOrCreate(company_id) {
        const existing = await db.query(
            `SELECT * FROM payroll_settings WHERE company_id = $1`,
            [company_id]
        );
        if (existing.rows[0]) return existing.rows[0];

        const created = await db.query(
            `INSERT INTO payroll_settings (company_id) VALUES ($1)
             ON CONFLICT (company_id) DO UPDATE SET company_id = EXCLUDED.company_id
             RETURNING *`,
            [company_id]
        );
        return created.rows[0];
    },

    async update(company_id, data) {
        const updates = [];
        const values = [];
        let i = 1;

        for (const field of ALLOWED_FIELDS) {
            if (data[field] === undefined) continue;
            updates.push(`${field} = $${i++}`);
            values.push(data[field]);
        }

        if (updates.length === 0) return this.getOrCreate(company_id);

        values.push(company_id);
        const result = await db.query(
            `UPDATE payroll_settings SET ${updates.join(", ")}
             WHERE company_id = $${i}
             RETURNING *`,
            values
        );
        return result.rows[0];
    },

    ALLOWED_FIELDS,
};

module.exports = PayrollSettings;
