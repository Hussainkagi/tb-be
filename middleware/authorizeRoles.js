const { Role, RoleLabel } = require("../enums/roles");

/**
 * Authorizes access based on allowed roles.
 * Must be used AFTER verifyToken middleware.
 *
 * Usage:
 *   router.get("/admin-only", verifyToken, authorizeRoles(Role.ADMIN), handler)
 *   router.get("/admin-or-manager", verifyToken, authorizeRoles(Role.ADMIN, Role.MANAGER), handler)
 *
 * @param {...number} allowedRoles - Role enum values (Role.ADMIN, Role.MANAGER, Role.EMPLOYEE)
 */
const authorizeRoles = (...allowedRoles) => {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized. Please authenticate first.",
            });
        }

        const userRole = req.user.role;

        if (!allowedRoles.includes(userRole)) {
            const allowed = allowedRoles.map((r) => RoleLabel[r]).join(", ");
            return res.status(403).json({
                success: false,
                message: `Access forbidden. Required role(s): ${allowed}. Your role: ${RoleLabel[userRole] ?? "Unknown"}.`,
            });
        }

        next();
    };
};

/**
 * Shorthand middleware: Admin only
 */
const isAdmin = authorizeRoles(Role.ADMIN);

/**
 * Shorthand middleware: Admin or Manager
 */
const isManager = authorizeRoles(Role.ADMIN, Role.MANAGER);

/**
 * Shorthand middleware: Any authenticated user (Admin, Manager, Employee)
 */
const isEmployee = authorizeRoles(Role.ADMIN, Role.MANAGER, Role.EMPLOYEE);

module.exports = { authorizeRoles, isAdmin, isManager, isEmployee };