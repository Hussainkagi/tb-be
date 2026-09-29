-- ============================================================
-- HRMS Support Tickets Module
-- ============================================================
--
-- A company admin raises a ticket against the platform (Ikration), Ikration
-- staff work it from the Super Admin panel, and both sides can reply. Two
-- tables:
--
--   support_tickets           the ticket itself — subject, description,
--                              priority, status, up to 3 attached images.
--
--   support_ticket_messages   the unified timeline. A reply and a status
--                              change are both just a row here, distinguished
--                              by message_type — that is what lets the UI
--                              render one chronological thread instead of
--                              stitching a status history together with a
--                              separate comments list.
--
-- Not plan-gated: every company, including Trial, can reach support.
-- ============================================================


-- ------------------------------------------------------------
-- 1. SUPPORT TICKETS
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS support_tickets (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    company_id      UUID            NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    raised_by       UUID            NOT NULL REFERENCES users(id)     ON DELETE SET NULL,

    subject         VARCHAR(200)    NOT NULL,
    description     TEXT            NOT NULL,

    priority        VARCHAR(20)     NOT NULL DEFAULT 'medium',
    status          VARCHAR(20)     NOT NULL DEFAULT 'open',

    -- Cloudinary URLs, max 3 — the cap is enforced at the upload layer
    -- (multer), not here; the column just holds whatever came through.
    images          JSONB           NOT NULL DEFAULT '[]'::JSONB,

    resolved_at     TIMESTAMP,

    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_ticket_priority
        CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    CONSTRAINT chk_ticket_status
        CHECK (status IN ('open', 'in_progress', 'resolved', 'closed'))
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_company
    ON support_tickets(company_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status
    ON support_tickets(status, created_at DESC);

DROP TRIGGER IF EXISTS trg_support_tickets_updated_at ON support_tickets;
CREATE TRIGGER trg_support_tickets_updated_at
    BEFORE UPDATE ON support_tickets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ------------------------------------------------------------
-- 2. TICKET TIMELINE — replies + status changes, one ordered feed
-- ------------------------------------------------------------

CREATE TABLE IF NOT EXISTS support_ticket_messages (
    id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),

    ticket_id       UUID            NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,

    message_type    VARCHAR(20)     NOT NULL DEFAULT 'reply',   -- reply | status_change
    sender_type     VARCHAR(20)     NOT NULL,                   -- company | platform
    sender_user_id  UUID            REFERENCES users(id) ON DELETE SET NULL,

    message         TEXT,
    -- status_change rows carry {"from_status": "...", "to_status": "..."};
    -- reply rows leave this null.
    metadata        JSONB,

    created_at      TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT chk_ticket_message_type
        CHECK (message_type IN ('reply', 'status_change')),
    CONSTRAINT chk_ticket_message_sender
        CHECK (sender_type IN ('company', 'platform'))
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket
    ON support_ticket_messages(ticket_id, created_at ASC);
