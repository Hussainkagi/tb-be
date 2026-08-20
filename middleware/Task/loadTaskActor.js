const TaskAccessService = require("../../service/Task/taskAccessService");

/**
 * Resolve the person behind a task request once, up front.
 *
 * Two jobs:
 *
 *   1. One lookup per request. "Who is this and what do they head" is an
 *      employees read plus a departments read, and every task service method
 *      needs the answer. Doing it in the router means a handler that calls
 *      two services does not pay for it twice.
 *
 *   2. One clear failure for the case that would otherwise surface as an
 *      empty list: a login with no employee profile in this company. Tasks
 *      are assigned to employees, not to accounts — a manager whose employee
 *      record was never created should be told that, not shown a blank board.
 *
 * Must run AFTER verifyToken and validateTenant. Attaches req.taskActor;
 * the services accept it and skip their own lookup when it is present.
 */
const loadTaskActor = async (req, res, next) => {
    try {
        const company_id = req.params.company_id;

        if (!company_id) {
            return res.status(400).json({
                success: false,
                message: "company_id is required.",
            });
        }

        const resolved = await TaskAccessService.resolveActor(req.user, company_id);
        if (!resolved.success) {
            return res.status(resolved.status || 401).json({
                success: false,
                message: resolved.message,
            });
        }

        // An admin without an employee profile can still administer tasks —
        // they assign, edit and review rather than being assigned work. Anyone
        // else needs a profile for the module to have anything to say about them.
        if (!resolved.actor.employee_id && !resolved.actor.is_admin) {
            return res.status(403).json({
                success: false,
                message:
                    "Your account has no employee profile in this company, so tasks cannot be assigned to or by you. Ask your administrator to link your employee record.",
            });
        }

        req.taskActor = resolved.actor;
        return next();
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server error",
            error: error.message,
        });
    }
};

module.exports = loadTaskActor;
