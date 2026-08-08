const db = require("../config/database");

const COLUMNS = [
    "is_enabled",
    "rule_country",
    "calculation_basis",
    "custom_basis_amount",
    "service_start_date",
    "min_service_years",
    "days_in_month",
    "tiers",
    "max_years_cap",
    "max_amount_cap",
    "year_rounding",
    "prorate_partial_years",
    "exclude_unpaid_leave",
    "notes",
];

const EmployeeGratuityConfig = {
    async upsert(company_id, employee_id, data) {
        const values = [company_id, employee_id];
        const placeholders = ["$1", "$2"];
        let p = 2;

        for (const col of COLUMNS) {
            p++;
            values.push(col === "tiers" ? JSON.stringify(data.tiers ?? []) : data[col] ?? null);
            placeholders.push(`$${p}`);
        }

        const updateSet = COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(", ");

        const result = await db.query(
            `INSERT INTO employee_gratuity_configs
                (company_id, employee_id, ${COLUMNS.join(", ")})
             VALUES (${placeholders.join(", ")})
             ON CONFLICT (employee_id) DO UPDATE
                SET ${updateSet}, deleted_at = NULL
             RETURNING *`,
            values
        );
        return result.rows[0];
    },

    async findByEmployee(employee_id) {
        const result = await db.query(
            `SELECT * FROM employee_gratuity_configs
             WHERE employee_id = $1 AND deleted_at IS NULL`,
            [employee_id]
        );
        return result.rows[0];
    },

    async findAllByCompany(company_id) {
        const result = await db.query(
            `SELECT * FROM employee_gratuity_configs
             WHERE company_id = $1 AND deleted_at IS NULL`,
            [company_id]
        );
        return result.rows;
    },

    async softDelete(employee_id) {
        const result = await db.query(
            `UPDATE employee_gratuity_configs
             SET deleted_at = NOW()
             WHERE employee_id = $1 AND deleted_at IS NULL
             RETURNING *`,
            [employee_id]
        );
        return result.rows[0];
    },

    /**
     * Everything the calculation needs for one employee, in one round trip:
     * joining date, active salary basis, work country and any config override.
     */
    async getCalculationInputs(employee_id) {
        const result = await db.query(
            `SELECT
                e.id                AS employee_id,
                e.company_id,
                e.first_name, e.last_name, e.employee_code, e.status,
                to_char(e.joining_date, 'YYYY-MM-DD')   AS joining_date,
                b.branch_name,
                c.currency          AS company_currency,
                c.country           AS company_country,
                ess.id              AS salary_structure_id,
                ess.basic_salary,
                ess.actual_salary,
                ess.salary_currency,
                ess.work_country,
                to_char(gc.service_start_date, 'YYYY-MM-DD') AS config_service_start_date,
                gc.id               AS config_id,
                gc.is_enabled, gc.rule_country, gc.calculation_basis,
                gc.custom_basis_amount, gc.min_service_years, gc.days_in_month,
                gc.tiers, gc.max_years_cap, gc.max_amount_cap, gc.year_rounding,
                gc.prorate_partial_years, gc.exclude_unpaid_leave, gc.notes
             FROM employees e
             JOIN companies c ON c.id = e.company_id
             LEFT JOIN branches b ON b.id = e.branch_id
             LEFT JOIN employee_salary_structures ess
                    ON ess.employee_id = e.id AND ess.is_active = TRUE
             LEFT JOIN employee_gratuity_configs gc
                    ON gc.employee_id = e.id AND gc.deleted_at IS NULL
             WHERE e.id = $1 AND e.deleted_at IS NULL`,
            [employee_id]
        );
        return result.rows[0];
    },

    /** Same shape as getCalculationInputs, for every employee in a company. */
    async getCalculationInputsByCompany(company_id, { branch_id = null } = {}) {
        const result = await db.query(
            `SELECT
                e.id                AS employee_id,
                e.company_id,
                e.first_name, e.last_name, e.employee_code, e.status,
                to_char(e.joining_date, 'YYYY-MM-DD')   AS joining_date,
                e.branch_id,
                b.branch_name,
                c.currency          AS company_currency,
                c.country           AS company_country,
                ess.id              AS salary_structure_id,
                ess.basic_salary,
                ess.actual_salary,
                ess.salary_currency,
                ess.work_country,
                to_char(gc.service_start_date, 'YYYY-MM-DD') AS config_service_start_date,
                gc.id               AS config_id,
                gc.is_enabled, gc.rule_country, gc.calculation_basis,
                gc.custom_basis_amount, gc.min_service_years, gc.days_in_month,
                gc.tiers, gc.max_years_cap, gc.max_amount_cap, gc.year_rounding,
                gc.prorate_partial_years, gc.exclude_unpaid_leave, gc.notes
             FROM employees e
             JOIN companies c ON c.id = e.company_id
             LEFT JOIN branches b ON b.id = e.branch_id
             LEFT JOIN employee_salary_structures ess
                    ON ess.employee_id = e.id AND ess.is_active = TRUE
             LEFT JOIN employee_gratuity_configs gc
                    ON gc.employee_id = e.id AND gc.deleted_at IS NULL
             WHERE e.company_id = $1
               AND e.deleted_at IS NULL
               AND e.is_active = TRUE
               AND e.status = 'active'
               AND ($2::uuid IS NULL OR e.branch_id = $2)
             ORDER BY e.first_name ASC`,
            [company_id, branch_id]
        );
        return result.rows;
    },

    /**
     * Approved unpaid-leave days per employee, counted from their service
     * start. Only needed when a rule sets exclude_unpaid_leave.
     */
    async getUnpaidLeaveDays(employee_ids = []) {
        if (!employee_ids.length) return {};

        const result = await db.query(
            `SELECT lr.employee_id, COALESCE(SUM(lr.total_days), 0) AS unpaid_days
             FROM leave_requests lr
             JOIN leave_types lt ON lt.id = lr.leave_type_id
             WHERE lr.employee_id = ANY($1::uuid[])
               AND lr.status = 'approved'
               AND lr.deleted_at IS NULL
               AND lt.is_paid = FALSE
             GROUP BY lr.employee_id`,
            [employee_ids]
        );

        return result.rows.reduce((acc, r) => {
            acc[r.employee_id] = Number(r.unpaid_days);
            return acc;
        }, {});
    },
};

module.exports = EmployeeGratuityConfig;
