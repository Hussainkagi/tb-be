const { readSuperAdminFlag } = require("./isSuperAdmin");

/**
 * Allows a user to read or change only their own user record
 * (req.params.id === the token's user_id). A verified platform Super Admin
 * may act on any user.
 *
 * Users are global, not per company, so a company admin is NOT allowed here:
 * their reach is their own company's employees, through the employee routes.
 *
 * Must be used AFTER verifyToken.
 */
const isSelfOrAdmin = async (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ success: false, message: "Unauthorized. Please authenticate first." });
    }

    if (String(req.user.user_id) === String(req.params.id)) return next();

    if (req.user.is_super_admin === true) {
        try {
            if (await readSuperAdminFlag(req.user.user_id)) return next();
        } catch {
            // Treated as not a super admin.
        }
    }

    return res.status(403).json({
        success: false,
        message: "Access forbidden. You can only access your own resources.",
    });
};

module.exports = isSelfOrAdmin;
