const TaskCategoryService = require("../../service/Task/taskCategoryService");

const fail = (res, result, fallback = 400) =>
    res.status(result.status || fallback).json({ success: false, message: result.message });

const serverError = (res, error) =>
    res.status(500).json({ success: false, message: "Server error", error: error.message });

const TaskCategoryController = {
    // GET /api/companies/:company_id/task-categories/has-defaults
    async checkCategoriesExist(req, res) {
        try {
            const result = await TaskCategoryService.checkCategoriesExist(req.params.company_id);
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // GET /api/companies/:company_id/task-categories/defaults
    async listDefaults(req, res) {
        try {
            return res.status(200).json(TaskCategoryService.listDefaults());
        } catch (error) {
            return serverError(res, error);
        }
    },

    // POST /api/companies/:company_id/task-categories/seed-defaults
    async seedDefaults(req, res) {
        try {
            const result = await TaskCategoryService.seedDefaults(req.params.company_id);
            return result.success ? res.status(201).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // POST /api/companies/:company_id/task-categories
    async create(req, res) {
        try {
            const result = await TaskCategoryService.createCategory({
                ...req.body,
                company_id: req.params.company_id,
            });
            return result.success ? res.status(201).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // GET /api/companies/:company_id/task-categories
    async getAll(req, res) {
        try {
            const result = await TaskCategoryService.getAllByCompany(req.params.company_id, {
                activeOnly: req.query.active === "true",
            });
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // GET /api/companies/:company_id/task-categories/:id
    async getById(req, res) {
        try {
            const result = await TaskCategoryService.getById(req.params.company_id, req.params.id);
            return result.success ? res.status(200).json(result) : fail(res, result, 404);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // PUT /api/companies/:company_id/task-categories/:id
    async update(req, res) {
        try {
            const result = await TaskCategoryService.updateCategory(
                req.params.company_id, req.params.id, req.body
            );
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },

    // DELETE /api/companies/:company_id/task-categories/:id
    async delete(req, res) {
        try {
            const result = await TaskCategoryService.deleteCategory(req.params.company_id, req.params.id);
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return serverError(res, error);
        }
    },
};

module.exports = TaskCategoryController;
