const AttendanceReportService = require("../service/attendanceReportService");

// ---------------------------------------------------------------------------
// Helper — validate date range query params
// ---------------------------------------------------------------------------
function validateDateRange(startDate, endDate) {
    if (!startDate || !endDate) {
        return "startDate and endDate query parameters are required";
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        return "startDate and endDate must be in YYYY-MM-DD format";
    }
    if (startDate > endDate) {
        return "startDate must be before or equal to endDate";
    }
    return null;
}

// ---------------------------------------------------------------------------
// Controllers
// ---------------------------------------------------------------------------

const AttendanceReportController = {

    /**
     * GET /api/companies/:company_id/attendance-reports/detailed
     * Query: employeeId, startDate, endDate, timezone, branchId, departmentId
     */
    async getDetailedReport(req, res) {
        try {
            const { startDate, endDate, timezone, employeeId, branchId, departmentId } = req.query;

            const err = validateDateRange(startDate, endDate);
            if (err) return res.status(400).json({ success: false, message: err });

            const result = await AttendanceReportService.getDetailedReport({
                companyId: req.params.company_id,
                employeeId: employeeId || null,
                branchId: branchId || null,
                departmentId: departmentId || null,
                startDate,
                endDate,
                timezone: timezone || "UTC",
            });

            if (!result.success) {
                return res.status(400).json({ success: false, message: result.message });
            }

            return res.status(200).json(result.data);
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    /**
     * GET /api/companies/:company_id/attendance-reports/headcount
     * Query: employeeId, startDate, endDate, timezone, branchId, departmentId
     */
    async getHeadcount(req, res) {
        try {
            const { startDate, endDate, timezone, employeeId, branchId, departmentId } = req.query;

            const err = validateDateRange(startDate, endDate);
            if (err) return res.status(400).json({ success: false, message: err });

            const result = await AttendanceReportService.getHeadcount({
                companyId: req.params.company_id,
                employeeId: employeeId || null,
                branchId: branchId || null,
                departmentId: departmentId || null,
                startDate,
                endDate,
                timezone: timezone || "UTC",
            });

            if (!result.success) {
                return res.status(400).json({ success: false, message: result.message });
            }

            return res.status(200).json(result.data);
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    /**
     * GET /api/companies/:company_id/attendance-reports/check-in-out-ratio
     * Query: employeeId, startDate, endDate, timezone, branchId, departmentId
     */
    async getCheckInOutRatio(req, res) {
        try {
            const { startDate, endDate, timezone, employeeId, branchId, departmentId } = req.query;

            const err = validateDateRange(startDate, endDate);
            if (err) return res.status(400).json({ success: false, message: err });

            const result = await AttendanceReportService.getCheckInOutRatio({
                companyId: req.params.company_id,
                employeeId: employeeId || null,
                branchId: branchId || null,
                departmentId: departmentId || null,
                startDate,
                endDate,
                timezone: timezone || "UTC",
            });

            if (!result.success) {
                return res.status(400).json({ success: false, message: result.message });
            }

            return res.status(200).json(result.data);
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    /**
     * GET /api/companies/:company_id/attendance-reports/punctuality-ratio
     * Query: employeeId, startDate, endDate, timezone, branchId, departmentId
     */
    async getPunctualityRatio(req, res) {
        try {
            const { startDate, endDate, timezone, employeeId, branchId, departmentId } = req.query;

            const err = validateDateRange(startDate, endDate);
            if (err) return res.status(400).json({ success: false, message: err });

            const result = await AttendanceReportService.getPunctualityRatio({
                companyId: req.params.company_id,
                employeeId: employeeId || null,
                branchId: branchId || null,
                departmentId: departmentId || null,
                startDate,
                endDate,
                timezone: timezone || "UTC",
            });

            if (!result.success) {
                return res.status(400).json({ success: false, message: result.message });
            }

            return res.status(200).json(result.data);
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    /**
     * GET /api/companies/:company_id/attendance-reports/working-hours
     * Query: employeeId, startDate, endDate, timezone, branchId, departmentId
     */
    async getWorkingHours(req, res) {
        try {
            const { startDate, endDate, timezone, employeeId, branchId, departmentId } = req.query;

            const err = validateDateRange(startDate, endDate);
            if (err) return res.status(400).json({ success: false, message: err });

            const result = await AttendanceReportService.getWorkingHours({
                companyId: req.params.company_id,
                employeeId: employeeId || null,
                branchId: branchId || null,
                departmentId: departmentId || null,
                startDate,
                endDate,
                timezone: timezone || "UTC",
            });

            if (!result.success) {
                return res.status(400).json({ success: false, message: result.message });
            }

            return res.status(200).json(result.data);
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },
    /**
     * GET /api/companies/:company_id/attendance-reports/casual
     * Query: employeeId, startDate, endDate, branchId, departmentId
     */
    async getCasualReport(req, res) {
        try {
            const { startDate, endDate, employeeId, branchId, departmentId } = req.query;
            const err = validateDateRange(startDate, endDate);
            if (err) return res.status(400).json({ success: false, message: err });

            const result = await AttendanceReportService.getCasualReport({
                companyId: req.params.company_id,
                employeeId: employeeId || null,
                branchId: branchId || null,
                departmentId: departmentId || null,
                startDate,
                endDate,
            });

            if (!result.success) {
                return res.status(400).json({ success: false, message: result.message });
            }
            return res.status(200).json(result.data);
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },
};

module.exports = AttendanceReportController;