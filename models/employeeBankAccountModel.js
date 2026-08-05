const db = require("../config/database");

const COLUMNS = [
    "work_country",
    "account_currency",
    "account_holder_name",
    "bank_name",
    "branch_name",
    "bank_address",
    "account_number",
    "account_type",
    "iban",
    "swift_bic",
    "ifsc_code",
    "routing_number",
    "sort_code",
    "bank_code",
];

const EmployeeBankAccount = {
    async create(data) {
        const {
            company_id,
            employee_id,
            extra = {},
            is_primary = true,
            is_active = true,
        } = data;

        const values = [company_id, employee_id];
        const placeholders = ["$1", "$2"];
        let p = 2;

        for (const col of COLUMNS) {
            p++;
            values.push(data[col] ?? null);
            placeholders.push(`$${p}`);
        }

        values.push(JSON.stringify(extra || {}), is_primary, is_active);

        const result = await db.query(
            `INSERT INTO employee_bank_accounts
                (company_id, employee_id, ${COLUMNS.join(", ")}, extra, is_primary, is_active)
             VALUES (${placeholders.join(", ")}, $${p + 1}, $${p + 2}, $${p + 3})
             RETURNING *`,
            values
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT * FROM employee_bank_accounts
             WHERE id = $1 AND deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    },

    /** The account salaries are paid into. */
    async findPrimaryByEmployee(employee_id) {
        const result = await db.query(
            `SELECT * FROM employee_bank_accounts
             WHERE employee_id = $1
               AND is_primary = true
               AND deleted_at IS NULL
             LIMIT 1`,
            [employee_id]
        );
        return result.rows[0];
    },

    async getAllByEmployee(employee_id) {
        const result = await db.query(
            `SELECT * FROM employee_bank_accounts
             WHERE employee_id = $1 AND deleted_at IS NULL
             ORDER BY is_primary DESC, created_at DESC`,
            [employee_id]
        );
        return result.rows;
    },

    async getAllByCompany(company_id, { work_country = null } = {}) {
        const result = await db.query(
            `SELECT eba.*,
                    e.first_name, e.last_name, e.employee_code
             FROM employee_bank_accounts eba
             JOIN employees e ON e.id = eba.employee_id
             WHERE eba.company_id = $1
               AND eba.deleted_at IS NULL
               AND ($2::text IS NULL OR eba.work_country = $2)
             ORDER BY e.first_name ASC`,
            [company_id, work_country]
        );
        return result.rows;
    },

    async update(id, data) {
        const updates = [];
        const values = [];
        let p = 1;

        for (const col of [...COLUMNS, "is_primary", "is_active"]) {
            if (data[col] !== undefined) {
                updates.push(`${col} = $${p}`);
                values.push(data[col]);
                p++;
            }
        }

        if (data.extra !== undefined) {
            updates.push(`extra = $${p}`);
            values.push(JSON.stringify(data.extra || {}));
            p++;
        }

        if (!updates.length) return this.findById(id);

        values.push(id);
        const result = await db.query(
            `UPDATE employee_bank_accounts
             SET ${updates.join(", ")}
             WHERE id = $${p} AND deleted_at IS NULL
             RETURNING *`,
            values
        );
        return result.rows[0];
    },

    /**
     * Clears the primary flag on an employee's other accounts.
     * The partial unique index allows only one primary per employee, so this
     * must run before promoting a different account.
     */
    async clearPrimary(employee_id, except_id = null) {
        const result = await db.query(
            `UPDATE employee_bank_accounts
             SET is_primary = false
             WHERE employee_id = $1
               AND is_primary = true
               AND deleted_at IS NULL
               AND ($2::uuid IS NULL OR id <> $2)
             RETURNING id`,
            [employee_id, except_id]
        );
        return result.rows;
    },

    async softDelete(id) {
        const result = await db.query(
            `UPDATE employee_bank_accounts
             SET deleted_at = NOW(), is_primary = false
             WHERE id = $1 AND deleted_at IS NULL
             RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    /** Per-country headcount — "who do we pay where". */
    async countByCountry(company_id) {
        const result = await db.query(
            `SELECT work_country, COUNT(*) AS employee_count
             FROM employee_bank_accounts
             WHERE company_id = $1 AND deleted_at IS NULL AND is_primary = true
             GROUP BY work_country
             ORDER BY employee_count DESC`,
            [company_id]
        );
        return result.rows;
    },
};

module.exports = EmployeeBankAccount;
