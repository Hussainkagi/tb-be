const AttendanceService = require("../service/attendanceService");

const AttendanceController = {

    async checkIn(req, res) {
        try {
            const user_id = req.user.user_id;
            const company_id = req.params.company_id;

            const { latitude, longitude, address } = req.body;

            if (!latitude || !longitude) {
                return res.status(400).json({ success: false, message: "latitude and longitude are required" });
            }

            const result = await AttendanceService.checkIn(user_id, company_id, {
                latitude: parseFloat(latitude),
                longitude: parseFloat(longitude),
                address: address ?? null,
                selfie_file: req.file?.buffer ?? null,  // Buffer from multer memoryStorage
            });

            return res.status(result.success ? 200 : 400).json(result);
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    },

    async checkOut(req, res) {
        try {
            const user_id = req.user.user_id;
            const company_id = req.params.company_id;

            const { latitude, longitude, address } = req.body;

            if (!latitude || !longitude) {
                return res.status(400).json({ success: false, message: "latitude and longitude are required" });
            }

            const result = await AttendanceService.checkOut(user_id, company_id, {
                latitude: parseFloat(latitude),
                longitude: parseFloat(longitude),
                address: address ?? null,
                selfie_file: req.file?.buffer ?? null,  // Buffer from multer memoryStorage
            });

            return res.status(result.success ? 200 : 400).json(result);
        } catch (error) {
            return res.status(500).json({ success: false, message: error.message });
        }
    },

    async getById(req, res) {
        try {
            const result = await AttendanceService.getAttendanceById(req.params.id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getByCompany(req, res) {
        try {
            const { startDate, endDate } = req.query;
            const result = await AttendanceService.getAttendanceByCompany(
                req.params.company_id,
                { startDate, endDate }
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getByEmployee(req, res) {
        try {
            const { startDate, endDate } = req.query;
            const { company_id, employee_id } = req.params;

            const result = await AttendanceService.getAttendanceByEmployee(
                company_id,
                employee_id,
                { startDate, endDate }
            );

            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getByBranch(req, res) {
        try {
            const { startDate, endDate } = req.query;
            const result = await AttendanceService.getAttendanceByBranch(
                req.params.branch_id,
                { startDate, endDate }
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getSummary(req, res) {
        try {
            const { startDate, endDate } = req.query;
            const result = await AttendanceService.getAttendanceSummary(
                req.params.company_id,
                { startDate, endDate }
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getCheckInLocations(req, res) {
        try {
            const { startDate, endDate } = req.query;
            const result = await AttendanceService.getCheckInLocations(
                req.params.company_id,
                { startDate, endDate }
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async update(req, res) {
        try {
            const result = await AttendanceService.updateAttendance(req.params.id, req.body);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async delete(req, res) {
        try {
            const result = await AttendanceService.deleteAttendance(req.params.id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },
};

module.exports = AttendanceController;