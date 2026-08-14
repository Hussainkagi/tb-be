const EmployeeSeparationService = require("../service/employeeSeparationService");

const send = (res, result, okStatus = 200, failStatus = 400) =>
    res.status(result.success ? okStatus : failStatus).json(result);

const fail = (res, error) =>
    res.status(500).json({ success: false, message: "Server error", error: error.message });

const EmployeeSeparationController = {
    // ── Submission ───────────────────────────────────────────────────────────

    /**
     * An employee resigning for themselves. employee_id is ignored here — the
     * resignation belongs to whoever is holding the token, so one employee
     * cannot file another's resignation.
     */
    async submitOwnResignation(req, res) {
        try {
            const result = await EmployeeSeparationService.submitResignation(
                req.params.company_id,
                { ...req.body, employee_id: undefined },
                { user_id: req.user.user_id }
            );
            return send(res, result, 201);
        } catch (error) {
            return fail(res, error);
        }
    },

    /** An admin filing a resignation on an employee's behalf. */
    async submitResignationForEmployee(req, res) {
        try {
            const result = await EmployeeSeparationService.submitResignation(
                req.params.company_id,
                req.body,
                { user_id: req.user.user_id, employee_id: req.body.employee_id }
            );
            return send(res, result, 201);
        } catch (error) {
            return fail(res, error);
        }
    },

    async initiateTermination(req, res) {
        try {
            const result = await EmployeeSeparationService.initiateTermination(
                req.params.company_id,
                req.body,
                { user_id: req.user.user_id }
            );
            return send(res, result, 201);
        } catch (error) {
            return fail(res, error);
        }
    },

    // ── Reads ────────────────────────────────────────────────────────────────

    async list(req, res) {
        try {
            const result = await EmployeeSeparationService.listByCompany(req.params.company_id, {
                status: req.query.status ?? null,
                separation_type: req.query.type ?? null,
                branch_id: req.query.branch_id ?? null,
                from_date: req.query.from_date ?? null,
                to_date: req.query.to_date ?? null,
            });
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async getById(req, res) {
        try {
            const result = await EmployeeSeparationService.getById(req.params.company_id, req.params.id);
            return send(res, result, 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    async getMine(req, res) {
        try {
            const result = await EmployeeSeparationService.getForUser(
                req.user.user_id,
                req.params.company_id
            );
            return send(res, result, 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    /** Termination grounds and what each implies — reference data for the form. */
    getTerminationTypes(req, res) {
        try {
            return send(res, EmployeeSeparationService.getTerminationTypes());
        } catch (error) {
            return fail(res, error);
        }
    },

    // ── Workflow ─────────────────────────────────────────────────────────────

    async update(req, res) {
        try {
            const result = await EmployeeSeparationService.update(
                req.params.company_id, req.params.id, req.body
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async approve(req, res) {
        try {
            const result = await EmployeeSeparationService.approve(
                req.params.company_id, req.params.id, req.body, { user_id: req.user.user_id }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async reject(req, res) {
        try {
            const result = await EmployeeSeparationService.reject(
                req.params.company_id, req.params.id, req.body.rejection_reason,
                { user_id: req.user.user_id }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async withdraw(req, res) {
        try {
            const result = await EmployeeSeparationService.withdraw(
                req.params.company_id, req.params.id,
                { user_id: req.user.user_id, withdrawal_reason: req.body.withdrawal_reason }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async cancel(req, res) {
        try {
            const result = await EmployeeSeparationService.cancel(
                req.params.company_id, req.params.id, req.body.cancellation_reason
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async complete(req, res) {
        try {
            const result = await EmployeeSeparationService.complete(
                req.params.company_id, req.params.id, req.body, { user_id: req.user.user_id }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    // ── Final settlement ─────────────────────────────────────────────────────

    async previewSettlement(req, res) {
        try {
            const result = await EmployeeSeparationService.previewSettlement(
                req.params.company_id, req.params.id
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async saveSettlement(req, res) {
        try {
            const result = await EmployeeSeparationService.saveSettlement(
                req.params.company_id, req.params.id, req.body, { user_id: req.user.user_id }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async approveSettlement(req, res) {
        try {
            const result = await EmployeeSeparationService.approveSettlement(
                req.params.company_id, req.params.id, { user_id: req.user.user_id }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async markSettlementPaid(req, res) {
        try {
            const result = await EmployeeSeparationService.markSettlementPaid(
                req.params.company_id, req.params.id, req.body
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async listSettlements(req, res) {
        try {
            const result = await EmployeeSeparationService.listSettlements(req.params.company_id, {
                status: req.query.status ?? null,
                employee_id: req.query.employee_id ?? null,
            });
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },
};

module.exports = EmployeeSeparationController;
