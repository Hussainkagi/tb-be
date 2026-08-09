const { AdminInbox } = require("../models/notificationModel");
const EmployeeModel = require("../models/employeeModel");

/**
 * Company-admin inbox.
 *
 * The employee inbox (`/notifications/inbox/:employee_id`) is a firehose:
 * shift reminders, holiday announcements, leave decisions. An admin opening
 * the panel does not want their own check-in reminder — they want the things
 * only they can resolve.
 *
 * So this is the same recipients table, narrowed to admin-actionable types,
 * deduplicated across devices, and joined to each entity's CURRENT state so a
 * leave request that was already approved is never presented as pending.
 *
 * It is deliberately NOT a second copy of the dashboard's warnings. Warnings
 * are derived from live state ("3 employees have no salary structure") and are
 * always true until fixed. This is an event log — things that happened, in
 * order, with a read state. Use both: the dashboard for what is wrong, the
 * inbox for what came in.
 */

// Types an admin is expected to act on or care about. Everything else in the
// recipients table (attendance reminders, leave decisions on their own
// requests, holiday announcements) belongs to their employee inbox, not here.
const ADMIN_INBOX_TYPES = Object.freeze([
    "leave_request",     // an employee applied — needs a decision
    "holiday_request",   // an employee asked for a day off — needs a decision
    "custom",            // an ad-hoc message addressed to them
    "system",            // platform/system notices
]);

// Which of those actually block someone until the admin responds.
const ACTIONABLE_TYPES = Object.freeze(["leave_request", "holiday_request"]);

const num = (v) => (v === null || v === undefined ? 0 : Number(v) || 0);

const isUuid = (v) =>
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Resolve the caller's employee row.
 *
 * The JWT carries user_id + company_id, but notification_recipients is keyed
 * on employee_id — an admin only has an inbox if they also exist as an
 * employee of the company. That is a real state (an owner account created
 * without an employee profile), so it gets an explicit, non-500 answer.
 */
async function resolveAdminEmployee(user_id, company_id) {
    const employee = await EmployeeModel.findByUserAndCompany(user_id, company_id);
    if (!employee) {
        return {
            error:
                "No employee profile is linked to this admin account in this company, " +
                "so there is no inbox to read. Create an employee record for this user to receive notifications.",
        };
    }
    return { employee };
}

/** One inbox row, shaped for rendering. */
function shapeItem(row) {
    const item = {
        notification_id: row.notification_id,
        type: row.notification_type,
        title: row.title,
        body: row.body,
        deep_link: row.deep_link,

        is_read: row.is_read,
        read_at: row.read_at,
        received_at: row.received_at,
        channels: row.channels || [],

        // Whether the admin can still do something about it right now.
        is_actionable: row.is_actionable,
        // The entity behind the notification is gone — render as informational
        // history, never with an action button.
        is_orphaned: row.is_orphaned,

        entity: row.entity_type
            ? { type: row.entity_type, id: row.entity_id }
            : null,

        branch: row.branch_id ? { id: row.branch_id, name: row.branch_name } : null,
        employee: null,
        details: null,
    };

    if (row.entity_type === "leave_requests" && row.requester_id) {
        item.employee = {
            id: row.requester_id,
            employee_code: row.requester_code,
            name: `${row.requester_first_name} ${row.requester_last_name}`,
        };
        item.details = {
            leave_name: row.leave_name,
            status: row.leave_status,          // pending | approved | rejected | cancelled
            from_date: row.leave_from_date,
            to_date: row.leave_to_date,
            total_days: row.leave_total_days === null ? null : num(row.leave_total_days),
            is_half_day: row.leave_is_half_day,
            reason: row.leave_reason,
        };
    }

    return item;
}

