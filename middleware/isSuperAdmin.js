const db = require("../config/database");

/**
 * Authorizes platform Super Admin access.
 * Must be used AFTER verifyToken middleware.
 *
 * The JWT carries `is_super_admin`, but the flag is ALSO re-checked against
 * the database on every request so that revoking it takes effect immediately
 * instead of waiting for the token to expire.
 *
 * Usage:
 *   router.get("/companies", verifyToken, requireSuperAdmin, handler)
 */

// Tiny TTL cache so we don't hit the DB on every single dashboard call.
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // user_id -> { is_super_admin, expires_at }

const readSuperAdminFlag = async (user_id) => {
    const cached = cache.get(user_id);
    if (cached && cached.expires_at > Date.now()) {
        return cached.is_super_admin;
    }

    const result = await db.query(
        `SELECT is_super_admin FROM users
         WHERE id = $1 AND is_active = true AND deleted_at IS NULL`,
        [user_id]
    );

    const is_super_admin = result.rows[0]?.is_super_admin === true;
    cache.set(user_id, { is_super_admin, expires_at: Date.now() + CACHE_TTL_MS });
    return is_super_admin;
};

/** Drops a user from the cache — call after granting/revoking. */
const invalidateSuperAdminCache = (user_id) => {
    if (user_id) cache.delete(user_id);
    else cache.clear();
};

const requireSuperAdmin = async (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({
            success: false,
            message: "Unauthorized. Please authenticate first.",
        });
    }

    try {
        const isSuper = await readSuperAdminFlag(req.user.user_id);

        if (!isSuper) {
            return res.status(403).json({
                success: false,
                message: "Access forbidden. Super Admin privileges required.",
                code: "NOT_SUPER_ADMIN",
            });
        }

        req.user.is_super_admin = true;
        next();
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Failed to verify Super Admin privileges",
            error: error.message,
        });
    }
};

module.exports = { requireSuperAdmin, readSuperAdminFlag, invalidateSuperAdminCache };
