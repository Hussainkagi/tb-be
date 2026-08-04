const db = require("../config/database");
const { verifyAccessToken } = require("../utils/jwt");

/**
 * Platform-wide "company disabled" guard.
 *
 * When a Super Admin disables a company (companies.is_active = FALSE), every
 * user of that company can still LOG IN and READ their data — the frontend
 * needs that to render the "Your company has been disabled" screen — but all
 * state-changing requests (POST/PUT/PATCH/DELETE) are rejected with 403.
 *
 * Mounted globally on /api BEFORE the route table, so it covers every module
 * without touching each route file. It decodes the token opportunistically:
 * authentication itself is still enforced by each route's verifyToken.
 *
 * Exempt paths:
 *   - /auth/*        → login, logout, refresh, password flows, company switch
 *   - /super-admin/* → super admins operate above the tenant boundary
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Tiny TTL cache — a company's active state changes very rarely.
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // company_id -> { row, expires_at }

const readCompanyState = async (company_id) => {
    const cached = cache.get(company_id);
    if (cached && cached.expires_at > Date.now()) return cached.row;

    const result = await db.query(
        `SELECT id, company_name, is_active, disabled_at, disabled_reason
         FROM companies
         WHERE id = $1 AND deleted_at IS NULL`,
        [company_id]
    );

    const row = result.rows[0] || null;
    cache.set(company_id, { row, expires_at: Date.now() + CACHE_TTL_MS });
    return row;
};

/** Drops a company from the cache — call right after disable/enable. */
const invalidateCompanyCache = (company_id) => {
    if (company_id) cache.delete(company_id);
    else cache.clear();
};

const isExemptPath = (path) =>
    path.includes("/auth/") || path.startsWith("/super-admin");

const enforceCompanyActive = async (req, res, next) => {
    if (isExemptPath(req.path)) return next();

    const authHeader = req.headers["authorization"];
    if (!authHeader || !authHeader.startsWith("Bearer ")) return next();

    let decoded;
    try {
        decoded = verifyAccessToken(authHeader.split(" ")[1]);
    } catch {
        return next(); // invalid/expired token — the route's verifyToken will reject it
    }

    const company_id = decoded?.company_id;
    if (!company_id) return next();

    try {
        const company = await readCompanyState(company_id);

        // Company missing/soft-deleted — leave the 404 to the route handler.
        if (!company) return next();

        if (company.is_active === false) {
            // Always advertise the disabled state so the UI can show a banner
            // even on reads.
            res.set("X-Company-Disabled", "true");
            req.companyDisabled = true;

            if (!SAFE_METHODS.has(req.method) && decoded.is_super_admin !== true) {
                return res.status(403).json({
                    success: false,
                    code: "COMPANY_DISABLED",
                    message:
                        "This company has been disabled by the platform administrator. All actions are currently unavailable.",
                    data: {
                        company_id: company.id,
                        company_name: company.company_name,
                        disabled_at: company.disabled_at,
                        disabled_reason: company.disabled_reason,
                    },
                    timestamp: new Date().toISOString(),
                });
            }
        }

        next();
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Failed to verify company status",
            error: error.message,
        });
    }
};

module.exports = { enforceCompanyActive, invalidateCompanyCache };
