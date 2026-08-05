const EmployeeBankAccountService = require("../service/employeeBankAccountService");

const send = (res, result, okStatus = 200, failStatus = 400) =>
    res.status(result.success ? okStatus : failStatus).json(result);

const fail = (res, error) =>
    res.status(500).json({ success: false, message: "Server error", error: error.message });

const EmployeeBankAccountController = {
    /** Countries with a dedicated bank-detail format. */
    async listCountries(req, res) {
        try {
            const result = await EmployeeBankAccountService.getFieldSpec(null);
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    /** Field spec for one country — drives the dynamic bank-details form. */
    async getFieldSpec(req, res) {
        try {
            const result = await EmployeeBankAccountService.getFieldSpec(
                req.params.country_code
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    /** Every employee's payout account in the company, plus a per-country tally. */
    async listByCompany(req, res) {
        try {
            const result = await EmployeeBankAccountService.listByCompany(
                req.params.company_id,
                req.query
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async getForEmployee(req, res) {
        try {
            const result = await EmployeeBankAccountService.getPrimary(req.params.employee_id);
            return send(res, result, 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    async listForEmployee(req, res) {
        try {
            const result = await EmployeeBankAccountService.listByEmployee(
                req.params.employee_id
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    /** Create or replace the employee's primary bank account. */
    async upsertForEmployee(req, res) {
        try {
            const { work_country, ...bank_details } = req.body || {};
            const result = await EmployeeBankAccountService.upsertPrimary(
                req.params.company_id,
                req.params.employee_id,
                work_country,
                bank_details
            );
            return send(res, result, 200, 400);
        } catch (error) {
            return fail(res, error);
        }
    },

    async update(req, res) {
        try {
            const result = await EmployeeBankAccountService.update(
                req.params.id,
                req.params.company_id,
                req.body
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async remove(req, res) {
        try {
            const result = await EmployeeBankAccountService.remove(
                req.params.id,
                req.params.company_id
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },
};

module.exports = EmployeeBankAccountController;
