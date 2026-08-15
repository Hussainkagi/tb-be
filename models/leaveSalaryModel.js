const db = require("../config/database");

/**
 * Leave-salary configuration and the accrual ledger.
 *
 * The balance is never stored. Every read assembles it from four independent
 * facts — opening balance, accrued ledger, approved annual leave taken, days
 * encashed — so the bucket cannot drift away from the leave module or from the
 * payout records. See database/migration/35_leave_salary.sql for why.
 *
 * Payouts (advances, encashments) live in leaveSalaryPayoutModel.js.
 */

const COMPANY_CONFIG_COLUMNS = [
    "opening_balance_cutoff_date",
    "days_in_month",
    "annual_entitlement_days",
    "accrual_rate_full",
    "accrual_rate_partial",
    "min_service_months",
    "full_service_months",
    "default_calculation_base",
    "max_balance_days",
    "advance_payment_enabled",
    "encashment_enabled",
    "notes",
];

const EMPLOYEE_CONFIG_COLUMNS = [
    "is_enabled",
    "calculation_base",
    "custom_basis_amount",
    "accrual_start_date",
    "opening_balance_days",
    "opening_balance_as_of",
    "notes",
];

// Everything the calculation needs for one employee in a single round trip:
// joining date, the active salary structure, and both config layers.
const CALCULATION_INPUT_SELECT = `
    e.id                    AS employee_id,
    e.company_id,
    e.branch_id,
    e.first_name, e.last_name, e.employee_code, e.email,
    e.status                AS employee_status,
    e.is_active,
    to_char(e.joining_date, 'YYYY-MM-DD')            AS joining_date,
    b.branch_name,
    d.department_name,
    c.currency              AS company_currency,
    ess.id                  AS salary_structure_id,
    ess.basic_salary,
    ess.actual_salary,
    ess.salary_currency,
    lc.id                   AS employee_config_id,
    lc.is_enabled,
    lc.calculation_base     AS employee_calculation_base,
    lc.custom_basis_amount,
    to_char(lc.accrual_start_date, 'YYYY-MM-DD')     AS config_accrual_start_date,
    lc.opening_balance_days,
    to_char(lc.opening_balance_as_of, 'YYYY-MM-DD')  AS opening_balance_as_of,
    lc.notes                AS employee_config_notes
`;

const CALCULATION_INPUT_JOINS = `
    FROM employees e
    JOIN companies c        ON c.id = e.company_id
    LEFT JOIN branches b    ON b.id = e.branch_id
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN employee_salary_structures ess
           ON ess.employee_id = e.id AND ess.is_active = TRUE
    LEFT JOIN employee_leave_salary_configs lc
           ON lc.employee_id = e.id AND lc.deleted_at IS NULL
`;

