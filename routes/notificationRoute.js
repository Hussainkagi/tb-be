const express = require("express");
const router = express.Router({ mergeParams: true });

const NotificationController = require("../controller/notificationController");
const verifyToken = require("../middleware/verifyToken");
const { isAdmin, isManager, isEmployee } = require("../middleware/authorizeRoles");
const validateTenant = require("../middleware/validateTenant");
const { requireFeature } = require("../middleware/enforceEntitlement");
const { Feature } = require("../enums/features");

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
// Custom announcements are Pro+. The automatic notifications (leave status,
// check-in reminders, birthdays) stay on every plan — only the "broadcast
// whatever you like" composer is gated.
router.post("/custom", verifyToken, validateTenant, isAdmin, requireFeature(Feature.ANNOUNCEMENTS), NotificationController.sendCustom);
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
// ADMIN INBOX (Admin — always the caller's own)
//
// Narrowed to the notification types an admin acts on, deduplicated across
// devices, and joined to each entity's current state. The employee is taken
// from the token, never the URL. Mounted BEFORE /inbox/:employee_id so
// "admin" is not swallowed as an employee id.
// ─────────────────────────────────────────────
const AdminInboxController = require("../controller/adminInboxController");

router.get("/admin/inbox", verifyToken, validateTenant, isAdmin, AdminInboxController.getInbox);
router.get("/admin/inbox/unread-count", verifyToken, validateTenant, isAdmin, AdminInboxController.getUnreadCount);
router.patch("/admin/inbox/read-all", verifyToken, validateTenant, isAdmin, AdminInboxController.markAllRead);
router.patch("/admin/inbox/:notification_id/read", verifyToken, validateTenant, isAdmin, AdminInboxController.markRead);


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