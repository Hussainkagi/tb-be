const OtpModel = require("../models/otpTypeModel");

const OtpController = {
    // Cleanup expired OTPs — call via a cron job or admin endpoint
    async deleteExpired(req, res) {
        try {
            await OtpModel.deleteExpired();
            return res.status(200).json({
                success: true,
                message: "Expired OTPs cleaned up successfully",
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },
};

module.exports = OtpController;