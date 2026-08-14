const LeaveSalaryService = require("../service/leaveSalaryService");

const send = (res, result, okStatus = 200, failStatus = 400) =>
    res.status(result.success ? okStatus : failStatus).json(result);

const fail = (res, error) =>
    res.status(500).json({ success: false, message: "Server error", error: error.message });

const LeaveSalaryController = {
    // ── Configuration ────────────────────────────────────────────────────────

    async getConfig(req, res) {
        try {
            return send(res, await LeaveSalaryService.getConfig(req.params.company_id));
        } catch (error) {
            return fail(res, error);
        }
    },

    async upsertConfig(req, res) {
        try {
            return send(res, await LeaveSalaryService.upsertConfig(req.params.company_id, req.body));
        } catch (error) {
            return fail(res, error);
        }
    },

    /** Flag a leave type as drawing down the bucket. */
    async setLeaveTypeCounting(req, res) {
        try {
            const result = await LeaveSalaryService.setLeaveTypeCounting(
                req.params.company_id,
                req.params.leave_type_id,
                req.body.counts_toward_leave_salary
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async upsertEmployeeConfig(req, res) {
        try {
            const result = await LeaveSalaryService.upsertEmployeeConfig(
                req.params.company_id,
                req.params.employee_id,
                req.body
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async removeEmployeeConfig(req, res) {
        try {
            const result = await LeaveSalaryService.removeEmployeeConfig(req.params.employee_id);
            return send(res, result, 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    // ── The bucket ───────────────────────────────────────────────────────────

    /** Company-wide: what every employee has collected. ?branch_id&as_of_date */
    async companySummary(req, res) {
        try {
            const result = await LeaveSalaryService.getCompanySummary(req.params.company_id, req.query);
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async getForEmployee(req, res) {
        try {
            const result = await LeaveSalaryService.getForEmployee(req.params.employee_id, req.query);
            return send(res, result, 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    /** The signed-in employee's own bucket. */
    async getMine(req, res) {
        try {
            const result = await LeaveSalaryService.getForUser(
                req.user.user_id,
                req.params.company_id
            );
            return send(res, result, 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    async getAccrualLedger(req, res) {
        try {
            const result = await LeaveSalaryService.getAccrualLedger(
                req.params.employee_id,
                { year: req.query.year ? Number(req.query.year) : null }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    /** Book every month that has completed. ?dry_run=true to inspect first. */
    async runAccrual(req, res) {
        try {
            const result = await LeaveSalaryService.runAccrual(req.params.company_id, {
                as_of_date: req.body.as_of_date ?? req.query.as_of_date ?? null,
                employee_id: req.body.employee_id ?? null,
                branch_id: req.body.branch_id ?? null,
                dry_run: req.body.dry_run === true || req.query.dry_run === "true",
                recalculate: req.body.recalculate === true,
            });
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    // ── Advances ─────────────────────────────────────────────────────────────

    async previewAdvance(req, res) {
        try {
            const result = await LeaveSalaryService.previewAdvance(req.params.company_id, req.query);
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async createAdvance(req, res) {
        try {
            const result = await LeaveSalaryService.createAdvance(
                req.params.company_id,
                req.body,
                req.user.user_id
            );
            return send(res, result, 201);
        } catch (error) {
            return fail(res, error);
        }
    },

    async listAdvances(req, res) {
        try {
            const result = await LeaveSalaryService.listAdvances(req.params.company_id, {
                employee_id: req.query.employee_id ?? null,
                status: req.query.status ?? null,
                payroll_month: req.query.payroll_month ?? null,
                from_date: req.query.from_date ?? null,
                to_date: req.query.to_date ?? null,
            });
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async approveAdvance(req, res) {
        try {
            const result = await LeaveSalaryService.approveAdvance(
                req.params.company_id, req.params.id, req.user.user_id
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async markAdvancePaid(req, res) {
        try {
            const result = await LeaveSalaryService.markAdvancePaid(
                req.params.company_id, req.params.id, req.body
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async cancelAdvance(req, res) {
        try {
            const result = await LeaveSalaryService.cancelAdvance(
                req.params.company_id, req.params.id, req.body.cancelled_reason
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    // ── Encashments ──────────────────────────────────────────────────────────

    async createEncashment(req, res) {
        try {
            const result = await LeaveSalaryService.createEncashment(
                req.params.company_id,
                req.body,
                req.user.user_id
            );
            return send(res, result, 201);
        } catch (error) {
            return fail(res, error);
        }
    },

    async listEncashments(req, res) {
        try {
            const result = await LeaveSalaryService.listEncashments(req.params.company_id, {
                employee_id: req.query.employee_id ?? null,
                status: req.query.status ?? null,
                encashment_type: req.query.encashment_type ?? null,
                payroll_month: req.query.payroll_month ?? null,
            });
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async approveEncashment(req, res) {
        try {
            const result = await LeaveSalaryService.approveEncashment(
                req.params.company_id, req.params.id, req.user.user_id
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async markEncashmentPaid(req, res) {
        try {
            const result = await LeaveSalaryService.markEncashmentPaid(
                req.params.company_id, req.params.id, req.body
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async cancelEncashment(req, res) {
        try {
            const result = await LeaveSalaryService.cancelEncashment(
                req.params.company_id, req.params.id, req.body.cancelled_reason
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    // ── Unpaid leave (indicative) ────────────────────────────────────────────

    async getUnpaidLeaveDeduction(req, res) {
        try {
            const result = await LeaveSalaryService.getUnpaidLeaveDeduction(
                req.params.company_id,
                req.params.employee_id,
                { payroll_month: req.query.payroll_month ?? null }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },
};

module.exports = LeaveSalaryController;
