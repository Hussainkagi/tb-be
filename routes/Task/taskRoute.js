const express = require("express");
const router = express.Router({ mergeParams: true });
const multer = require("multer");

const TaskController = require("../../controller/Task/taskController");
const verifyToken = require("../../middleware/verifyToken");
const { isEmployee } = require("../../middleware/authorizeRoles");
const validateTenant = require("../../middleware/validateTenant");
const loadTaskActor = require("../../middleware/Task/loadTaskActor");

// Memory storage so req.file.buffer is available for Cloudinary — same shape
// as routes/ticketRoute.js's image upload. The plan's actual second cap (15 /
// 30 / 40s) is enforced in taskService off the recording's real duration, not
// here — multer only knows bytes. 10MB comfortably covers 40s even uncompressed.
const uploadVoiceNote = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter(_req, file, cb) {
        if (!file.mimetype.startsWith("audio/")) {
            return cb(new Error("voice_note must be an audio file"));
        }
        cb(null, true);
    },
});

/**
 * Tasks — /api/companies/:company_id/tasks
 *
 * Every route is mounted with `isEmployee` (any authenticated member of the
 * company) rather than `isAdmin`, and that is deliberate: being a head of
 * department is not a role. An HOD is whoever departments.head_employee_id
 * points at, and they may hold any user_companies.role. A role guard here
 * would either lock HODs out of their own team's work or hand every manager
 * the whole company.
 *
 * The real authorization runs in service/Task/taskAccessService.js against
 * the actual employee and department records — admin sees the company, an
 * HOD sees the department they head, an employee sees their own tasks. See
 * the rule table at the top of that file.
 *
 * The plan gate (Feature.TASK_MANAGEMENT) is applied where this router is
 * mounted in server.js, so it covers every route below in one place.
 */

// ─────────────────────────────────────────────
// CREATE — admin or HOD (enforced in the service)
// ─────────────────────────────────────────────

// POST /api/companies/:company_id/tasks
router.post("/", verifyToken, validateTenant, isEmployee, loadTaskActor, TaskController.create);

// POST /api/companies/:company_id/tasks/:id/voice-note
// A separate step on purpose: it keeps task creation's JSON body contract
// (watcher_employee_ids and friends) untouched for every caller that never
// records audio, and lets the task exist before the (possibly slower)
// upload+duration-check round trip.
router.post(
    "/:id/voice-note",
    verifyToken,
    validateTenant,
    isEmployee,
    loadTaskActor,
    uploadVoiceNote.single("voice_note"),
    TaskController.attachVoiceNote
);

// ─────────────────────────────────────────────
// READ — named routes must come before /:id
// ─────────────────────────────────────────────

// GET /api/companies/:company_id/tasks/my
router.get("/my", verifyToken, validateTenant, isEmployee, loadTaskActor, TaskController.listMine);

// GET /api/companies/:company_id/tasks/summary
router.get("/summary", verifyToken, validateTenant, isEmployee, loadTaskActor, TaskController.summary);

// GET /api/companies/:company_id/tasks
router.get("/", verifyToken, validateTenant, isEmployee, loadTaskActor, TaskController.list);

// GET /api/companies/:company_id/tasks/:id
router.get("/:id", verifyToken, validateTenant, isEmployee, loadTaskActor, TaskController.getById);

// ─────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────

// PUT /api/companies/:company_id/tasks/:id
// The terms of the task — admin or the HOD of its department.
router.put("/:id", verifyToken, validateTenant, isEmployee, loadTaskActor, TaskController.update);

// PATCH /api/companies/:company_id/tasks/:id/status
// Progress. The assignee moves their own work; only a manager signs it off
// as completed (EMPLOYEE_ALLOWED_TARGETS in enums/Task/taskStatus.js).
router.patch("/:id/status", verifyToken, validateTenant, isEmployee, loadTaskActor, TaskController.changeStatus);

// ─────────────────────────────────────────────
// COMMENTS / REMARKS
// ─────────────────────────────────────────────

// GET  /api/companies/:company_id/tasks/:id/comments
router.get("/:id/comments", verifyToken, validateTenant, isEmployee, loadTaskActor, TaskController.getComments);

// POST /api/companies/:company_id/tasks/:id/comments
router.post("/:id/comments", verifyToken, validateTenant, isEmployee, loadTaskActor, TaskController.addComment);

// DELETE /api/companies/:company_id/tasks/:id/comments/:comment_id
router.delete(
    "/:id/comments/:comment_id",
    verifyToken,
    validateTenant,
    isEmployee,
    loadTaskActor,
    TaskController.deleteComment
);

// ─────────────────────────────────────────────
// DELETE — soft; admin or HOD
// ─────────────────────────────────────────────

// DELETE /api/companies/:company_id/tasks/:id
router.delete("/:id", verifyToken, validateTenant, isEmployee, loadTaskActor, TaskController.delete);

// Multer error handler — must be defined after the routes that use it.
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || err.message === "voice_note must be an audio file") {
        return res.status(400).json({ success: false, message: err.message });
    }
    next(err);
});

module.exports = router;
