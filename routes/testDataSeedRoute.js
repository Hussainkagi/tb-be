const express = require("express");
const router = express.Router({ mergeParams: true });

const TestDataSeedController = require("../controller/testDataSeedController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// All routes scoped under /api/companies/:company_id/test-data
//
// TEST UTILITY. These endpoints write large amounts of fabricated attendance,
// and the seeder deletes the target month before writing. That is exactly what
// you want while testing payroll and exactly what you never want against real
// records — so the whole router is blocked in production unless someone
// deliberately sets ALLOW_TEST_DATA_SEED=true.

const blockInProduction = (req, res, next) => {
    const isProduction = (process.env.NODE_ENV || "development") === "production";
    const explicitlyAllowed = String(process.env.ALLOW_TEST_DATA_SEED).toLowerCase() === "true";

    if (isProduction && !explicitlyAllowed) {
        return res.status(403).json({
            success: false,
            message:
                "Test-data seeding is disabled in production. It overwrites real attendance. "
                + "Set ALLOW_TEST_DATA_SEED=true only on a throwaway environment.",
        });
    }
    return next();
};

router.use(blockInProduction);

// ─────────────────────────────────────────────
// SEED
// ─────────────────────────────────────────────
router.post("/attendance", verifyToken, validateTenant, isAdmin, TestDataSeedController.seedAttendance);

// ─────────────────────────────────────────────
// TEAR DOWN
// ─────────────────────────────────────────────
router.delete("/attendance", verifyToken, validateTenant, isAdmin, TestDataSeedController.clearSeededData);

// ─────────────────────────────────────────────
// REFERENCE — what a seeded month contains
// ─────────────────────────────────────────────
router.get("/scenarios", verifyToken, validateTenant, isAdmin, TestDataSeedController.listScenarios);

module.exports = router;
