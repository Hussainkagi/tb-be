-- ============================================================
-- Ticket reference numbers
-- ============================================================
--
-- A UUID is fine for a URL but nobody types "4378ed01-cb58-4c30-9fcf-" into
-- an email reply or reads it out on a call. This adds a short, sequential,
-- human-readable code — TKT-000001, TKT-000002, ... — global across every
-- company, since platform staff reference tickets across tenants and a
-- per-company counter would make the same number mean different tickets to
-- different people.
-- ============================================================

CREATE SEQUENCE IF NOT EXISTS support_ticket_number_seq START 1;

ALTER TABLE support_tickets
    ADD COLUMN IF NOT EXISTS ticket_number VARCHAR(20);

-- Backfill any tickets that already exist, oldest first, before the column
-- becomes NOT NULL below.
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN SELECT id FROM support_tickets WHERE ticket_number IS NULL ORDER BY created_at ASC LOOP
        UPDATE support_tickets
        SET ticket_number = 'TKT-' || LPAD(nextval('support_ticket_number_seq')::text, 6, '0')
        WHERE id = r.id;
    END LOOP;
END $$;

ALTER TABLE support_tickets
    ALTER COLUMN ticket_number SET DEFAULT ('TKT-' || LPAD(nextval('support_ticket_number_seq')::text, 6, '0')),
    ALTER COLUMN ticket_number SET NOT NULL;

ALTER TABLE support_tickets
    DROP CONSTRAINT IF EXISTS uq_support_tickets_ticket_number;
ALTER TABLE support_tickets
    ADD CONSTRAINT uq_support_tickets_ticket_number UNIQUE (ticket_number);

CREATE INDEX IF NOT EXISTS idx_support_tickets_ticket_number
    ON support_tickets(ticket_number);
