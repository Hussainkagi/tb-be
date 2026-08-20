const TaskService = require("../../service/Task/taskService");

/**
 * Tasks.
 *
 * Thin by design: the controller shapes the request and picks the status
 * code, every decision lives in the service. `result.status` is the service
 * telling us which failure this was — 403 for "not allowed", 404 for "not
 * yours to see" — and defaults to 400 the way the rest of the app does.
 */

const fail = (res, result, fallback = 400) =>
    res.status(result.status || fallback).json({
        success: false,
        message: result.message,
    });

const serverError = (res, error) =>
    res.status(500).json({
        success: false,
        message: "Server error",
        error: error.message,
    });

const TaskController = {
    // --------------------------------------------------------
    // CREATE
    // --------------------------------------------------------

    // POST /api/companies/:company_id/tasks
    async create(req, res) {
        try {
            const result = await TaskService.createTask({
                company_id: req.params.company_id,
                user: req.user,
                actor: req.taskActor,
                data: req.body,
            });
            return result.success ? res.status(201).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // --------------------------------------------------------
    // READ
    // --------------------------------------------------------

    // GET /api/companies/:company_id/tasks
    async list(req, res) {
        try {
            // Arrays arrive as either ?status=open&status=submitted or
            // ?status=open,submitted — the mobile app sends the second.
            const csv = (value) =>
                value === undefined ? undefined
                    : Array.isArray(value) ? value
                    : String(value).split(",").map((v) => v.trim()).filter(Boolean);

            const result = await TaskService.listTasks({
                company_id: req.params.company_id,
                user: req.user,
                actor: req.taskActor,
                filters: {
                    status: csv(req.query.status),
                    priority: csv(req.query.priority),
                    category_id: req.query.category_id,
                    assigned_to_employee_id: req.query.assigned_to,
                    assigned_by_employee_id: req.query.assigned_by,
                    department_id: req.query.department_id,
                    branch_id: req.query.branch_id,
                    search: req.query.search,
                    due_from: req.query.due_from,
                    due_to: req.query.due_to,
                    overdue_only: req.query.overdue === "true",
                    include_completed: req.query.include_completed !== "false",
                    sort_by: req.query.sort_by,
                    sort_dir: req.query.sort_dir,
                    page: req.query.page,
                    limit: req.query.limit,
                },
            });
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // GET /api/companies/:company_id/tasks/my
    // The employee's own board. Same handler as list(), scoped to them —
    // the service already narrows by actor, this just spares the app from
    // having to know its own employee id.
    async listMine(req, res) {
        try {
            const result = await TaskService.listTasks({
                company_id: req.params.company_id,
                user: req.user,
                actor: req.taskActor,
                filters: {
                    include_completed: req.query.include_completed === "true",
                    sort_by: req.query.sort_by || "due_at",
                    sort_dir: req.query.sort_dir || "asc",
                    page: req.query.page,
                    limit: req.query.limit,
                },
            });
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // GET /api/companies/:company_id/tasks/summary
    async summary(req, res) {
        try {
            const result = await TaskService.getSummary({
                company_id: req.params.company_id,
                user: req.user,
                actor: req.taskActor,
            });
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // GET /api/companies/:company_id/tasks/:id
    async getById(req, res) {
        try {
            const result = await TaskService.getTaskById({
                company_id: req.params.company_id,
                user: req.user,
                actor: req.taskActor,
                task_id: req.params.id,
            });
            return result.success ? res.status(200).json(result) : fail(res, result, 404);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // --------------------------------------------------------
    // UPDATE
    // --------------------------------------------------------

    // PUT /api/companies/:company_id/tasks/:id
    async update(req, res) {
        try {
            const result = await TaskService.updateTask({
                company_id: req.params.company_id,
                user: req.user,
                actor: req.taskActor,
                task_id: req.params.id,
                data: req.body,
            });
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // PATCH /api/companies/:company_id/tasks/:id/status
    async changeStatus(req, res) {
        try {
            const result = await TaskService.changeStatus({
                company_id: req.params.company_id,
                user: req.user,
                actor: req.taskActor,
                task_id: req.params.id,
                status: req.body.status,
                remark: req.body.remark ?? null,
            });
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // --------------------------------------------------------
    // COMMENTS
    // --------------------------------------------------------

    // POST /api/companies/:company_id/tasks/:id/comments
    async addComment(req, res) {
        try {
            const result = await TaskService.addComment({
                company_id: req.params.company_id,
                user: req.user,
                actor: req.taskActor,
                task_id: req.params.id,
                comment: req.body.comment,
            });
            return result.success ? res.status(201).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // GET /api/companies/:company_id/tasks/:id/comments
    async getComments(req, res) {
        try {
            const result = await TaskService.getComments({
                company_id: req.params.company_id,
                user: req.user,
                actor: req.taskActor,
                task_id: req.params.id,
            });
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // DELETE /api/companies/:company_id/tasks/:id/comments/:comment_id
    async deleteComment(req, res) {
        try {
            const result = await TaskService.deleteComment({
                company_id: req.params.company_id,
                user: req.user,
                actor: req.taskActor,
                task_id: req.params.id,
                comment_id: req.params.comment_id,
            });
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // --------------------------------------------------------
    // DELETE
    // --------------------------------------------------------

    // DELETE /api/companies/:company_id/tasks/:id
    async delete(req, res) {
        try {
            const result = await TaskService.deleteTask({
                company_id: req.params.company_id,
                user: req.user,
                actor: req.taskActor,
                task_id: req.params.id,
            });
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },
};

module.exports = TaskController;
