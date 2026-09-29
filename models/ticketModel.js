const db = require("../config/database");

const TICKET_SELECT = `
    t.*,
    c.company_name,
    u.first_name AS raised_by_first_name,
    u.last_name  AS raised_by_last_name,
    u.email      AS raised_by_email
`;

const TicketModel = {
    async create({ company_id, raised_by, subject, description, priority }) {
        const result = await db.query(
            `INSERT INTO support_tickets (company_id, raised_by, subject, description, priority)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [company_id, raised_by, subject, description, priority]
        );
        return result.rows[0];
    },

    async updateImages(id, images) {
        const result = await db.query(
            `UPDATE support_tickets SET images = $2::jsonb WHERE id = $1 RETURNING *`,
            [id, JSON.stringify(images)]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT ${TICKET_SELECT}
             FROM support_tickets t
             JOIN companies c ON c.id = t.company_id
             LEFT JOIN users u ON u.id = t.raised_by
             WHERE t.id = $1`,
            [id]
        );
        return result.rows[0] || null;
    },

    async listByCompany(company_id, { status = null, priority = null } = {}) {
        const result = await db.query(
            `SELECT ${TICKET_SELECT}
             FROM support_tickets t
             JOIN companies c ON c.id = t.company_id
             LEFT JOIN users u ON u.id = t.raised_by
             WHERE t.company_id = $1
               AND ($2::text IS NULL OR t.status = $2)
               AND ($3::text IS NULL OR t.priority = $3)
             ORDER BY t.created_at DESC`,
            [company_id, status, priority]
        );
        return result.rows;
    },

    /** Platform-wide, paginated. */
    async listAll({ status = null, priority = null, company_id = null, search = null, page = 1, limit = 20 } = {}) {
        const values = [status, priority, company_id, search ? `%${search}%` : null];
        const offset = (Math.max(1, page) - 1) * limit;

        const where = `
            WHERE ($1::text IS NULL OR t.status = $1)
              AND ($2::text IS NULL OR t.priority = $2)
              AND ($3::uuid IS NULL OR t.company_id = $3)
              AND ($4::text IS NULL OR t.subject ILIKE $4)
        `;

        const countResult = await db.query(
            `SELECT COUNT(*) FROM support_tickets t ${where}`,
            values
        );

        const rowsResult = await db.query(
            `SELECT ${TICKET_SELECT}
             FROM support_tickets t
             JOIN companies c ON c.id = t.company_id
             LEFT JOIN users u ON u.id = t.raised_by
             ${where}
             ORDER BY t.created_at DESC
             LIMIT $5 OFFSET $6`,
            [...values, limit, offset]
        );

        const total = parseInt(countResult.rows[0].count, 10);
        return {
            data: rowsResult.rows,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.max(1, Math.ceil(total / limit)),
            },
        };
    },

    async updateStatus(id, status) {
        // $2 cast explicitly in both spots — used bare, Postgres infers two
        // different types for the same parameter (varchar column vs a text
        // literal list) and refuses to plan the query at all.
        const result = await db.query(
            `UPDATE support_tickets
             SET status = $2::varchar,
                 resolved_at = CASE WHEN $2::varchar IN ('resolved', 'closed') THEN NOW() ELSE resolved_at END
             WHERE id = $1
             RETURNING *`,
            [id, status]
        );
        return result.rows[0];
    },

    async addMessage({ ticket_id, message_type = "reply", sender_type, sender_user_id = null, message = null, metadata = null }) {
        const result = await db.query(
            `INSERT INTO support_ticket_messages
                (ticket_id, message_type, sender_type, sender_user_id, message, metadata)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             RETURNING *`,
            [ticket_id, message_type, sender_type, sender_user_id, message, metadata ? JSON.stringify(metadata) : null]
        );
        return result.rows[0];
    },

    async listMessages(ticket_id) {
        const result = await db.query(
            `SELECT m.*, u.first_name AS sender_first_name, u.last_name AS sender_last_name
             FROM support_ticket_messages m
             LEFT JOIN users u ON u.id = m.sender_user_id
             WHERE m.ticket_id = $1
             ORDER BY m.created_at ASC`,
            [ticket_id]
        );
        return result.rows;
    },
};

module.exports = TicketModel;
