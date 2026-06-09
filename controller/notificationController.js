const NotificationService = require("../service/notificationService");

const NotificationController = {

    // ─────────────────────────────────────────────────────────────────────────
    // TEMPLATES
    // ─────────────────────────────────────────────────────────────────────────

    async createTemplate(req, res) {
        try {
            const result = await NotificationService.createTemplate(req.body);
            if (result.success) {
                return res.status(201).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getTemplateById(req, res) {
        try {
            const result = await NotificationService.getTemplateById(req.params.id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getTemplatesByCompany(req, res) {
        try {
            const result = await NotificationService.getTemplatesByCompany(req.params.company_id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async updateTemplate(req, res) {
        try {
            const result = await NotificationService.updateTemplate(req.params.id, req.body);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async deleteTemplate(req, res) {
        try {
            const result = await NotificationService.deleteTemplate(req.params.id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },


    // ─────────────────────────────────────────────────────────────────────────
    // NOTIFICATIONS: Send & manage
    // ─────────────────────────────────────────────────────────────────────────

    // POST /notifications/send
    // General-purpose send (used internally or for direct API consumers)
    async send(req, res) {
        try {
            const result = await NotificationService.send(req.body);
            if (result.success) {
                return res.status(201).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    // POST /notifications/custom
    // Admin sends an ad-hoc / scheduled blast
    async sendCustom(req, res) {
        try {
            const result = await NotificationService.sendCustomNotification({
                ...req.body,
                created_by_user_id: req.user?.id || req.body.created_by_user_id || null,
            });
            if (result.success) {
                return res.status(201).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getById(req, res) {
        try {
            const result = await NotificationService.getNotificationById(req.params.id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getByCompany(req, res) {
        try {
            const { limit, offset } = req.query;
            const result = await NotificationService.getNotificationsByCompany(
                req.params.company_id,
                {
                    limit: limit ? parseInt(limit, 10) : undefined,
                    offset: offset ? parseInt(offset, 10) : undefined,
                }
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    // PATCH /notifications/:id/cancel
    async cancel(req, res) {
        try {
            const { cancellation_reason } = req.body;
            const result = await NotificationService.cancelNotification(
                req.params.id,
                cancellation_reason || null
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async delete(req, res) {
        try {
            const result = await NotificationService.deleteNotification(req.params.id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },


    // ─────────────────────────────────────────────────────────────────────────
    // DOMAIN SHORTCUTS: Leave, Holiday (called from their own controllers)
    // ─────────────────────────────────────────────────────────────────────────

    // POST /notifications/leave-request
    async notifyLeaveRequest(req, res) {
        try {
            const result = await NotificationService.notifyLeaveRequest(req.body);
            if (result.success) {
                return res.status(201).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    // POST /notifications/leave-status
    async notifyLeaveStatusUpdate(req, res) {
        try {
            const result = await NotificationService.notifyLeaveStatusUpdate(req.body);
            if (result.success) {
                return res.status(201).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    // POST /notifications/holiday
    async notifyHolidayCreated(req, res) {
        try {
            const result = await NotificationService.notifyHolidayCreated(req.body);
            if (result.success) {
                return res.status(201).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    // POST /notifications/holiday-request
    async notifyHolidayRequest(req, res) {
        try {
            const result = await NotificationService.notifyHolidayRequest(req.body);
            if (result.success) {
                return res.status(201).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },


    // ─────────────────────────────────────────────────────────────────────────
    // INBOX: Employee notification inbox (mobile app / web bell icon)
    // ─────────────────────────────────────────────────────────────────────────

    // GET /notifications/inbox/:employee_id
    async getInbox(req, res) {
        try {
            const { limit, offset } = req.query;
            const result = await NotificationService.getEmployeeInbox(
                req.params.employee_id,
                {
                    limit: limit ? parseInt(limit, 10) : undefined,
                    offset: offset ? parseInt(offset, 10) : undefined,
                }
            );
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    // GET /notifications/inbox/:employee_id/unread-count
    async getUnreadCount(req, res) {
        try {
            const result = await NotificationService.getUnreadCount(req.params.employee_id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    // PATCH /notifications/recipients/:id/read
    async markAsRead(req, res) {
        try {
            const result = await NotificationService.markAsRead(req.params.id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    // PATCH /notifications/inbox/:employee_id/read-all
    async markAllAsRead(req, res) {
        try {
            const result = await NotificationService.markAllAsRead(req.params.employee_id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },


    // ─────────────────────────────────────────────────────────────────────────
    // DEVICE TOKENS
    // ─────────────────────────────────────────────────────────────────────────

    // POST /notifications/device-tokens
    async registerDeviceToken(req, res) {
        try {
            const result = await NotificationService.registerDeviceToken(req.body);
            if (result.success) {
                return res.status(201).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    // DELETE /notifications/device-tokens/:employee_id/:device_id
    async deactivateDeviceToken(req, res) {
        try {
            const { employee_id, device_id } = req.params;
            const result = await NotificationService.deactivateDeviceToken(employee_id, device_id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(404).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },


    // ─────────────────────────────────────────────────────────────────────────
    // PREFERENCES
    // ─────────────────────────────────────────────────────────────────────────

    // PUT /notifications/preferences
    async upsertPreference(req, res) {
        try {
            const result = await NotificationService.upsertPreference(req.body);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    // GET /notifications/preferences/:employee_id
    async getPreferencesByEmployee(req, res) {
        try {
            const result = await NotificationService.getPreferencesByEmployee(req.params.employee_id);
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(400).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },


    // ─────────────────────────────────────────────────────────────────────────
    // SCHEDULER (internal — typically called by cron, not exposed publicly)
    // ─────────────────────────────────────────────────────────────────────────

    // POST /notifications/dispatch (protected / internal route)
    async processDispatchQueue(req, res) {
        try {
            const result = await NotificationService.processDispatchQueue();
            if (result.success) {
                return res.status(200).json(result);
            } else {
                return res.status(500).json(result);
            }
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },
};

module.exports = NotificationController;