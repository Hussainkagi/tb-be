const { readSuperAdminFlag } = require("./isSuperAdmin");

/**
 * Company-scope guard for every /companies/:company_id/... route.
 *
 * The caller's token is issued for one company (company_id in the JWT). A
 * request for any other company is refused, whatever the caller's role, so an
 * admin of one company can never read or change another's data.
 *
 * A platform Super Admin passes, but only after the flag is re-read from the
 * database, so revoking it takes effect immediately.
 *
 * Routes without a :company_id are not company-scoped and pass through.
 * Must be used AFTER verifyToken, on a router created with mergeParams: true
 * (or one whose own path declares :company_id).
 */
const validateTenant = async (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({ success: false, message: "Unauthorized." });
    }

    const requested = req.params.company_id;
    if (!requested) return next();

    if (req.user.company_id && String(req.user.company_id) === String(requested)) {
        return next();
    }

    if (req.user.is_super_admin === true) {
        try {
            if (await readSuperAdminFlag(req.user.user_id)) return next();
        } catch {
            // Fall through to the refusal: an unverifiable flag is no flag.
        }
    }

    return res.status(403).json({
        success: false,
        message: "Access forbidden. This company does not belong to you.",
    });
};

module.exports = validateTenant;
