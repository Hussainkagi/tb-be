const TicketService = require("../service/ticketService");

// Company-facing — everything here is scoped to req.params.company_id,
// already validated by validateTenant on the route.
const TicketController = {
    async create(req, res) {
        try {
            const { company_id } = req.params;
            const { subject, description, priority } = req.body;

            if (!subject?.trim() || !description?.trim()) {
                return res.status(400).json({ success: false, message: "Subject and description are required." });
            }

            const imageBuffers = (req.files || []).map((f) => f.buffer);

            const ticket = await TicketService.createTicket({
                company_id,
                raised_by: req.user.user_id,
                subject,
                description,
                priority,
                imageBuffers,
            });

            return res.status(201).json({ success: true, data: ticket });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async list(req, res) {
        try {
            const { company_id } = req.params;
            const { status, priority } = req.query;
            const tickets = await TicketService.listForCompany(company_id, {
                status: status || null,
                priority: priority || null,
            });
            return res.status(200).json({ success: true, data: tickets });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async getById(req, res) {
        try {
            const { company_id, id } = req.params;
            const result = await TicketService.getForCompany(id, company_id);
            if (!result) {
                return res.status(404).json({ success: false, message: "Ticket not found." });
            }
            return res.status(200).json({ success: true, data: result });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },

    async reply(req, res) {
        try {
            const { company_id, id } = req.params;
            const { message } = req.body;
            if (!message?.trim()) {
                return res.status(400).json({ success: false, message: "Message cannot be empty." });
            }

            const result = await TicketService.addCompanyReply(id, company_id, req.user.user_id, message);
            if (!result) {
                return res.status(404).json({ success: false, message: "Ticket not found." });
            }
            return res.status(201).json({ success: true, data: result });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Server error", error: error.message });
        }
    },
};

module.exports = TicketController;
