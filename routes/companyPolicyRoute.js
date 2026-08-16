const express = require("express");
const router = express.Router({ mergeParams: true });

const PolicyController = require("../controller/policyController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isEmployee } = require("../middleware/authorizeRoles");
const { Role } = require("../enums/roles");

/**
 * Company-scope guard.
 *
 * validateTenant keys off `:tenantId`, which these routes do not use, so the
 * check is done here instead. It matters more on this router than on most:
 * the acceptance trail names the person who agreed and the IP they agreed
 * from, and that must never be readable across tenants.
 *
 * A platform Super Admin is allowed through so support can open a company's
 * Legal tab without impersonating an admin.
 */
const scopeToCompany = (req, res, next) => {
    if (req.user?.is_super_admin === true) return next();

    if (String(req.user?.company_id) !== String(req.params.company_id)) {
        return res.status(403).json({
            success: false,
            message: "Access forbidden. This company does not belong to you.",
        });
    }
    next();
};

router.use(verifyToken, scopeToCompany);

// ─────────────────────────────────────────────
// ANY AUTHENTICATED USER OF THE COMPANY
// ─────────────────────────────────────────────
//
// Employees can read the terms their employer operates under; only an admin
// can accept on the company's behalf.

// The Legal tab: current documents, what was accepted, what is outstanding.
router.get("/", isEmployee, PolicyController.getCompanyPolicies);

// The acceptance trail. Declared BEFORE /:policy_type so "acceptances" is not
// swallowed as a policy type.
router.get("/acceptances", isEmployee, PolicyController.getCompanyAcceptances);

// Full rendered content of the current terms / privacy policy.
router.get("/:policy_type", isEmployee, PolicyController.getCompanyPolicyDocument);

// ─────────────────────────────────────────────
// ADMIN ONLY
// ─────────────────────────────────────────────
//
// Accepting binds the company contractually, so it is the admin's signature —
// a manager or employee clicking "I Agree" would not be authority to bind.
// Body may carry policy_document_id; a stale one is rejected with 409.
router.post("/:policy_type/accept", isAdmin, PolicyController.acceptCompanyPolicy);

module.exports = router;
