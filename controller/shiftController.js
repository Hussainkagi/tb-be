const ShiftService = require("../service/shiftService");

const ShiftController = {
    async create(req, res) {
        try {
            const required = ["shift_name", "start_time", "end_time"];
            for (const field of required) {
                if (!req.body[field]) {
                    return res.status(400).json({
                        success: false,
                        message: `${field} is required.`
                    });
                }
            }

            const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
            for (const day of weekdays) {
                if (day in req.body && typeof req.body[day] !== "boolean") {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid value for ${day}. Must be boolean.`
                    });
                }
            }

            const result = await ShiftService.createShift({
                ...req.body,
                company_id: req.params.company_id,
                branch_id: req.params.branch_id,
            });

            return res.status(result.success ? 201 : 400).json(result);
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    async getById(req, res) {
        try {
            const result = await ShiftService.getShiftById(req.params.id);
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

    async getByCompany(req, res) {
        try {
            const result = await ShiftService.getShiftsByCompany(req.params.company_id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    async getByBranch(req, res) {
        try {
            const result = await ShiftService.getShiftsByBranch(
                req.params.company_id,
                req.params.branch_id
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    async getTiming(req, res) {
        try {
            const result = await ShiftService.getShiftTiming(req.params.id);
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

    async update(req, res) {
        try {
            // Prevent empty update
            if (!req.body || Object.keys(req.body).length === 0) {
                return res.status(400).json({
                    success: false,
                    message: "No fields provided to update."
                });
            }

            // Validate weekday fields if present
            const weekdays = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
            for (const day of weekdays) {
                if (day in req.body && typeof req.body[day] !== "boolean") {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid value for ${day}. Must be boolean.`
                    });
                }
            }

            const result = await ShiftService.updateShift(req.params.id, req.body);

            if (result.success) {
                return res.status(200).json(result);
            }

            // Return correct status based on failure reason
            if (result.message?.toLowerCase().includes("not found")) {
                return res.status(404).json(result);
            }

            return res.status(400).json(result);

        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    async deactivate(req, res) {
        try {
            const result = await ShiftService.deactivateShift(req.params.id);
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

    async delete(req, res) {
        try {
            const result = await ShiftService.deleteShift(req.params.id);
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

module.exports = ShiftController;