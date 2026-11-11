const BranchLocationService = require("../service/branchLocationService");

// Routes: /api/companies/:company_id/branches/:id/locations[/:location_id]
const send = (res, result, okStatus = 200) =>
    res.status(result.success ? okStatus : result.status || 400).json(
        result.success
            ? { success: true, message: result.message, data: result.data }
            : { success: false, message: result.message }
    );

const BranchLocationController = {
    async list(req, res) {
        send(res, await BranchLocationService.list(req.params.company_id, req.params.id));
    },

    async create(req, res) {
        send(res, await BranchLocationService.create(req.params.company_id, req.params.id, req.body), 201);
    },

    async update(req, res) {
        send(res, await BranchLocationService.update(req.params.company_id, req.params.id, req.params.location_id, req.body));
    },

    async remove(req, res) {
        send(res, await BranchLocationService.remove(req.params.company_id, req.params.id, req.params.location_id));
    },
};

module.exports = BranchLocationController;
