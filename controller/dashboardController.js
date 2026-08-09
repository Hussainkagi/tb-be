const DashboardService = require("../service/dashboardService");

const { ALL_SECTIONS } = DashboardService;
const { isUuid, isDate, clamp } = DashboardService._helpers;

const ATTENDANCE_STATUSES = ["on-time", "before-time", "late"];
const SEVERITIES = ["critical", "warning", "info"];

/**
 * Company-admin dashboard endpoints.
 *
 * Query params are validated here (the service assumes clean input) and every
 * list is capped, so a dashboard request can never ask the database for an
 * unbounded result set.
 */
const DashboardController = {

    /**
     * GET /api/companies/:company_id/dashboard/overview
     * Query: branchId, sections, rangeDays, upcomingDays, sampleLimit
     */
    async getOverview(req, res) {
        try {
            const { branchId, sections, rangeDays, upcomingDays, sampleLimit } = req.query;

            if (branchId && !isUuid(branchId)) {
                return res.status(400).json({ success: false, message: "branchId must be a valid UUID" });
            }

            let requested = ALL_SECTIONS;
            if (sections) {
                requested = String(sections)
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean);

                const unknown = requested.filter((s) => !ALL_SECTIONS.includes(s));
                if (unknown.length) {
                    return res.status(400).json({
                        success: false,
                        message: `Unknown section(s): ${unknown.join(", ")}. Allowed: ${ALL_SECTIONS.join(", ")}`,
                    });
                }
            }

            const result = await DashboardService.getOverview({
                companyId: req.params.company_id,
                branchId: branchId || null,
                sections: requested,
                rangeDays: clamp(rangeDays, 1, 180, 30),
                upcomingDays: clamp(upcomingDays, 1, 180, 30),
                sampleLimit: clamp(sampleLimit, 1, 25, 5),
            });

            if (!result.success) {
                return res.status(404).json({ success: false, message: result.message });
            }

            return res.status(200).json({ success: true, data: result.data });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    /**
     * GET /api/companies/:company_id/dashboard/attendance/today
     * Query: branchId, departmentId, attendanceStatus, view, onlyOpen, date, page, limit
     *
     * view=checked-in (default) → who checked in, with locations
     * view=missing              → who was expected and has not checked in
     */
    async getTodayAttendance(req, res) {
        try {
            const {
                branchId, departmentId, attendanceStatus, view, onlyOpen, date, page, limit,
            } = req.query;

            if (branchId && !isUuid(branchId)) {
                return res.status(400).json({ success: false, message: "branchId must be a valid UUID" });
            }
            if (departmentId && !isUuid(departmentId)) {
                return res.status(400).json({ success: false, message: "departmentId must be a valid UUID" });
            }
            if (date && !isDate(date)) {
                return res.status(400).json({ success: false, message: "date must be in YYYY-MM-DD format" });
            }
            if (attendanceStatus && !ATTENDANCE_STATUSES.includes(attendanceStatus)) {
                return res.status(400).json({
                    success: false,
                    message: `attendanceStatus must be one of: ${ATTENDANCE_STATUSES.join(", ")}`,
                });
            }
            if (view && !["checked-in", "missing"].includes(view)) {
                return res.status(400).json({
                    success: false,
                    message: "view must be either 'checked-in' or 'missing'",
                });
            }

            const result = await DashboardService.getTodayAttendance({
                companyId: req.params.company_id,
                branchId: branchId || null,
                departmentId: departmentId || null,
                attendanceStatus: attendanceStatus || null,
                view: view || "checked-in",
                onlyOpen: onlyOpen === "true",
                date: date || null,
                page: clamp(page, 1, 10000, 1),
                limit: clamp(limit, 1, 200, 50),
            });

            if (!result.success) {
                return res.status(404).json({ success: false, message: result.message });
            }

            return res.status(200).json({ success: true, data: result.data });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    /**
     * GET /api/companies/:company_id/dashboard/warnings
     * Query: branchId, severity, sampleLimit, expiryWindowDays
     */
    async getWarnings(req, res) {
        try {
            const { branchId, severity, sampleLimit, expiryWindowDays } = req.query;

            if (branchId && !isUuid(branchId)) {
                return res.status(400).json({ success: false, message: "branchId must be a valid UUID" });
            }
            if (severity && !SEVERITIES.includes(severity)) {
                return res.status(400).json({
                    success: false,
                    message: `severity must be one of: ${SEVERITIES.join(", ")}`,
                });
            }

            const result = await DashboardService.getWarnings({
                companyId: req.params.company_id,
                branchId: branchId || null,
                severity: severity || null,
                sampleLimit: clamp(sampleLimit, 1, 50, 10),
                expiryWindowDays: clamp(expiryWindowDays, 1, 365, 60),
            });

            if (!result.success) {
                return res.status(404).json({ success: false, message: result.message });
            }

            return res.status(200).json({ success: true, data: result.data });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    /**
     * GET /api/companies/:company_id/dashboard/branches
     * Query: startDate, endDate
     */
    async getBranchStats(req, res) {
        try {
            const { startDate, endDate } = req.query;

            if (startDate && !isDate(startDate)) {
                return res.status(400).json({ success: false, message: "startDate must be in YYYY-MM-DD format" });
            }
            if (endDate && !isDate(endDate)) {
                return res.status(400).json({ success: false, message: "endDate must be in YYYY-MM-DD format" });
            }

            const result = await DashboardService.getBranchStats({
                companyId: req.params.company_id,
                startDate: startDate || null,
                endDate: endDate || null,
            });

            if (!result.success) {
                return res.status(400).json({ success: false, message: result.message });
            }

            return res.status(200).json({ success: true, data: result.data });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    /**
     * GET /api/companies/:company_id/dashboard/upcoming
     * Query: branchId, days
     */
    async getUpcoming(req, res) {
        try {
            const { branchId, days } = req.query;

            if (branchId && !isUuid(branchId)) {
                return res.status(400).json({ success: false, message: "branchId must be a valid UUID" });
            }

            const result = await DashboardService.getUpcoming({
                companyId: req.params.company_id,
                branchId: branchId || null,
                days: clamp(days, 1, 180, 30),
            });

            if (!result.success) {
                return res.status(404).json({ success: false, message: result.message });
            }

            return res.status(200).json({ success: true, data: result.data });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },
};

module.exports = DashboardController;
