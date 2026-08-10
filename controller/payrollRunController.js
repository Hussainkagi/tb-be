const PayrollRunService = require("../service/payrollRunService");

/**
 * Every handler funnels through the same shape: the service returns
 * { success, message, data }, the controller maps it to a status code.
 */
function respond(res, result, successStatus = 200, failureStatus = 400) {
    if (result.success) return res.status(successStatus).json(result);
    return res.status(failureStatus).json(result);
}

function serverError(res, error) {
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
}

const ctx = (req) => ({
    company_id: req.params.company_id,
    user_id: req.user.user_id,
});

const PayrollRunController = {

    // ─── Flow ────────────────────────────────────────────────
    async start(req, res) {
        try {
            const result = await PayrollRunService.startRun({
                ...req.body,
                company_id: req.params.company_id,
                user_id: req.user.user_id,
            });
            return respond(res, result, result.resumed ? 200 : 201);
        } catch (error) {
            return serverError(res, error);
        }
    },

    async generate(req, res) {
        try {
            const result = await PayrollRunService.generate(req.params.run_id, {
                ...ctx(req),
                force: req.body?.force === true,
            });
            return respond(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    async syncAdjustments(req, res) {
        try {
            const result = await PayrollRunService.syncAdjustments(req.params.run_id, {
                ...ctx(req),
                note: req.body?.note,
            });
            return respond(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    async submit(req, res) {
        try {
            const result = await PayrollRunService.submitForApproval(req.params.run_id, {
                ...ctx(req),
                notes: req.body?.notes,
            });
            return respond(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    async approve(req, res) {
        try {
            const result = await PayrollRunService.approve(req.params.run_id, {
                ...ctx(req),
                notes: req.body?.notes,
            });
            // A self-approval block is a permission failure, not bad input.
            const status = result.message?.includes("cannot approve") ? 403 : 400;
            return respond(res, result, 200, status);
        } catch (error) {
            return serverError(res, error);
        }
    },

    async reject(req, res) {
        try {
            const result = await PayrollRunService.reject(req.params.run_id, {
                ...ctx(req),
                reason: req.body?.reason,
            });
            return respond(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    /** Totals + reachability for the payment confirmation dialog. */
    async paymentSummary(req, res) {
        try {
            const result = await PayrollRunService.getPaymentSummary(
                req.params.run_id, req.params.company_id
            );
            return respond(res, result, 200, 404);
        } catch (error) {
            return serverError(res, error);
        }
    },

    async pay(req, res) {
        try {
            const result = await PayrollRunService.markAsPaid(req.params.run_id, {
                ...ctx(req),
                notes: req.body?.notes,
                // Answers from the confirmation dialog. `undefined` means the
                // caller did not choose, so the company default applies.
                send_payslip_email: req.body?.send_payslip_email ?? null,
                notify_employees: req.body?.notify_employees !== false,
            });
            return respond(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    async notifyEmployees(req, res) {
        try {
            const result = await PayrollRunService.notifyEmployees(req.params.run_id, {
                ...ctx(req),
                only_failed: req.body?.only_failed === true,
            });
            return respond(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    async generatePayslips(req, res) {
        try {
            const result = await PayrollRunService.generatePayslips(req.params.run_id, ctx(req));
            return respond(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    async emailPayslips(req, res) {
        try {
            const result = await PayrollRunService.emailPayslips(req.params.run_id, {
                ...ctx(req),
                only_failed: req.body?.only_failed === true,
            });
            return respond(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    async complete(req, res) {
        try {
            const result = await PayrollRunService.complete(req.params.run_id, ctx(req));
            return respond(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    async cancel(req, res) {
        try {
            const result = await PayrollRunService.cancel(req.params.run_id, {
                ...ctx(req),
                reason: req.body?.reason,
            });
            return respond(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // ─── Reads ───────────────────────────────────────────────

    /** Powers the "you have an unfinished payroll" banner. */
    async resume(req, res) {
        try {
            const result = await PayrollRunService.getResumable(
                req.params.company_id,
                req.query.branch_id || null
            );
            return respond(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    async getById(req, res) {
        try {
            const result = await PayrollRunService.getRunById(req.params.run_id, req.params.company_id);
            return respond(res, result, 200, 404);
        } catch (error) {
            return serverError(res, error);
        }
    },

    async list(req, res) {
        try {
            const result = await PayrollRunService.getRuns(req.params.company_id, {
                status: req.query.status || null,
                limit: Math.min(parseInt(req.query.limit, 10) || 50, 200),
                offset: parseInt(req.query.offset, 10) || 0,
            });
            return respond(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    async pendingApprovals(req, res) {
        try {
            const result = await PayrollRunService.getPendingApprovals(req.params.company_id);
            return respond(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    async timeline(req, res) {
        try {
            const result = await PayrollRunService.getTimeline(req.params.run_id, req.params.company_id);
            return respond(res, result, 200, 404);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // ─── Settings ────────────────────────────────────────────
    async getSettings(req, res) {
        try {
            const result = await PayrollRunService.getSettings(req.params.company_id);
            return respond(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    async updateSettings(req, res) {
        try {
            const result = await PayrollRunService.updateSettings(req.params.company_id, req.body);
            return respond(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },
};

module.exports = PayrollRunController;
