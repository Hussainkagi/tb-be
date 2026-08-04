const ActivityLogService = require("../service/activityLogService");

const send = (res, result, okStatus = 200, failStatus = 400) =>
    res.status(result.success ? okStatus : failStatus).json(result);

const fail = (res, error) =>
    res.status(500).json({
        success: false,
        message: "Server error",
        error: error.message,
    });

/**
 * Company-scoped activity log — for a company's own Admins.
 * The company_id always comes from the URL, which validateTenant has already
 * checked against the caller's token, so one tenant can never read another's.
 */
const ActivityLogController = {
    async list(req, res) {
        try {
            const result = await ActivityLogService.list(req.params.company_id, req.query);
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async stats(req, res) {
        try {
            const result = await ActivityLogService.getStats(
                req.params.company_id,
                req.query
            );
            return send(res, result, 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    async actionCatalog(req, res) {
        try {
            const result = await ActivityLogService.getActionCatalog(req.params.company_id);
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async entityHistory(req, res) {
        try {
            const result = await ActivityLogService.getEntityHistory(
                req.params.entity_type,
                req.params.entity_id,
                req.params.company_id
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },
};

module.exports = ActivityLogController;
