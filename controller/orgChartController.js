const OrgChartService = require("../service/orgChartService");

const OrgChartController = {
    async getCompanyOrgChart(req, res) {
        try {
            const result = await OrgChartService.getCompanyOrgChart(req.params.company_id, {
                branch_id: req.query.branch_id || null,
            });

            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },
};

module.exports = OrgChartController;
