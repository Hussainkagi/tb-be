const db = require("../config/database");

/**
 * Resignation, termination and the final settlement.
 *
 * Two things here are deliberately not casual UPDATEs:
 *
 *   1. Every workflow transition names the status it expects
 *      (`WHERE status = 'pending'`). A resignation cannot be approved twice, and
 *      an approval racing a withdrawal resolves to whichever landed first
 *      instead of leaving a withdrawn case marked approved.
 *
 *   2. Completing a case writes to two tables — the case and the employee — so
 *      it runs in a transaction. An employee left active against a completed
 *      separation still shows on payroll and can still check in; the pair has
 *      to move together or not at all.
 */

const SEPARATION_SELECT = `
    s.*,
    e.first_name, e.last_name, e.employee_code, e.email,
    e.status                AS employee_status,
    to_char(e.joining_date, 'YYYY-MM-DD') AS joining_date,
    b.branch_name,
    d.department_name,
    u.first_name            AS decided_by_first_name,
    u.last_name             AS decided_by_last_name
`;

const SEPARATION_JOINS = `
    FROM employee_separations s
    JOIN employees e        ON e.id = s.employee_id
    LEFT JOIN branches b    ON b.id = s.branch_id
    LEFT JOIN departments d ON d.id = s.department_id
    LEFT JOIN users u       ON u.id = s.decided_by
`;

