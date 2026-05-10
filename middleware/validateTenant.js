/**
 * Validates that the authenticated user belongs to the tenant
 * specified in the route param (:tenantId) or request body.
 *
 * Admins can bypass tenant isolation if needed (cross-tenant support).
 *
 * Must be used AFTER verifyToken middleware.
 *
 * Usage:
 *   router.get("/tenants/:tenantId/employees", verifyToken, validateTenant, handler)
 */
const { Role } = require("../enums/roles");

const validateTenant = (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({
            success: false,
            message: "Unauthorized.",
        });
    }

    const requestedTenantId = req.params.tenantId || req.body?.tenantId;
    const userTenantId = req.user.tenantId;

    // Super Admin can access any tenant
    if (req.user.role === Role.ADMIN && !requestedTenantId) {
        return next();
    }

    if (String(userTenantId) !== String(requestedTenantId)) {
        return res.status(403).json({
            success: false,
            message: "Access forbidden. Tenant mismatch.",
        });
    }

    next();
};

module.exports = validateTenant;