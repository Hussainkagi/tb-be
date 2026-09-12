const express = require("express");
const router = express.Router({ mergeParams: true });
const multer = require("multer");

const BackupController = require("../controller/backupController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");
const { requireFeature } = require("../middleware/enforceEntitlement");
const { Feature } = require("../enums/features");

// ─────────────────────────────────────────────────────────────────────────────
// Mounted at /api/companies/:company_id/backup
//
// Premium-only, no allowReads: even viewing the settings/history of a feature
// you're not entitled to is part of the upsell surface, same treatment as
// leave-salary's advance/encashment sub-routers.
//
// Admin-only throughout — this is company-wide payroll and bank data, and
// restore is destructive.
// ─────────────────────────────────────────────────────────────────────────────

router.use(verifyToken, validateTenant, isAdmin, requireFeature(Feature.BACKUP_RESTORE));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB — a full-company workbook, not the 10mb JSON body cap in server.js
    fileFilter(_req, file, cb) {
        const ext = file.originalname.split(".").pop().toLowerCase();
        const ok =
            file.mimetype.includes("spreadsheet") ||
            file.mimetype === "application/vnd.ms-excel" ||
            ext === "xlsx" ||
            ext === "xls";
        ok ? cb(null, true) : cb(new Error("Only .xlsx backup files are accepted"), false);
    },
});

router.get("/catalog", BackupController.getCatalog);

router.get("/settings", BackupController.getSettings);
router.put("/settings", BackupController.updateSettings);

router.get("/jobs", BackupController.listJobs);
router.get("/jobs/:job_id", BackupController.getJob);

router.post("/export", BackupController.requestExport);
router.post("/restore", upload.single("file"), BackupController.requestRestore);

module.exports = router;