const AdminInboxService = {

    /**
     * GET the inbox.
     *
     * Ordering comes from the model: still-actionable first, then unread, then
     * newest. Render in the order given.
     */
    async getInbox({
        userId,
        companyId,
        unreadOnly = false,
        actionableOnly = false,
        notificationType = null,
        page = 1,
        limit = 30,
    }) {
        if (notificationType && !ADMIN_INBOX_TYPES.includes(notificationType)) {
            return {
                success: false,
                message: `type must be one of: ${ADMIN_INBOX_TYPES.join(", ")}`,
            };
        }

        const { employee, error } = await resolveAdminEmployee(userId, companyId);
        if (error) return { success: false, message: error, code: "NO_EMPLOYEE_PROFILE" };

        const offset = (page - 1) * limit;

        const [rows, counts] = await Promise.all([
            AdminInbox.list(employee.id, companyId, {
                types: ADMIN_INBOX_TYPES,
                unread_only: unreadOnly,
                actionable_only: actionableOnly,
                notification_type: notificationType,
                limit,
                offset,
            }),
            AdminInbox.counts(employee.id, companyId, ADMIN_INBOX_TYPES),
        ]);

        const total = rows.length > 0 ? num(rows[0].total_count) : 0;

        return {
            success: true,
            data: {
                // Counts always describe the WHOLE inbox, not the filtered page,
                // so the badge does not change when a filter is applied.
                summary: {
                    total: num(counts.total),
                    unread: num(counts.unread),
                    actionable: num(counts.actionable),
                    unread_actionable: num(counts.unread_actionable),
                    by_type: counts.by_type || [],
                },
                filters: {
                    unread_only: unreadOnly,
                    actionable_only: actionableOnly,
                    type: notificationType,
                    allowed_types: ADMIN_INBOX_TYPES,
                    actionable_types: ACTIONABLE_TYPES,
                },
                items: rows.map(shapeItem),
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit) || 0,
                    hasNextPage: page * limit < total,
                    hasPrevPage: page > 1,
                },
            },
        };
    },

    /** Badge counts only — cheap enough to poll. */
    async getUnreadCount({ userId, companyId }) {
        const { employee, error } = await resolveAdminEmployee(userId, companyId);
        if (error) return { success: false, message: error, code: "NO_EMPLOYEE_PROFILE" };

        const counts = await AdminInbox.counts(employee.id, companyId, ADMIN_INBOX_TYPES);

        return {
            success: true,
            data: {
                total: num(counts.total),
                unread: num(counts.unread),
                actionable: num(counts.actionable),
                unread_actionable: num(counts.unread_actionable),
                by_type: counts.by_type || [],
            },
        };
    },

    /** Mark one notification read across every device the admin uses. */
    async markRead({ userId, companyId, notificationId }) {
        if (!isUuid(notificationId)) {
            return { success: false, message: "notificationId must be a valid UUID" };
        }

        const { employee, error } = await resolveAdminEmployee(userId, companyId);
        if (error) return { success: false, message: error, code: "NO_EMPLOYEE_PROFILE" };

        const updated = await AdminInbox.markRead(employee.id, companyId, notificationId);

        // Re-marking an already-read item is a no-op that still matches rows,
        // so it stays successful — only a notification that is not in this
        // admin's inbox at all reaches zero.
        if (updated === 0) {
            return {
                success: false,
                message: "Notification not found in this inbox",
                code: "NOT_FOUND",
            };
        }

        return { success: true, data: { notification_id: notificationId, rows_updated: updated } };
    },

    /** Mark the whole admin inbox read — never touches their employee notifications. */
    async markAllRead({ userId, companyId }) {
        const { employee, error } = await resolveAdminEmployee(userId, companyId);
        if (error) return { success: false, message: error, code: "NO_EMPLOYEE_PROFILE" };

        const updated = await AdminInbox.markAllRead(employee.id, companyId, ADMIN_INBOX_TYPES);

        return { success: true, data: { rows_updated: updated } };
    },
};

module.exports = {
    ...AdminInboxService,
    ADMIN_INBOX_TYPES,
    ACTIONABLE_TYPES,
};
