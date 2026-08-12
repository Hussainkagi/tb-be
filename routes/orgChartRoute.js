const express = require("express");
const router = express.Router({ mergeParams: true });

const OrgChartController = require("../controller/orgChartController");
const verifyToken = require("../middleware/verifyToken");
const { isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// Mounted at /api/companies/:company_id/org-chart
// Optional ?branch_id=<uuid> narrows the tree to a single branch.
router.get("/", verifyToken, validateTenant, isEmployee, OrgChartController.getCompanyOrgChart);

module.exports = router;
