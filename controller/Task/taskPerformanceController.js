const TaskPerformanceService = require("../../service/Task/taskPerformanceService");

const fail = (res, result, fallback = 400) =>
    res.status(result.status || fallback).json({ success: false, message: result.message });

const serverError = (res, error) =>
    res.status(500).json({ success: false, message: "Server error", error: error.message });

/**
 * The performance dashboard.
 *
 * Every endpoint here reads task_performance_daily, which the nightly job
 * fills. A company that turned the module on today therefore sees an empty
 * dashboard until the first rollup runs — /rebuild exists so an admin does
 * not have to wait for it.
 */
const TaskPerformanceController = {
    // GET /api/companies/:company_id/task-performance/employees
    async employees(req, res) {
        try {
            const result = await TaskPerformanceService.getEmployeeReport({
                company_id: req.params.company_id,
                user: req.user,
                actor: req.taskActor,
                employee_id: req.query.employee_id || null,
                from: req.query.from,
                to: req.query.to,
            });
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // GET /api/companies/:company_id/task-performance/leaderboard
    async leaderboard(req, res) {
        try {
            const result = await TaskPerformanceService.getLeaderboard({
                company_id: req.params.company_id,
                user: req.user,
                actor: req.taskActor,
                from: req.query.from,
                to: req.query.to,
                limit: req.query.limit,
            });
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // GET /api/companies/:company_id/task-performance/trend
    async trend(req, res) {
        try {
            const result = await TaskPerformanceService.getTrend({
                company_id: req.params.company_id,
                user: req.user,
                actor: req.taskActor,
                employee_id: req.query.employee_id || null,
                from: req.query.from,
                to: req.query.to,
            });
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // GET /api/companies/:company_id/task-performance/departments
    async departments(req, res) {
        try {
            const result = await TaskPerformanceService.getDepartmentComparison({
                company_id: req.params.company_id,
                user: req.user,
                actor: req.taskActor,
                from: req.query.from,
                to: req.query.to,
            });
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // POST /api/companies/:company_id/task-performance/rebuild
    // Admin-triggered recompute of a single day — for onboarding, and for
    // the morning after a worker outage.
    async rebuild(req, res) {
        try {
            const company_id = req.params.company_id;
            const { date, timezone } = req.body;

            if (!date) {
                return res.status(400).json({ success: false, message: "date (YYYY-MM-DD) is required" });
            }

            const result = await TaskPerformanceService.rollupCompanyDay(
                company_id, timezone || null, date
            );
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },
};

module.exports = TaskPerformanceController;
