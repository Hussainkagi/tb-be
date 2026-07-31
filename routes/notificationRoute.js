const express = require("express");
const router = express.Router({ mergeParams: true });

const NotificationController = require("../controller/notificationController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");

// All routes scoped under /api/companies/:company_id/notifications


// ─────────────────────────────────────────────
// TEMPLATES (Admin only)
// ─────────────────────────────────────────────
router.get("/templates", verifyToken, validateTenant, isAdmin, NotificationController.getTemplatesByCompany);
router.get("/templates/:id", verifyToken, validateTenant, isAdmin, NotificationController.getTemplateById);
router.post("/templates", verifyToken, validateTenant, isAdmin, NotificationController.createTemplate);
router.put("/templates/:id", verifyToken, validateTenant, isAdmin, NotificationController.updateTemplate);
router.delete("/templates/:id", verifyToken, validateTenant, isAdmin, NotificationController.deleteTemplate);


// ─────────────────────────────────────────────
// NOTIFICATIONS: Send & manage (Admin / Manager)
// ─────────────────────────────────────────────
router.get("/", verifyToken, validateTenant, isManager, NotificationController.getByCompany);
router.get("/:id", verifyToken, validateTenant, isManager, NotificationController.getById);
router.post("/send", verifyToken, validateTenant, isAdmin, NotificationController.send);
router.post("/custom", verifyToken, validateTenant, isAdmin, NotificationController.sendCustom);
router.patch("/:id/cancel", verifyToken, validateTenant, isAdmin, NotificationController.cancel);
router.delete("/:id", verifyToken, validateTenant, isAdmin, NotificationController.delete);


// ─────────────────────────────────────────────
// DOMAIN SHORTCUTS (Admin / Manager)
// ─────────────────────────────────────────────
router.post("/leave-request", verifyToken, validateTenant, isManager, NotificationController.notifyLeaveRequest);
router.post("/leave-status", verifyToken, validateTenant, isManager, NotificationController.notifyLeaveStatusUpdate);
router.post("/holiday", verifyToken, validateTenant, isAdmin, NotificationController.notifyHolidayCreated);
router.post("/holiday-request", verifyToken, validateTenant, isManager, NotificationController.notifyHolidayRequest);


// ─────────────────────────────────────────────
// INBOX (Employee — self-service)
// ─────────────────────────────────────────────
router.get("/inbox/:employee_id", verifyToken, validateTenant, isEmployee, NotificationController.getInbox);
router.get("/inbox/:employee_id/unread-count", verifyToken, validateTenant, isEmployee, NotificationController.getUnreadCount);
router.patch("/recipients/:id/read", verifyToken, validateTenant, isEmployee, NotificationController.markAsRead);
router.patch("/inbox/:employee_id/read-all", verifyToken, validateTenant, isEmployee, NotificationController.markAllAsRead);


// ─────────────────────────────────────────────
// DEVICE TOKENS (Employee — self-service)
// ─────────────────────────────────────────────
router.post("/device-tokens", verifyToken, validateTenant, isEmployee, NotificationController.registerDeviceToken);
router.get("/device-tokens/:employee_id/:device_id", verifyToken, validateTenant, isEmployee, NotificationController.getDeviceTokenStatus);
router.delete("/device-tokens/:employee_id/:device_id", verifyToken, validateTenant, isEmployee, NotificationController.deactivateDeviceToken);


// ─────────────────────────────────────────────
// PREFERENCES (Employee — self-service)
// ─────────────────────────────────────────────
router.get("/preferences/:employee_id", verifyToken, validateTenant, isEmployee, NotificationController.getPreferencesByEmployee);
router.put("/preferences", verifyToken, validateTenant, isEmployee, NotificationController.upsertPreference);


// ─────────────────────────────────────────────
// SCHEDULER (Internal — protect with a separate
// secret/API-key middleware in production)
// ─────────────────────────────────────────────
router.post("/dispatch", verifyToken, validateTenant, isAdmin, NotificationController.processDispatchQueue);


module.exports = router;