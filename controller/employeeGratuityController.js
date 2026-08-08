const EmployeeGratuityService = require("../service/employeeGratuityService");

const send = (res, result, okStatus = 200, failStatus = 400) =>
    res.status(result.success ? okStatus : failStatus).json(result);

const fail = (res, error) =>
    res.status(500).json({ success: false, message: "Server error", error: error.message });

const EmployeeGratuityController = {
    /** Statutory presets — all countries, or one. */
    async listRules(req, res) {
        try {
            return send(res, await EmployeeGratuityService.getRules(null));
        } catch (error) {
            return fail(res, error);
        }
    },

    async getRule(req, res) {
        try {
            return send(res, await EmployeeGratuityService.getRules(req.params.country_code));
        } catch (error) {
            return fail(res, error);
        }
    },

    /** Config + accrued amount for one employee. ?as_of_date=YYYY-MM-DD */
    async getForEmployee(req, res) {
        try {
            const result = await EmployeeGratuityService.getForEmployee(
                req.params.employee_id,
                req.query
            );
            return send(res, result, 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    async upsertForEmployee(req, res) {
        try {
            const result = await EmployeeGratuityService.upsertForEmployee(
                req.params.company_id,
                req.params.employee_id,
                req.body
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async removeForEmployee(req, res) {
        try {
            const result = await EmployeeGratuityService.removeForEmployee(
                req.params.employee_id
            );
            return send(res, result, 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    /** Company-wide accrued liability. ?as_of_date&branch_id */
    async companySummary(req, res) {
        try {
            const result = await EmployeeGratuityService.getCompanySummary(
                req.params.company_id,
                req.query
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },
};

module.exports = EmployeeGratuityController;
