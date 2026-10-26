const UserCompanyService = require("../service/userCompanyService");

const STATUS = { INVALID: 401, PASSWORD_NOT_SET: 403, INACTIVE: 403, LOCKED: 423 };

const InternalController = {
    // POST /internal/verify-login  { username, password }
    // Checks a Teambook login for another Ikration app and returns who it is (no tokens).
    async verifyLogin(req, res) {
        const { username, password } = req.body || {};
        if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
            return res.status(400).json({ success: false, code: "INVALID", message: "username and password are required" });
        }
        const result = await UserCompanyService.verifyLogin(username.trim().toUpperCase(), password);
        if (result.success) return res.status(200).json(result);
        return res.status(STATUS[result.code] || 500).json(result);
    },
};

module.exports = InternalController;
