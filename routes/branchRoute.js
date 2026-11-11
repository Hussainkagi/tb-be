const express = require("express");
const router = express.Router({ mergeParams: true });

const BranchController = require("../controller/branchController");
const BranchLocationController = require("../controller/branchLocationController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");
const { enforceLimit } = require("../middleware/enforceEntitlement");
const { Limit } = require("../enums/features");

// All routes scoped under /api/companies/:company_id/branches

// ─────────────────────────────────────────────
// ADMIN + MANAGER
// ─────────────────────────────────────────────
router.get("/", verifyToken, validateTenant, isManager, BranchController.getByCompany);
router.get("/:id", verifyToken, validateTenant, isManager, BranchController.getById);

// The branch cap applies to CREATE only. A company that drops from Gold to Pro
// holding 8 branches keeps managing all 8 — it just cannot add a 9th.
router.post(
    "/",
    verifyToken,
    validateTenant,
    isAdmin,
    enforceLimit(Limit.BRANCHES),
    BranchController.create
);
router.put("/:id", verifyToken, validateTenant, isManager, BranchController.update);
router.patch("/:id/deactivate", verifyToken, validateTenant, isAdmin, BranchController.deactivate);
router.delete("/:id", verifyToken, validateTenant, isAdmin, BranchController.delete);

// Extra check-in sites of a branch. Managed by whoever may edit the branch.
router.get("/:id/locations", verifyToken, validateTenant, isManager, BranchLocationController.list);
router.post("/:id/locations", verifyToken, validateTenant, isManager, BranchLocationController.create);
router.put("/:id/locations/:location_id", verifyToken, validateTenant, isManager, BranchLocationController.update);
router.delete("/:id/locations/:location_id", verifyToken, validateTenant, isManager, BranchLocationController.remove);

// ─────────────────────────────────────────────
// ALL AUTHENTICATED — used by attendance service
// ─────────────────────────────────────────────
router.get("/:id/geofence", verifyToken, validateTenant, isEmployee, BranchController.getGeofence);

module.exports = router;