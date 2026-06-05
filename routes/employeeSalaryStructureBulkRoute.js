const express = require("express");
const router = express.Router({ mergeParams: true });
const EmployeeSalaryStructureBulkController = require("../controller/employeeSalaryStructureBulkController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");
const multer = require("multer");

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter(_req, file, cb) {
        const ext = file.originalname.split(".").pop().toLowerCase();
        const ok =
            file.mimetype.includes("spreadsheet") ||
            file.mimetype === "text/csv" ||
            file.mimetype === "application/csv" ||
            ext === "xlsx" ||
            ext === "xls" ||
            ext === "csv";
        ok ? cb(null, true) : cb(new Error("Only .csv and .xlsx files are accepted"), false);
    },
});

// Download a pre-filled CSV template
router.get("/template", verifyToken, validateTenant, isManager, EmployeeSalaryStructureBulkController.downloadTemplate);

// Upload .csv or .xlsx to create salary structures for multiple employees at once
router.post("/", verifyToken, validateTenant, isManager, upload.single("file"), EmployeeSalaryStructureBulkController.bulkUpload);

module.exports = router;