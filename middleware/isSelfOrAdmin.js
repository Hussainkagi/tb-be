const { Role } = require("../enums/roles");

/**
 * Allows access if:
 *  - The requesting user is an Admin or Manager, OR
 *  - The requesting user is accessing their own resource (req.user.id === req.params.id)
 *
 * Useful for routes like GET /employees/:id where employees can view only their own profile.
 *
 * Must be used AFTER verifyToken middleware.
 *
 * Usage:
 *   router.get("/employees/:id", verifyToken, isSelfOrAdmin, handler)
 */
const isSelfOrAdmin = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({
            success: false,
            message: "Unauthorized. Please authenticate first.",
        });
    }

    const { role, id } = req.user;
    const resourceId = req.params.id;

    const isPrivileged = parseInt(role, 10) === Role.ADMIN ||
        parseInt(role, 10) === Role.MANAGER || parseInt(role, 10) === Role.EMPLOYEE;
    const isSelf = String(id) === String(resourceId);

    if (isPrivileged || isSelf) {
        return next();
    }

    return res.status(403).json({
        success: false,
        message: "Access forbidden. You can only access your own resources.",
    });
};

module.exports = isSelfOrAdmin;