const EmployeeSeparationModel = {
    // ── Create ───────────────────────────────────────────────────────────────

    async create(data) {
        const {
            company_id, employee_id, branch_id = null, department_id = null,
            separation_type, reason,
            submitted_by = null,
            requested_last_working_date = null,
            notice_period_days = 30,
            notice_start_date = null,
            termination_type = null,
            is_gratuity_forfeited = false,
            forfeiture_reason = null,
            clearance_checklist = [],
        } = data;

        const result = await db.query(
            `INSERT INTO employee_separations (
                company_id, employee_id, branch_id, department_id,
                separation_type, reason, submitted_by,
                requested_last_working_date, notice_period_days, notice_start_date,
                termination_type, is_gratuity_forfeited, forfeiture_reason,
                clearance_checklist
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
             RETURNING *`,
            [company_id, employee_id, branch_id, department_id,
             separation_type, reason, submitted_by,
             requested_last_working_date, notice_period_days, notice_start_date,
             termination_type, is_gratuity_forfeited, forfeiture_reason,
             JSON.stringify(clearance_checklist ?? [])]
        );
        return result.rows[0];
    },

    // ── Read ─────────────────────────────────────────────────────────────────

    async findById(id) {
        const result = await db.query(
            `SELECT ${SEPARATION_SELECT} ${SEPARATION_JOINS}
             WHERE s.id = $1 AND s.deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    },

    /** The employee's open case, if any. Drives the one-open-case rule. */
    async findOpenByEmployee(employee_id) {
        const result = await db.query(
            `SELECT * FROM employee_separations
             WHERE employee_id = $1
               AND status IN ('pending', 'approved')
               AND deleted_at IS NULL`,
            [employee_id]
        );
        return result.rows[0];
    },

    async listByEmployee(employee_id) {
        const result = await db.query(
            `SELECT ${SEPARATION_SELECT} ${SEPARATION_JOINS}
             WHERE s.employee_id = $1 AND s.deleted_at IS NULL
             ORDER BY s.submitted_at DESC`,
            [employee_id]
        );
        return result.rows;
    },

    async listByCompany(company_id, {
        status = null, separation_type = null, branch_id = null,
        from_date = null, to_date = null,
    } = {}) {
        const result = await db.query(
            `SELECT ${SEPARATION_SELECT} ${SEPARATION_JOINS}
             WHERE s.company_id = $1
               AND s.deleted_at IS NULL
               AND ($2::text IS NULL OR s.status = $2)
               AND ($3::text IS NULL OR s.separation_type = $3)
               AND ($4::uuid IS NULL OR s.branch_id = $4)
               AND ($5::date IS NULL OR COALESCE(s.last_working_date, s.requested_last_working_date) >= $5::date)
               AND ($6::date IS NULL OR COALESCE(s.last_working_date, s.requested_last_working_date) <= $6::date)
             ORDER BY
                CASE s.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
                COALESCE(s.last_working_date, s.requested_last_working_date) ASC NULLS LAST,
                s.submitted_at DESC`,
            [company_id, status, separation_type, branch_id, from_date, to_date]
        );
        return result.rows;
    },

    /**
     * Approved cases whose last working day has passed but which nobody has
     * completed. The list that stops an ex-employee quietly staying active.
     */
    async listOverdueForCompletion(company_id, as_of_date = null) {
        const result = await db.query(
            `SELECT ${SEPARATION_SELECT} ${SEPARATION_JOINS}
             WHERE s.company_id = $1
               AND s.status = 'approved'
               AND s.deleted_at IS NULL
               AND s.last_working_date < COALESCE($2::date, CURRENT_DATE)
             ORDER BY s.last_working_date ASC`,
            [company_id, as_of_date]
        );
        return result.rows;
    },

    async countsByStatus(company_id) {
        const result = await db.query(
            `SELECT status, separation_type, COUNT(*)::int AS count
             FROM employee_separations
             WHERE company_id = $1 AND deleted_at IS NULL
             GROUP BY status, separation_type`,
            [company_id]
        );
        return result.rows;
    },

    // ── Workflow transitions ─────────────────────────────────────────────────

    async update(id, data) {
        const allowed = [
            "reason", "requested_last_working_date", "notice_period_days",
            "notice_start_date", "termination_type", "is_gratuity_forfeited",
            "forfeiture_reason", "clearance_checklist", "exit_interview_notes",
            "is_rehire_eligible",
        ];

        const sets = [];
        const values = [id];
        let p = 1;

        for (const col of allowed) {
            if (data[col] === undefined) continue;
            p++;
            if (col === "clearance_checklist") {
                sets.push(`${col} = $${p}::jsonb`);
                values.push(JSON.stringify(data[col]));
            } else {
                sets.push(`${col} = $${p}`);
                values.push(data[col]);
            }
        }

        if (!sets.length) return this.findById(id);

        // Only an undecided case is editable — after approval the dates are
        // what the settlement was built on.
        const result = await db.query(
            `UPDATE employee_separations
             SET ${sets.join(", ")}
             WHERE id = $1 AND status = 'pending' AND deleted_at IS NULL
             RETURNING *`,
            values
        );
        return result.rows[0];
    },

    /**
     * Accept the case and stamp the last working date onto the employee.
     *
     * employees.exit_date is set HERE, not at completion, because payroll reads
     * it to prorate a leaver's final month (`prorate_joiners_leavers` in
     * payroll_settings → payrollEngineService). The final payroll run almost
     * always happens while the employee is still serving notice, so waiting
     * until the case is closed would pay them a full month for a month they
     * only half worked. Cancelling the case clears it again.
     */
    async approve(id, {
        decided_by, last_working_date, notice_start_date = null,
        notice_shortfall_days = 0, is_notice_waived = false, decision_notes = null,
    }) {
        const client = await db.getClient();
        try {
            await client.query("BEGIN");

            const result = await client.query(
                `UPDATE employee_separations
                 SET status = 'approved',
                     decided_by = $2,
                     decided_at = NOW(),
                     last_working_date = $3,
                     notice_start_date = COALESCE($4, notice_start_date, CURRENT_DATE),
                     notice_shortfall_days = $5,
                     is_notice_waived = $6,
                     decision_notes = $7
                 WHERE id = $1 AND status = 'pending' AND deleted_at IS NULL
                 RETURNING *`,
                [id, decided_by, last_working_date, notice_start_date,
                 notice_shortfall_days, is_notice_waived, decision_notes]
            );

            if (!result.rows[0]) {
                await client.query("ROLLBACK");
                return null;
            }

            await client.query(
                `UPDATE employees SET exit_date = $2 WHERE id = $1`,
                [result.rows[0].employee_id, last_working_date]
            );

            await client.query("COMMIT");
            return result.rows[0];
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    },

    async reject(id, { decided_by, rejection_reason }) {
        const result = await db.query(
            `UPDATE employee_separations
             SET status = 'rejected',
                 decided_by = $2,
                 decided_at = NOW(),
                 rejection_reason = $3
             WHERE id = $1 AND status = 'pending' AND deleted_at IS NULL
             RETURNING *`,
            [id, decided_by, rejection_reason]
        );
        return result.rows[0];
    },

    /** The employee's own escape hatch — only before a decision is taken. */
    async withdraw(id, withdrawal_reason = null) {
        const result = await db.query(
            `UPDATE employee_separations
             SET status = 'withdrawn',
                 withdrawn_at = NOW(),
                 withdrawal_reason = $2
             WHERE id = $1 AND status = 'pending' AND deleted_at IS NULL
             RETURNING *`,
            [id, withdrawal_reason]
        );
        return result.rows[0];
    },

    /**
     * Revoke an approved case. The employee stays employed — which means
     * clearing the exit_date stamped at approval, or payroll would keep
     * prorating their salary to a leaving date that no longer applies.
     */
    async cancel(id, cancellation_reason) {
        const client = await db.getClient();
        try {
            await client.query("BEGIN");

            const result = await client.query(
                `UPDATE employee_separations
                 SET status = 'cancelled',
                     cancelled_at = NOW(),
                     cancellation_reason = $2
                 WHERE id = $1 AND status = 'approved' AND deleted_at IS NULL
                 RETURNING *`,
                [id, cancellation_reason]
            );

            if (!result.rows[0]) {
                await client.query("ROLLBACK");
                return null;
            }

            await client.query(
                `UPDATE employees SET exit_date = NULL WHERE id = $1`,
                [result.rows[0].employee_id]
            );

            await client.query("COMMIT");
            return result.rows[0];
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    },

    /**
     * Close the case and stand the employee down, in one transaction.
     *
     * employees.status becomes 'resigned' or 'terminated' and is_active goes
     * false — which is what removes them from payroll generation, attendance and
     * the active headcount that plan limits are counted against.
     */
    async complete(id, {
        completed_by, employee_status, exit_interview_notes = null,
        is_rehire_eligible = null, clearance_checklist = null,
    }) {
        const client = await db.getClient();
        try {
            await client.query("BEGIN");

            const separation = await client.query(
                `UPDATE employee_separations
                 SET status = 'completed',
                     completed_at = NOW(),
                     completed_by = $2,
                     exit_interview_notes = COALESCE($3, exit_interview_notes),
                     is_rehire_eligible   = COALESCE($4, is_rehire_eligible),
                     clearance_checklist  = COALESCE($5::jsonb, clearance_checklist)
                 WHERE id = $1 AND status = 'approved' AND deleted_at IS NULL
                 RETURNING *`,
                [id, completed_by, exit_interview_notes, is_rehire_eligible,
                 clearance_checklist ? JSON.stringify(clearance_checklist) : null]
            );

            if (!separation.rows[0]) {
                await client.query("ROLLBACK");
                return null;
            }

            // exit_date is normally already set at approval; COALESCE covers a
            // case completed straight from an approval that predates that.
            await client.query(
                `UPDATE employees
                 SET status = $2,
                     is_active = FALSE,
                     exit_date = COALESCE(exit_date, $3)
                 WHERE id = $1`,
                [separation.rows[0].employee_id, employee_status,
                 separation.rows[0].last_working_date]
            );

            await client.query("COMMIT");
            return separation.rows[0];
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    },

    // ── Final settlement ─────────────────────────────────────────────────────

    async findSettlementBySeparation(separation_id) {
        const result = await db.query(
            `SELECT * FROM employee_final_settlements WHERE separation_id = $1`,
            [separation_id]
        );
        return result.rows[0];
    },

    async listSettlements(company_id, { status = null, employee_id = null } = {}) {
        const result = await db.query(
            `SELECT fs.*,
                    e.first_name, e.last_name, e.employee_code,
                    s.separation_type, s.status AS separation_status
             FROM employee_final_settlements fs
             JOIN employees e            ON e.id = fs.employee_id
             JOIN employee_separations s ON s.id = fs.separation_id
             WHERE fs.company_id = $1
               AND ($2::text IS NULL OR fs.status = $2)
               AND ($3::uuid IS NULL OR fs.employee_id = $3)
             ORDER BY fs.last_working_date DESC`,
            [company_id, status, employee_id]
        );
        return result.rows;
    },

    /**
     * Write the settlement snapshot.
     *
     * ON CONFLICT DO UPDATE only while the row is still a draft: once it is
     * approved or paid the numbers are what was agreed, and a later salary
     * correction must not silently rewrite them.
     */
    async upsertSettlement(data) {
        const columns = [
            "company_id", "employee_id", "separation_id", "last_working_date",
            "calculation_base", "basis_amount", "days_in_month", "daily_rate",
            "leave_encashment_days", "leave_encashment_amount",
            "gratuity_amount", "gratuity_note",
            "pending_salary_amount", "other_earnings_amount", "other_earnings_note",
            "notice_shortfall_days", "notice_shortfall_amount",
            "advance_recovery_amount", "other_deductions_amount", "other_deductions_note",
            "total_earnings", "total_deductions", "net_settlement_amount",
            "currency", "calculation_snapshot", "notes", "created_by",
        ];

        const values = [];
        const placeholders = [];
        let p = 0;

        for (const col of columns) {
            p++;
            if (col === "calculation_snapshot") {
                values.push(JSON.stringify(data[col] ?? {}));
                placeholders.push(`$${p}::jsonb`);
            } else {
                values.push(data[col] ?? null);
                placeholders.push(`$${p}`);
            }
        }

        const updateSet = columns
            .filter((c) => !["company_id", "employee_id", "separation_id", "created_by"].includes(c))
            .map((c) => `${c} = EXCLUDED.${c}`)
            .join(", ");

        const result = await db.query(
            `INSERT INTO employee_final_settlements (${columns.join(", ")})
             VALUES (${placeholders.join(", ")})
             ON CONFLICT (separation_id) DO UPDATE
                SET ${updateSet}
                WHERE employee_final_settlements.status = 'draft'
             RETURNING *`,
            values
        );
        return result.rows[0];
    },

    async approveSettlement(id, approved_by) {
        const result = await db.query(
            `UPDATE employee_final_settlements
             SET status = 'approved', approved_by = $2, approved_at = NOW()
             WHERE id = $1 AND status = 'draft'
             RETURNING *`,
            [id, approved_by]
        );
        return result.rows[0];
    },

    async markSettlementPaid(id, { payment_reference = null } = {}) {
        const result = await db.query(
            `UPDATE employee_final_settlements
             SET status = 'paid',
                 paid_at = NOW(),
                 payment_reference = COALESCE($2, payment_reference)
             WHERE id = $1 AND status = 'approved'
             RETURNING *`,
            [id, payment_reference]
        );
        return result.rows[0];
    },

    async cancelSettlement(id, notes = null) {
        const result = await db.query(
            `UPDATE employee_final_settlements
             SET status = 'cancelled', notes = COALESCE($2, notes)
             WHERE id = $1 AND status IN ('draft', 'approved')
             RETURNING *`,
            [id, notes]
        );
        return result.rows[0];
    },
};

module.exports = EmployeeSeparationModel;
