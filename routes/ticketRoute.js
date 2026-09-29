const express = require("express");
const router = express.Router({ mergeParams: true });
const multer = require("multer");

const TicketController = require("../controller/ticketController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// ─────────────────────────────────────────────────────────────────────────────
// Mounted at /api/companies/:company_id/tickets
//
// Admin-only (support is a company-account concern, same as Billing/Backup)
// and deliberately NOT feature-gated — every plan, including Trial, can reach
// support.
// ─────────────────────────────────────────────────────────────────────────────

router.use(verifyToken, validateTenant, isAdmin);

// Multer — memory storage so req.files[].buffer is available for Cloudinary.
// Same shape as routes/attendanceRoute.js's selfie upload.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 3 }, // 5MB/file, 3 files max
    fileFilter(_req, file, cb) {
        if (!file.mimetype.startsWith("image/")) {
            return cb(new Error("Only image files are allowed for ticket attachments"));
        }
        cb(null, true);
    },
});

router.post("/", upload.array("images", 3), TicketController.create);
router.get("/", TicketController.list);
router.get("/:id", TicketController.getById);
router.post("/:id/messages", TicketController.reply);

// Multer error handler — must be defined after the routes that use it.
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || err.message === "Only image files are allowed for ticket attachments") {
        return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
});

module.exports = router;
