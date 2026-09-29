const TicketService = require("../service/ticketService");

// Platform-facing — mounted inside routes/superAdminRoute.js, cross-tenant.
const TicketAdminController = {
    async list(req, res) {
        try {
            const { status, priority, company_id, search, page, limit } = req.query;
            const result = await TicketService.listForPlatform({
                status: status || null,
                priority: priority || null,
                company_id: company_id || null,
                search: search || null,
                page: page ? parseInt(page, 10) : 1,
                limit: limit ? parseInt(limit, 10) : 20,
            });
            return res.status(200).json({ success: true, data: result.data, pagination: result.pagination });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getById(req, res) {
        try {
            const result = await TicketService.getForPlatform(req.params.id);
            if (!result) {
                return res.status(404).json({ success: false, message: "Ticket not found." });
            }
            return res.status(200).json({ success: true, data: result });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async updateStatus(req, res) {
        try {
            const { status } = req.body;
            if (!status) {
                return res.status(400).json({ success: false, message: "status is required." });
            }

            const updated = await TicketService.updateStatus(req.params.id, status, req.user.user_id);
            if (!updated) {
                return res.status(404).json({ success: false, message: "Ticket not found." });
            }
            return res.status(200).json({ success: true, data: updated });
        } catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }
    },

    async reply(req, res) {
        try {
            const { message } = req.body;
            if (!message?.trim()) {
                return res.status(400).json({ success: false, message: "Message cannot be empty." });
            }

            const result = await TicketService.addPlatformReply(req.params.id, req.user.user_id, message);
            if (!result) {
                return res.status(404).json({ success: false, message: "Ticket not found." });
            }
            return res.status(201).json({ success: true, data: result });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },
};

module.exports = TicketAdminController;
