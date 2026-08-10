const TestDataSeedService = require("../service/testDataSeedService");

const TestDataSeedController = {

    async seedAttendance(req, res) {
        try {
            const { employee_ids } = req.body || {};
            if (employee_ids !== undefined && employee_ids !== null && !Array.isArray(employee_ids)) {
                return res.status(400).json({
                    success: false,
                    message: "employee_ids must be an array of employee UUIDs (omit it to seed every active employee)",
                });
            }

            const result = await TestDataSeedService.seedAttendance({
                ...req.body,
                company_id: req.params.company_id,
                user_id: req.user.user_id,
            });

            return res.status(result.success ? 201 : 400).json(result);
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async clearSeededData(req, res) {
        try {
            const result = await TestDataSeedService.clearSeededData({
                company_id: req.params.company_id,
                month: req.body?.month ?? req.query.month,
                year: req.body?.year ?? req.query.year,
                employee_ids: req.body?.employee_ids || null,
            });
            return res.status(result.success ? 200 : 400).json(result);
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    /** The scenario catalogue — what a seeded month is guaranteed to contain. */
    async listScenarios(req, res) {
        return res.status(200).json({
            success: true,
            data: {
                scenarios: TestDataSeedService.SCENARIOS,
                notes: {
                    half_day_around_week_off:
                        "Half day on the working day either side of a week-off. Payroll must NOT "
                        + "treat the week-off as a sandwich — this is the case that was previously wrong.",
                    absent_around_week_off:
                        "Full-day absence either side of a week-off. This IS a sandwich; the "
                        + "week-off should come out unpaid.",
                    mixed_sandwich_absent_side:
                        "Absent one side, half day the other. Must NOT sandwich — a sandwich needs "
                        + "a full day of lost pay on both sides.",
                    comp_off:
                        "Earned comp-off. Stays fully paid and is never swallowed by a sandwich.",
                },
            },
        });
    },
};

module.exports = TestDataSeedController;
