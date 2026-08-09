const AdminInboxService = require("../service/adminInboxService");

const { ADMIN_INBOX_TYPES } = AdminInboxService;

const clamp = (v, min, max, fallback) => {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(Math.max(n, min), max);
};

/**
 * Company-admin inbox.
 *
 * The inbox always belongs to the caller — the employee is resolved from the
 * token, never from a path or query param. The existing
 * `/notifications/inbox/:employee_id` routes take the id from the URL, which
 * lets any authenticated user read anyone else's inbox; these endpoints do not
 * repeat that.
 */
const AdminInboxController = {

    /**
     * GET /api/companies/:company_id/notifications/admin/inbox
     * Query: type, unreadOnly, actionableOnly, page, limit
     */
    async getInbox(req, res) {
        try {
            const { type, unreadOnly, actionableOnly, page, limit } = req.query;

            if (type && !ADMIN_INBOX_TYPES.includes(type)) {
                return res.status(400).json({
                    success: false,
                    message: `type must be one of: ${ADMIN_INBOX_TYPES.join(", ")}`,
                });
            }

            const result = await AdminInboxService.getInbox({
                userId: req.user.user_id,
                companyId: req.params.company_id,
                notificationType: type || null,
                unreadOnly: unreadOnly === "true",
                actionableOnly: actionableOnly === "true",
                page: clamp(page, 1, 10000, 1),
                limit: clamp(limit, 1, 100, 30),
            });

            if (!result.success) {
                return res
                    .status(result.code === "NO_EMPLOYEE_PROFILE" ? 404 : 400)
                    .json({ success: false, message: result.message });
            }

            return res.status(200).json({ success: true, data: result.data });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    /**
     * GET /api/companies/:company_id/notifications/admin/inbox/unread-count
     */
    async getUnreadCount(req, res) {
        try {
            const result = await AdminInboxService.getUnreadCount({
                userId: req.user.user_id,
                companyId: req.params.company_id,
            });

            if (!result.success) {
                return res
                    .status(result.code === "NO_EMPLOYEE_PROFILE" ? 404 : 400)
                    .json({ success: false, message: result.message });
            }

            return res.status(200).json({ success: true, data: result.data });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    /**
     * PATCH /api/companies/:company_id/notifications/admin/inbox/:notification_id/read
     */
    async markRead(req, res) {
        try {
            const result = await AdminInboxService.markRead({
                userId: req.user.user_id,
                companyId: req.params.company_id,
                notificationId: req.params.notification_id,
            });

            if (!result.success) {
                const status = result.code === "NOT_FOUND" || result.code === "NO_EMPLOYEE_PROFILE" ? 404 : 400;
                return res.status(status).json({ success: false, message: result.message });
            }

            return res.status(200).json({ success: true, data: result.data });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    /**
     * PATCH /api/companies/:company_id/notifications/admin/inbox/read-all
     */
    async markAllRead(req, res) {
        try {
            const result = await AdminInboxService.markAllRead({
                userId: req.user.user_id,
                companyId: req.params.company_id,
            });

            if (!result.success) {
                return res
                    .status(result.code === "NO_EMPLOYEE_PROFILE" ? 404 : 400)
                    .json({ success: false, message: result.message });
            }

            return res.status(200).json({ success: true, data: result.data });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },
};

module.exports = AdminInboxController;