const LeaveSalaryModel = {
    // ── Company configuration ────────────────────────────────────────────────

    async getCompanyConfig(company_id) {
        const result = await db.query(
            `SELECT * FROM leave_salary_configs
             WHERE company_id = $1 AND deleted_at IS NULL`,
            [company_id]
        );
        return result.rows[0];
    },

    async upsertCompanyConfig(company_id, data) {
        const values = [company_id];
        const placeholders = ["$1"];
        let p = 1;

        for (const col of COMPANY_CONFIG_COLUMNS) {
            p++;
            values.push(data[col] ?? null);
            placeholders.push(`$${p}`);
        }

        const updateSet = COMPANY_CONFIG_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(", ");

        const result = await db.query(
            `INSERT INTO leave_salary_configs (company_id, ${COMPANY_CONFIG_COLUMNS.join(", ")})
             VALUES (${placeholders.join(", ")})
             ON CONFLICT (company_id) DO UPDATE
                SET ${updateSet}, deleted_at = NULL
             RETURNING *`,
            values
        );
        return result.rows[0];
    },

    // ── Per-employee configuration ───────────────────────────────────────────

    async getEmployeeConfig(employee_id) {
        const result = await db.query(
            `SELECT * FROM employee_leave_salary_configs
             WHERE employee_id = $1 AND deleted_at IS NULL`,
            [employee_id]
        );
        return result.rows[0];
    },

    async upsertEmployeeConfig(company_id, employee_id, data) {
        const values = [company_id, employee_id];
        const placeholders = ["$1", "$2"];
        let p = 2;

        for (const col of EMPLOYEE_CONFIG_COLUMNS) {
            p++;
            values.push(data[col] ?? null);
            placeholders.push(`$${p}`);
        }

        const updateSet = EMPLOYEE_CONFIG_COLUMNS.map((c) => `${c} = EXCLUDED.${c}`).join(", ");

        const result = await db.query(
            `INSERT INTO employee_leave_salary_configs
                (company_id, employee_id, ${EMPLOYEE_CONFIG_COLUMNS.join(", ")})
             VALUES (${placeholders.join(", ")})
             ON CONFLICT (employee_id) DO UPDATE
                SET ${updateSet}, deleted_at = NULL
             RETURNING *`,
            values
        );
        return result.rows[0];
    },

    /**
     * Import opening balances for many employees at once, and clear the accrual
     * they supersede — in one transaction.
     *
     * The purge is the part that cannot be left out. An opening balance says
     * "as of this date the employee held N days"; any ledger row for a month
     * ending on or before that date is now counted twice, once in the imported
     * figure and once in the ledger. Importing without clearing them silently
     * inflates every balance, and the error only surfaces when somebody leaves
     * and is overpaid.
     *
     * @param {Array} entries  [{ employee_id, opening_balance_days,
     *                            opening_balance_as_of, calculation_base?,
     *                            accrual_start_date? }]
     */
    async bulkSetOpeningBalances(company_id, entries = []) {
        if (!entries.length) return { updated: [], accruals_removed: 0 };

        const client = await db.getClient();
        try {
            await client.query("BEGIN");

            const updated = [];

            for (const e of entries) {
                const result = await client.query(
                    `INSERT INTO employee_leave_salary_configs
                        (company_id, employee_id, opening_balance_days, opening_balance_as_of,
                         calculation_base, accrual_start_date, is_enabled)
                     VALUES ($1, $2, $3, $4, $5, $6, TRUE)
                     ON CONFLICT (employee_id) DO UPDATE SET
                        opening_balance_days  = EXCLUDED.opening_balance_days,
                        opening_balance_as_of = EXCLUDED.opening_balance_as_of,
                        -- Only overwrite these when the import supplied them;
                        -- an import of balances must not silently reset a base
                        -- somebody configured deliberately.
                        calculation_base   = COALESCE(EXCLUDED.calculation_base,
                                                      employee_leave_salary_configs.calculation_base),
                        accrual_start_date = COALESCE(EXCLUDED.accrual_start_date,
                                                      employee_leave_salary_configs.accrual_start_date),
                        deleted_at = NULL
                     RETURNING *`,
                    [company_id, e.employee_id, e.opening_balance_days, e.opening_balance_as_of,
                     e.calculation_base ?? null, e.accrual_start_date ?? null]
                );
                updated.push(result.rows[0]);
            }

            const purge = await client.query(
                `DELETE FROM leave_salary_accruals a
                 USING employee_leave_salary_configs c
                 WHERE a.employee_id = c.employee_id
                   AND a.employee_id = ANY($1::uuid[])
                   AND c.opening_balance_as_of IS NOT NULL
                   AND a.period_end_date <= c.opening_balance_as_of`,
                [entries.map((e) => e.employee_id)]
            );

            await client.query("COMMIT");
            return { updated, accruals_removed: purge.rowCount };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    },

    /** How many ledger rows an import would clear. Powers the dry run. */
    async countAccrualsOnOrBefore(employee_ids = [], cutoff_date) {
        if (!employee_ids.length || !cutoff_date) return 0;

        const result = await db.query(
            `SELECT COUNT(*)::int AS count
             FROM leave_salary_accruals
             WHERE employee_id = ANY($1::uuid[]) AND period_end_date <= $2::date`,
            [employee_ids, cutoff_date]
        );
        return result.rows[0]?.count ?? 0;
    },

    /** Resolve a spreadsheet's employee codes to ids, within one company. */
    async findEmployeeIdsByCodes(company_id, codes = []) {
        if (!codes.length) return [];

        const result = await db.query(
            `SELECT id, employee_code, first_name, last_name, status
             FROM employees
             WHERE company_id = $1
               AND employee_code = ANY($2::text[])
               AND deleted_at IS NULL`,
            [company_id, codes]
        );
        return result.rows;
    },

    /**
     * Every employee alongside their opening balance and whether accrual has
     * already been booked — the grid the import screen is filled in from.
     */
    async getOpeningBalanceSheet(company_id, { branch_id = null } = {}) {
        const result = await db.query(
            `SELECT
                e.id                AS employee_id,
                e.employee_code,
                e.first_name, e.last_name,
                e.status            AS employee_status,
                to_char(e.joining_date, 'YYYY-MM-DD')            AS joining_date,
                b.branch_name,
                d.department_name,
                COALESCE(lc.opening_balance_days, 0)             AS opening_balance_days,
                to_char(lc.opening_balance_as_of, 'YYYY-MM-DD')  AS opening_balance_as_of,
                lc.calculation_base,
                to_char(lc.accrual_start_date, 'YYYY-MM-DD')     AS accrual_start_date,
                lc.is_enabled,
                COALESCE(acc.months_booked, 0)                   AS months_booked,
                to_char(acc.first_period, 'YYYY-MM-DD')          AS first_accrued_period
             FROM employees e
             LEFT JOIN branches b    ON b.id = e.branch_id
             LEFT JOIN departments d ON d.id = e.department_id
             LEFT JOIN employee_leave_salary_configs lc
                    ON lc.employee_id = e.id AND lc.deleted_at IS NULL
             LEFT JOIN (
                SELECT employee_id,
                       COUNT(*)::int      AS months_booked,
                       MIN(period_end_date) AS first_period
                FROM leave_salary_accruals
                GROUP BY employee_id
             ) acc ON acc.employee_id = e.id
             WHERE e.company_id = $1
               AND e.deleted_at IS NULL
               AND e.is_active = TRUE
               AND ($2::uuid IS NULL OR e.branch_id = $2)
             ORDER BY e.employee_code NULLS LAST, e.first_name`,
            [company_id, branch_id]
        );
        return result.rows;
    },

    async softDeleteEmployeeConfig(employee_id) {
        const result = await db.query(
            `UPDATE employee_leave_salary_configs
             SET deleted_at = NOW()
             WHERE employee_id = $1 AND deleted_at IS NULL
             RETURNING *`,
            [employee_id]
        );
        return result.rows[0];
    },

    // ── Calculation inputs ───────────────────────────────────────────────────

    async getCalculationInputs(employee_id) {
        const result = await db.query(
            `SELECT ${CALCULATION_INPUT_SELECT}
             ${CALCULATION_INPUT_JOINS}
             WHERE e.id = $1 AND e.deleted_at IS NULL`,
            [employee_id]
        );
        return result.rows[0];
    },

    /**
     * Same shape, for a whole company.
     *
     * include_separated pulls in employees who have already left — off by
     * default for the liability summary (they hold no balance any more), on for
     * a settlement lookup, where the employee is exactly the one who left.
     */
    async getCalculationInputsByCompany(
        company_id,
        { branch_id = null, employee_ids = null, include_separated = false } = {}
    ) {
        const result = await db.query(
            `SELECT ${CALCULATION_INPUT_SELECT}
             ${CALCULATION_INPUT_JOINS}
             WHERE e.company_id = $1
               AND e.deleted_at IS NULL
               AND ($2::uuid IS NULL OR e.branch_id = $2)
               AND ($3::uuid[] IS NULL OR e.id = ANY($3::uuid[]))
               AND ($4::boolean IS TRUE OR (e.is_active = TRUE AND e.status = 'active'))
             ORDER BY e.first_name ASC, e.last_name ASC`,
            [company_id, branch_id, employee_ids, include_separated]
        );
        return result.rows;
    },

    // ── The accrual ledger ───────────────────────────────────────────────────

    /**
     * Book (or re-book) a batch of monthly accrual rows.
     *
     * ON CONFLICT DO UPDATE makes the accrual run idempotent: running it twice
     * for the same month corrects the row rather than adding the days again.
     * That matters because the run is the kind of endpoint an admin clicks
     * twice when it feels slow.
     */
    async upsertAccruals(company_id, employee_id, rows = []) {
        if (!rows.length) return [];

        const columns = [
            "company_id", "employee_id",
            "period_year", "period_month", "period_end_date",
            "service_months", "accrual_rate", "accrued_days", "catch_up_days", "is_deferred",
            "calculation_base", "basis_amount", "days_in_month", "daily_rate", "accrued_amount",
            "note",
        ];

        const values = [];
        const tuples = [];
        let p = 0;

        for (const row of rows) {
            const tuple = [];
            for (const col of columns) {
                p++;
                if (col === "company_id") values.push(company_id);
                else if (col === "employee_id") values.push(employee_id);
                else values.push(row[col] ?? null);
                tuple.push(`$${p}`);
            }
            tuples.push(`(${tuple.join(", ")})`);
        }

        const updateSet = columns
            .filter((c) => !["company_id", "employee_id", "period_year", "period_month"].includes(c))
            .map((c) => `${c} = EXCLUDED.${c}`)
            .join(", ");

        const result = await db.query(
            `INSERT INTO leave_salary_accruals (${columns.join(", ")})
             VALUES ${tuples.join(", ")}
             ON CONFLICT (employee_id, period_year, period_month) DO UPDATE
                SET ${updateSet}
             RETURNING *`,
            values
        );
        return result.rows;
    },

    async getAccruals(employee_id, { year = null, limit = null } = {}) {
        const result = await db.query(
            `SELECT * FROM leave_salary_accruals
             WHERE employee_id = $1
               AND ($2::int IS NULL OR period_year = $2)
             ORDER BY period_end_date DESC
             LIMIT $3::int`,
            [employee_id, year, limit]
        );
        return result.rows;
    },

    /** The last month already booked — where the next run picks up. */
    async getLastAccrualDate(employee_id) {
        const result = await db.query(
            `SELECT to_char(MAX(period_end_date), 'YYYY-MM-DD') AS last_period_end
             FROM leave_salary_accruals
             WHERE employee_id = $1`,
            [employee_id]
        );
        return result.rows[0]?.last_period_end ?? null;
    },

    // ── Balance components ───────────────────────────────────────────────────
    //
    // Each returns a map keyed by employee_id, so a company-wide summary costs
    // three queries in total rather than three per employee.

    async getAccrualTotals(employee_ids = [], as_of_date = null) {
        if (!employee_ids.length) return {};

        const result = await db.query(
            `SELECT employee_id,
                    COALESCE(SUM(accrued_days), 0)   AS accrued_days,
                    COALESCE(SUM(accrued_amount), 0) AS booked_value,
                    MAX(period_end_date)             AS last_period_end
             FROM leave_salary_accruals
             WHERE employee_id = ANY($1::uuid[])
               AND ($2::date IS NULL OR period_end_date <= $2::date)
             GROUP BY employee_id`,
            [employee_ids, as_of_date]
        );

        return result.rows.reduce((acc, r) => {
            acc[r.employee_id] = {
                accrued_days: Number(r.accrued_days),
                booked_value: Number(r.booked_value),
                last_period_end: r.last_period_end,
            };
            return acc;
        }, {});
    },

    /**
     * Approved annual leave already taken.
     *
     * Only leave types flagged counts_toward_leave_salary draw the bucket down —
     * sick and unpaid leave must not, or someone returning from sick leave would
     * silently lose annual-leave days.
     */
    async getTakenDays(employee_ids = [], as_of_date = null) {
        if (!employee_ids.length) return {};

        const result = await db.query(
            `SELECT lr.employee_id,
                    COALESCE(SUM(lr.total_days), 0) AS taken_days
             FROM leave_requests lr
             JOIN leave_types lt ON lt.id = lr.leave_type_id
             WHERE lr.employee_id = ANY($1::uuid[])
               AND lr.status = 'approved'
               AND lr.deleted_at IS NULL
               AND lt.counts_toward_leave_salary = TRUE
               AND ($2::date IS NULL OR lr.from_date <= $2::date)
             GROUP BY lr.employee_id`,
            [employee_ids, as_of_date]
        );

        return result.rows.reduce((acc, r) => {
            acc[r.employee_id] = Number(r.taken_days);
            return acc;
        }, {});
    },

    /**
     * Days already committed to a payout.
     *
     * Counts pending encashments as well as paid ones. A pending payout has to
     * hold its days, otherwise two encashments raised in the same afternoon
     * would each see the full balance and together overdraw it.
     */
    async getEncashedDays(employee_ids = [], as_of_date = null) {
        if (!employee_ids.length) return {};

        const result = await db.query(
            `SELECT employee_id,
                    COALESCE(SUM(days_encashed), 0) AS encashed_days,
                    COALESCE(SUM(amount), 0)        AS encashed_value
             FROM leave_salary_encashments
             WHERE employee_id = ANY($1::uuid[])
               AND status <> 'cancelled'
               AND ($2::date IS NULL OR effective_date <= $2::date)
             GROUP BY employee_id`,
            [employee_ids, as_of_date]
        );

        return result.rows.reduce((acc, r) => {
            acc[r.employee_id] = {
                encashed_days: Number(r.encashed_days),
                encashed_value: Number(r.encashed_value),
            };
            return acc;
        }, {});
    },

    /** Approved unpaid-leave days, for the indicative deduction view. */
    async getUnpaidLeaveDays(employee_id, { from_date = null, to_date = null } = {}) {
        const result = await db.query(
            `SELECT COALESCE(SUM(lr.total_days), 0) AS unpaid_days
             FROM leave_requests lr
             JOIN leave_types lt ON lt.id = lr.leave_type_id
             WHERE lr.employee_id = $1
               AND lr.status = 'approved'
               AND lr.deleted_at IS NULL
               AND lt.is_paid = FALSE
               AND ($2::date IS NULL OR lr.to_date   >= $2::date)
               AND ($3::date IS NULL OR lr.from_date <= $3::date)`,
            [employee_id, from_date, to_date]
        );
        return Number(result.rows[0]?.unpaid_days ?? 0);
    },

    /** Leave types that draw down the bucket — surfaced so setup is checkable. */
    async getAnnualLeaveTypes(company_id) {
        const result = await db.query(
            `SELECT id, leave_name, total_days, is_paid, counts_toward_leave_salary
             FROM leave_types
             WHERE company_id = $1 AND deleted_at IS NULL AND is_active = TRUE
             ORDER BY counts_toward_leave_salary DESC, leave_name ASC`,
            [company_id]
        );
        return result.rows;
    },

    async setLeaveTypeCountsTowardLeaveSalary(company_id, leave_type_id, counts) {
        const result = await db.query(
            `UPDATE leave_types
             SET counts_toward_leave_salary = $3
             WHERE id = $2 AND company_id = $1 AND deleted_at IS NULL
             RETURNING id, leave_name, counts_toward_leave_salary`,
            [company_id, leave_type_id, counts]
        );
        return result.rows[0];
    },
};

module.exports = LeaveSalaryModel;
