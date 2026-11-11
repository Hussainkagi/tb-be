const EmployeeModel = require("../models/employeeModel");
const { Role } = require("../enums/roles");
const { readSuperAdminFlag } = require("./isSuperAdmin");

/**
 * Per-employee access checks. Must run after verifyToken and validateTenant.
 *
 * Every id in a request can be edited by the caller, so a route that takes an
 * employee id has to prove the caller may act for that employee, not just
 * that they are logged in.
 */

const isManagerOrAbove = (req) => {
    const role = parseInt(req.user?.role, 10);
    return role === Role.ADMIN || role === Role.MANAGER;
};

const isVerifiedSuperAdmin = async (req) => {
    if (req.user?.is_super_admin !== true) return false;
    try {
        return await readSuperAdminFlag(req.user.user_id);
    } catch {
        return false;
    }
};

/** The caller's own employee record in the URL's company, looked up once per request. */
async function ownEmployee(req) {
    if (req._ownEmployee === undefined) {
        req._ownEmployee =
            (await EmployeeModel.findByUserAndCompany(req.user.user_id, req.params.company_id)) ?? null;
    }
    return req._ownEmployee;
}

const forbidden = (res) =>
    res.status(403).json({ success: false, message: "Access forbidden. You can only access your own records." });

/**
 * Allows the employee themselves, or an admin/manager of the same company.
 *
 * @param {string} param        name of the employee id field
 * @param {object} [options]
 * @param {"params"|"body"} [options.from="params"]  where the id is read from
 * @param {boolean} [options.selfOnly=false]  true when even managers may not act
 *        for someone else (device tokens, notification preferences)
 */
const requireEmployeeAccess = (param = "employee_id", { from = "params", selfOnly = false } = {}) =>
    async (req, res, next) => {
        try {
            const employeeId = from === "body" ? req.body?.[param] : req.params[param];
            if (!employeeId) {
                return res.status(400).json({ success: false, message: `${param} is required` });
            }

            if (!selfOnly && (isManagerOrAbove(req) || (await isVerifiedSuperAdmin(req)))) {
                // Still has to be an employee of this company: the URL's
                // company is checked by validateTenant, the id is not.
                const target = await EmployeeModel.findById(employeeId);
                if (!target || String(target.company_id) !== String(req.params.company_id)) {
                    return res.status(404).json({ success: false, message: "Employee not found" });
                }
                return next();
            }

            const own = await ownEmployee(req);
            if (!own || String(own.id) !== String(employeeId)) return forbidden(res);
            next();
        } catch (error) {
            res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    };

/** Same rule for routes keyed by user id: an employee may only ask about themselves. */
const requireUserAccess = (param = "user_id") => async (req, res, next) => {
    if (isManagerOrAbove(req) || String(req.params[param]) === String(req.user?.user_id)) return next();
    if (await isVerifiedSuperAdmin(req)) return next();
    return forbidden(res);
};

module.exports = { requireEmployeeAccess, requireUserAccess, ownEmployee, isManagerOrAbove, isVerifiedSuperAdmin };
