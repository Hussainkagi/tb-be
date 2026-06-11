const db = require("../config/database");

// ─────────────────────────────────────────────────────────────────────────────
// NotificationTemplate
// Reusable message skeletons with {{mustache}} placeholders.
// company_id = NULL → global system template
// company_id = set  → company override of a global template
// ─────────────────────────────────────────────────────────────────────────────
const NotificationTemplate = {

    async create(data) {
        const {
            company_id = null,
            template_code,
            notification_type,
            channel = "push",
            title_template,
            body_template,
            deep_link_template = null,
        } = data;

        const result = await db.query(
            `INSERT INTO notification_templates (
                company_id, template_code, notification_type, channel,
                title_template, body_template, deep_link_template
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *`,
            [
                company_id, template_code, notification_type, channel,
                title_template, body_template, deep_link_template,
            ]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT * FROM notification_templates
             WHERE id = $1 AND deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    },

    // Resolve template for a company: prefer company override, fall back to global
    async findByCode(template_code, channel, company_id = null) {
        const result = await db.query(
            `SELECT * FROM notification_templates
             WHERE template_code = $1
               AND channel       = $2
               AND deleted_at   IS NULL
               AND is_active     = TRUE
               AND (company_id = $3 OR company_id IS NULL)
             ORDER BY
               -- Company-specific override wins over global (NULL) template
               CASE WHEN company_id IS NOT NULL THEN 0 ELSE 1 END
             LIMIT 1`,
            [template_code, channel, company_id]
        );
        return result.rows[0];
    },

    async getAllByCompany(company_id) {
        const result = await db.query(
            `SELECT * FROM notification_templates
             WHERE (company_id = $1 OR company_id IS NULL)
               AND deleted_at IS NULL
             ORDER BY template_code, channel`,
            [company_id]
        );
        return result.rows;
    },

    async update(id, data) {
        const updates = [];
        const values = [];
        let paramCount = 1;

        for (const [key, value] of Object.entries(data)) {
            updates.push(`${key} = $${paramCount}`);
            values.push(value);
            paramCount++;
        }

        values.push(id);
        const result = await db.query(
            `UPDATE notification_templates
             SET ${updates.join(", ")}
             WHERE id = $${paramCount} AND deleted_at IS NULL
             RETURNING *`,
            values
        );
        return result.rows[0];
    },

    async delete(id) {
        const result = await db.query(
            `UPDATE notification_templates
             SET deleted_at = NOW()
             WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },
};


// ─────────────────────────────────────────────────────────────────────────────
// Notification
// One row per notification "event" / intent.
// A single row fans out to many notification_recipients.
// ─────────────────────────────────────────────────────────────────────────────
const Notification = {

    async create(data) {
        const {
            company_id,
            branch_id = null,
            created_by_user_id = null,
            notification_type,
            channel = "push",
            template_id = null,
            title,
            body,
            deep_link = null,
            entity_type = null,
            entity_id = null,
            scheduled_at = null,  // NULL = send immediately
            timezone = "UTC",
            delivery_window_start = null,
            delivery_window_end = null,
            recurrence_cron = null,
            recurrence_end_at = null,
        } = data;

        const result = await db.query(
            `INSERT INTO notifications (
                company_id, branch_id, created_by_user_id,
                notification_type, channel, template_id,
                title, body, deep_link,
                entity_type, entity_id,
                scheduled_at, timezone,
                delivery_window_start, delivery_window_end,
                recurrence_cron, recurrence_end_at
            ) VALUES (
                $1,  $2,  $3,
                $4,  $5,  $6,
                $7,  $8,  $9,
                $10, $11,
                $12, $13,
                $14, $15,
                $16, $17
            ) RETURNING *`,
            [
                company_id, branch_id, created_by_user_id,
                notification_type, channel, template_id,
                title, body, deep_link,
                entity_type, entity_id,
                scheduled_at, timezone,
                delivery_window_start, delivery_window_end,
                recurrence_cron, recurrence_end_at,
            ]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT
                n.*,
                nt.template_code,
                nt.title_template,
                nt.body_template
             FROM notifications n
             LEFT JOIN notification_templates nt ON n.template_id = nt.id
             WHERE n.id = $1 AND n.deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    },

    async getAllByCompany(company_id, { limit = 50, offset = 0 } = {}) {
        const result = await db.query(
            `SELECT * FROM notifications
             WHERE company_id = $1 AND deleted_at IS NULL
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [company_id, limit, offset]
        );
        return result.rows;
    },

    // Scheduler polling — queued notifications due for dispatch
    async getDispatchQueue() {
        const result = await db.query(
            `SELECT * FROM notifications
             WHERE dispatch_status = 'queued'
               AND deleted_at IS NULL
               AND is_active = TRUE
               AND (scheduled_at IS NULL OR scheduled_at <= NOW())
             ORDER BY scheduled_at ASC NULLS FIRST`
        );
        return result.rows;
    },

    // Fetch all active recurring notifications (cron-driven reminders)
    async getRecurring() {
        const result = await db.query(
            `SELECT * FROM notifications
             WHERE recurrence_cron IS NOT NULL
               AND deleted_at IS NULL
               AND is_active = TRUE
               AND (recurrence_end_at IS NULL OR recurrence_end_at > NOW())`
        );
        return result.rows;
    },

    // All notifications linked to a triggering entity
    // e.g. all notifications fired by leave_request #XYZ
    async findByEntity(entity_type, entity_id) {
        const result = await db.query(
            `SELECT * FROM notifications
             WHERE entity_type = $1 AND entity_id = $2 AND deleted_at IS NULL
             ORDER BY created_at DESC`,
            [entity_type, entity_id]
        );
        return result.rows;
    },

    async updateDispatchStatus(id, dispatch_status, dispatched_at = null) {
        const result = await db.query(
            `UPDATE notifications
             SET dispatch_status = $1,
                 dispatched_at   = $2
             WHERE id = $3 AND deleted_at IS NULL
             RETURNING *`,
            [dispatch_status, dispatched_at, id]
        );
        return result.rows[0];
    },

    async cancel(id, cancellation_reason = null) {
        const result = await db.query(
            `UPDATE notifications
             SET dispatch_status     = 'cancelled',
                 cancelled_at        = NOW(),
                 cancellation_reason = $2
             WHERE id = $1 AND deleted_at IS NULL
             RETURNING *`,
            [id, cancellation_reason]
        );
        return result.rows[0];
    },

    async delete(id) {
        const result = await db.query(
            `UPDATE notifications SET deleted_at = NOW() WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },
};


// ─────────────────────────────────────────────────────────────────────────────
// NotificationAudienceRule
// Defines WHO receives a notification — resolved by the fan-out worker
// into individual notification_recipients rows.
// ─────────────────────────────────────────────────────────────────────────────
const NotificationAudienceRule = {

    async create(data) {
        const {
            notification_id,
            audience_type,
            target_branch_id = null,
            target_employee_id = null,
            target_role = null,
            target_department_id = null,
        } = data;

        const result = await db.query(
            `INSERT INTO notification_audience_rules (
                notification_id, audience_type,
                target_branch_id, target_employee_id,
                target_role, target_department_id
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *`,
            [
                notification_id, audience_type,
                target_branch_id, target_employee_id,
                target_role, target_department_id,
            ]
        );
        return result.rows[0];
    },

    async findByNotificationId(notification_id) {
        const result = await db.query(
            `SELECT * FROM notification_audience_rules
             WHERE notification_id = $1`,
            [notification_id]
        );
        return result.rows;
    },

    // Resolve audience rules → flat list of employee_ids for fan-out
    // Called by the dispatch worker before inserting notification_recipients
    async resolveEmployeeIds(notification_id, company_id) {
        const result = await db.query(
            `SELECT DISTINCT e.id AS employee_id
             FROM notification_audience_rules nar
             JOIN employees e
               ON e.company_id = $2
              AND e.deleted_at IS NULL
              AND e.is_active   = TRUE
             WHERE nar.notification_id = $1
               AND (
                   -- all_company: every active employee in the company
                   nar.audience_type = 'all_company'

                OR -- all_branch: every active employee in target branch
                   (nar.audience_type = 'all_branch'
                    AND e.branch_id = nar.target_branch_id)

                OR -- specific_employee: single named employee
                   (nar.audience_type = 'specific_employee'
                    AND e.id = nar.target_employee_id)

                OR -- role_based: employees whose user_companies.role matches
                   (nar.audience_type = 'role_based'
                    AND EXISTS (
                        SELECT 1 FROM user_companies uc
                        WHERE uc.user_id    = e.user_id
                          AND uc.company_id = e.company_id
                          AND uc.role::TEXT = nar.target_role
                          AND uc.deleted_at IS NULL
                    ))

                OR -- department: all employees in the target department
                   (nar.audience_type = 'department'
                    AND e.department_id = nar.target_department_id)
               )`,
            [notification_id, company_id]
        );
        return result.rows.map((r) => r.employee_id);
    },

    async deleteByNotificationId(notification_id) {
        const result = await db.query(
            `DELETE FROM notification_audience_rules
             WHERE notification_id = $1 RETURNING *`,
            [notification_id]
        );
        return result.rows;
    },
};


// ─────────────────────────────────────────────────────────────────────────────
// NotificationRecipient
// Per-employee per-channel delivery tracking row.
// Fan-out: one Notification → many NotificationRecipient rows.
// Lifecycle: pending → sent → delivered → read | failed | cancelled
// ─────────────────────────────────────────────────────────────────────────────
const NotificationRecipient = {

    async create(data) {
        const {
            notification_id,
            employee_id,
            company_id,
            channel = "push",
            device_token = null,
        } = data;

        const result = await db.query(
            `INSERT INTO notification_recipients (
                notification_id, employee_id, company_id, channel, device_token
            ) VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (notification_id, employee_id, channel) DO NOTHING
            RETURNING *`,
            [notification_id, employee_id, company_id, channel, device_token]
        );
        return result.rows[0];
    },

    // Bulk-insert recipients for a single notification (fan-out)
    async bulkCreate(rows) {
        if (!rows.length) return [];

        const values = [];
        const placeholders = rows.map((row, i) => {
            const base = i * 5;
            values.push(
                row.notification_id,
                row.employee_id,
                row.company_id,
                row.channel ?? "push",
                row.device_token ?? null
            );
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
        });

        const result = await db.query(
            `INSERT INTO notification_recipients
            (notification_id, employee_id, company_id, channel, device_token)
            VALUES ${placeholders.join(", ")}
            ON CONFLICT (notification_id, employee_id, channel) 
            DO UPDATE SET device_token = EXCLUDED.device_token
            RETURNING *`,
            values
        );
        return result.rows;
    },

    async findById(id) {
        const result = await db.query(
            `SELECT nr.*, n.title, n.body, n.deep_link, n.notification_type
             FROM notification_recipients nr
             JOIN notifications n ON nr.notification_id = n.id
             WHERE nr.id = $1`,
            [id]
        );
        return result.rows[0];
    },

    // Employee notification inbox (mobile app / web bell icon)
    async getInboxByEmployee(employee_id, { limit = 30, offset = 0 } = {}) {
        const result = await db.query(
            `SELECT
                nr.id,
                nr.status,
                nr.read_at,
                nr.created_at,
                n.title,
                n.body,
                n.deep_link,
                n.notification_type,
                n.entity_type,
                n.entity_id
             FROM notification_recipients nr
             JOIN notifications n ON nr.notification_id = n.id
             WHERE nr.employee_id = $1
               AND nr.status     != 'cancelled'
             ORDER BY nr.created_at DESC
             LIMIT $2 OFFSET $3`,
            [employee_id, limit, offset]
        );
        return result.rows;
    },

    // Unread count for the bell-icon badge
    async getUnreadCount(employee_id) {
        const result = await db.query(
            `SELECT COUNT(*) AS unread_count
             FROM notification_recipients
             WHERE employee_id = $1
               AND read_at     IS NULL
               AND status      IN ('sent', 'delivered')`,
            [employee_id]
        );
        return parseInt(result.rows[0].unread_count, 10);
    },

    // Worker polling — pending deliveries ready to dispatch
    async getPendingQueue({ limit = 100 } = {}) {
        const result = await db.query(
            `SELECT * FROM notification_recipients
             WHERE status = 'pending'
             ORDER BY created_at ASC
             LIMIT $1`,
            [limit]
        );
        return result.rows;
    },

    // Retry queue — failed deliveries whose next_retry_at has passed
    async getRetryQueue({ limit = 50 } = {}) {
        const result = await db.query(
            `SELECT * FROM notification_recipients
             WHERE status        = 'failed'
               AND next_retry_at IS NOT NULL
               AND next_retry_at <= NOW()
             ORDER BY next_retry_at ASC
             LIMIT $1`,
            [limit]
        );
        return result.rows;
    },

    async markAsSent(id, device_token = null) {
        const result = await db.query(
            `UPDATE notification_recipients
             SET status       = 'sent',
                 sent_at      = NOW(),
                 device_token = COALESCE($2, device_token)
             WHERE id = $1 RETURNING *`,
            [id, device_token]
        );
        return result.rows[0];
    },

    async markAsDelivered(id) {
        const result = await db.query(
            `UPDATE notification_recipients
             SET status = 'delivered', delivered_at = NOW()
             WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    async markAsRead(id) {
        const result = await db.query(
            `UPDATE notification_recipients
             SET status = 'read', read_at = NOW()
             WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    // Mark ALL unread as read for an employee (mark-all-read button)
    async markAllAsRead(employee_id) {
        const result = await db.query(
            `UPDATE notification_recipients
             SET status = 'read', read_at = NOW()
             WHERE employee_id = $1
               AND read_at     IS NULL
               AND status      IN ('sent', 'delivered')
             RETURNING *`,
            [employee_id]
        );
        return result.rows;
    },

    async markAsFailed(id, failure_reason, next_retry_at = null) {
        const result = await db.query(
            `UPDATE notification_recipients
             SET status         = 'failed',
                 failed_at      = NOW(),
                 failure_reason = $2,
                 retry_count    = retry_count + 1,
                 next_retry_at  = $3
             WHERE id = $1 RETURNING *`,
            [id, failure_reason, next_retry_at]
        );
        return result.rows[0];
    },

    async cancel(id) {
        const result = await db.query(
            `UPDATE notification_recipients
             SET status = 'cancelled'
             WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    // Cancel all pending recipients when a notification is cancelled
    async cancelAllPendingByNotification(notification_id) {
        const result = await db.query(
            `UPDATE notification_recipients
             SET status = 'cancelled'
             WHERE notification_id = $1 AND status = 'pending'
             RETURNING *`,
            [notification_id]
        );
        return result.rows;
    },
};


// ─────────────────────────────────────────────────────────────────────────────
// EmployeeDeviceToken
// FCM / APNs push tokens — one row per device per employee.
// Upserted on every app login; old tokens deactivated, never deleted.
// ─────────────────────────────────────────────────────────────────────────────
const EmployeeDeviceToken = {

    // Upsert: insert on first login, update token on subsequent logins
    async upsert(data) {
        const {
            employee_id,
            company_id,
            platform,
            device_id,
            push_token,
            app_version = null,
        } = data;

        const result = await db.query(
            `INSERT INTO employee_device_tokens
                (employee_id, company_id, platform, device_id, push_token, app_version, last_used_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (employee_id, device_id)
             DO UPDATE SET
                push_token   = EXCLUDED.push_token,
                app_version  = EXCLUDED.app_version,
                is_active    = TRUE,
                last_used_at = NOW()
             RETURNING *`,
            [employee_id, company_id, platform, device_id, push_token, app_version]
        );
        return result.rows[0];
    },

    // All active tokens for a single employee (may have multiple devices)
    async findActiveByEmployee(employee_id) {
        const result = await db.query(
            `SELECT * FROM employee_device_tokens
             WHERE employee_id = $1 AND is_active = TRUE
             ORDER BY last_used_at DESC`,
            [employee_id]
        );
        return result.rows;
    },

    // Active tokens for a batch of employees (used by fan-out worker)
    async findActiveByEmployeeIds(employee_ids) {
        if (!employee_ids.length) return [];
        const result = await db.query(
            `SELECT * FROM employee_device_tokens
             WHERE employee_id = ANY($1::uuid[]) AND is_active = TRUE`,
            [employee_ids]
        );
        return result.rows;
    },

    // Deactivate a specific token (FCM returns invalid-registration error)
    async deactivateByToken(push_token) {
        const result = await db.query(
            `UPDATE employee_device_tokens
             SET is_active = FALSE
             WHERE push_token = $1 RETURNING *`,
            [push_token]
        );
        return result.rows[0];
    },

    // Deactivate all tokens for a device (employee logs out)
    async deactivateByDevice(employee_id, device_id) {
        const result = await db.query(
            `UPDATE employee_device_tokens
             SET is_active = FALSE
             WHERE employee_id = $1 AND device_id = $2 RETURNING *`,
            [employee_id, device_id]
        );
        return result.rows[0];
    },
};


// ─────────────────────────────────────────────────────────────────────────────
// NotificationPreference
// Per-employee opt-in/out per notification_type per channel.
// Absence of a row = opted in (default behaviour).
// ─────────────────────────────────────────────────────────────────────────────
const NotificationPreference = {

    // Upsert: create on first change, update on subsequent changes
    async upsert(data) {
        const {
            employee_id,
            company_id,
            notification_type,
            channel = "push",
            is_enabled = true,
            quiet_hours_start = null,
            quiet_hours_end = null,
        } = data;

        const result = await db.query(
            `INSERT INTO notification_preferences
                (employee_id, company_id, notification_type, channel,
                 is_enabled, quiet_hours_start, quiet_hours_end)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (employee_id, notification_type, channel)
             DO UPDATE SET
                is_enabled        = EXCLUDED.is_enabled,
                quiet_hours_start = EXCLUDED.quiet_hours_start,
                quiet_hours_end   = EXCLUDED.quiet_hours_end,
                updated_at        = NOW()
             RETURNING *`,
            [
                employee_id, company_id, notification_type, channel,
                is_enabled, quiet_hours_start, quiet_hours_end,
            ]
        );
        return result.rows[0];
    },

    async findByEmployee(employee_id) {
        const result = await db.query(
            `SELECT * FROM notification_preferences
             WHERE employee_id = $1
             ORDER BY notification_type, channel`,
            [employee_id]
        );
        return result.rows;
    },

    // Check one preference before dispatching
    // Returns is_enabled: true when no row exists (opt-in by default)
    async isEnabled(employee_id, notification_type, channel = "push") {
        const result = await db.query(
            `SELECT is_enabled, quiet_hours_start, quiet_hours_end
             FROM notification_preferences
             WHERE employee_id       = $1
               AND notification_type = $2
               AND channel           = $3`,
            [employee_id, notification_type, channel]
        );
        if (!result.rows[0]) {
            return { is_enabled: true, quiet_hours_start: null, quiet_hours_end: null };
        }
        return result.rows[0];
    },

    // Bulk-fetch preferences for multiple employees (used by fan-out worker)
    async findByEmployeeIds(employee_ids, notification_type, channel = "push") {
        if (!employee_ids.length) return [];
        const result = await db.query(
            `SELECT employee_id, is_enabled, quiet_hours_start, quiet_hours_end
             FROM notification_preferences
             WHERE employee_id       = ANY($1::uuid[])
               AND notification_type = $2
               AND channel           = $3`,
            [employee_ids, notification_type, channel]
        );
        return result.rows;
    },
};


module.exports = {
    NotificationTemplate,
    Notification,
    NotificationAudienceRule,
    NotificationRecipient,
    EmployeeDeviceToken,
    NotificationPreference,
};