const {
    NotificationTemplate,
    Notification,
    NotificationAudienceRule,
    NotificationRecipient,
    EmployeeDeviceToken,
    NotificationPreference,
} = require("../models/notificationModel");
const expoPushSender = require("../utils/expoPushSender");
const db = require("../config/database")

// ─────────────────────────────────────────────────────────────────────────────
// Helper: resolve {{mustache}} placeholders in a template string
// e.g. resolvePlaceholders("Hello {{name}}", { name: "John" }) → "Hello John"
// ─────────────────────────────────────────────────────────────────────────────
const resolvePlaceholders = (template = "", variables = {}) => {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
        variables[key] !== undefined ? variables[key] : `{{${key}}}`
    );
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper: check if current UTC time falls within the delivery window
// delivery_window_start / end are stored as TIME in the notification's timezone
// For simplicity the worker passes in already-converted local time strings.
// ─────────────────────────────────────────────────────────────────────────────
const isWithinDeliveryWindow = (windowStart, windowEnd) => {
    if (!windowStart || !windowEnd) return true; // no window = always allowed

    const now = new Date();
    const hhmm = now.toTimeString().slice(0, 5); // "HH:MM"
    return hhmm >= windowStart && hhmm <= windowEnd;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper: does this Expo send error mean the token is permanently dead?
// "expo/unknown" is expoPushSender's fallback code for ANY unrecognized
// error (rate limiting, oversized payload, transient Expo API failures,
// etc.) — it must NOT be treated as an invalid token, or a single transient
// hiccup permanently deactivates a perfectly working device.
// ─────────────────────────────────────────────────────────────────────────────
const isInvalidTokenError = (err) =>
    err.code === "messaging/invalid-registration-token" ||
    err.code === "messaging/registration-token-not-registered" ||
    err.code === "DeviceNotRegistered" ||
    err.code === "InvalidCredentials";

// ─────────────────────────────────────────────────────────────────────────────
// Helper: validate an `audience` object before any DB writes happen.
// Without this, a malformed payload (e.g. all_branch with no branch_id)
// silently created a notification that resolved to zero recipients instead
// of failing loudly — send() would report "success" for a message nobody
// ever received.
// ─────────────────────────────────────────────────────────────────────────────
const VALID_AUDIENCE_TYPES = [
    "all_company",
    "all_branch",
    "specific_employee",
    "specific_employees",
    "role_based",
    "department",
];
const MAX_SPECIFIC_EMPLOYEES = 500;

const validateAudience = (audience) => {
    if (!audience || !audience.type) return "audience.type is required";
    if (!VALID_AUDIENCE_TYPES.includes(audience.type)) {
        return `audience.type must be one of: ${VALID_AUDIENCE_TYPES.join(", ")}`;
    }
    switch (audience.type) {
        case "all_branch":
            if (!audience.branch_id) return "audience.branch_id is required when audience.type is 'all_branch'";
            break;
        case "specific_employee":
            if (!audience.employee_id) return "audience.employee_id is required when audience.type is 'specific_employee'";
            break;
        case "specific_employees":
            if (!Array.isArray(audience.employee_ids) || audience.employee_ids.length === 0) {
                return "audience.employee_ids must be a non-empty array when audience.type is 'specific_employees'";
            }
            if (audience.employee_ids.length > MAX_SPECIFIC_EMPLOYEES) {
                return `audience.employee_ids cannot exceed ${MAX_SPECIFIC_EMPLOYEES} entries — use audience.type 'all_company'/'all_branch'/'department'/'role_based' for larger targeting`;
            }
            break;
        case "role_based":
            if (!audience.role) return "audience.role is required when audience.type is 'role_based'";
            break;
        case "department":
            if (!audience.department_id) return "audience.department_id is required when audience.type is 'department'";
            break;
    }
    return null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper: turn one `audience` object into one-or-more notification_audience_rules
// rows. 'specific_employees' is an application-level convenience type — it
// fans out to one 'specific_employee' row per employee_id (a DB value that
// already exists), so no schema/constraint change is needed to support it.
// ─────────────────────────────────────────────────────────────────────────────
const buildAudienceRuleRows = (notification_id, audience) => {
    if (audience.type === "specific_employees") {
        return audience.employee_ids.map((employee_id) => ({
            notification_id,
            audience_type: "specific_employee",
            target_branch_id: null,
            target_employee_id: employee_id,
            target_role: null,
            target_department_id: null,
        }));
    }
    return [{
        notification_id,
        audience_type: audience.type,
        target_branch_id: audience.branch_id || null,
        target_employee_id: audience.employee_id || null,
        target_role: audience.role || null,
        target_department_id: audience.department_id || null,
    }];
};


const NotificationService = {

    // ─────────────────────────────────────────────────────────────────────────
    // TEMPLATES
    // ─────────────────────────────────────────────────────────────────────────

    async createTemplate(data) {
        try {
            const result = await NotificationTemplate.create(data);
            return { success: true, message: "Template created successfully", data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getTemplateById(id) {
        try {
            const result = await NotificationTemplate.findById(id);
            if (!result) return { success: false, message: "Template not found" };
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getTemplatesByCompany(company_id) {
        try {
            const result = await NotificationTemplate.getAllByCompany(company_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async updateTemplate(id, data) {
        try {
            // Prevent changing the template_code after creation
            delete data.company_id;
            delete data.template_code;

            const result = await NotificationTemplate.update(id, data);
            if (!result) return { success: false, message: "Template not found" };
            return { success: true, message: "Template updated successfully", data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deleteTemplate(id) {
        try {
            const result = await NotificationTemplate.delete(id);
            if (!result) return { success: false, message: "Template not found" };
            return { success: true, message: "Template deleted successfully", data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },


    // ─────────────────────────────────────────────────────────────────────────
    // CORE: Send a notification
    //
    // This is the single entry point for ALL notification types.
    // Steps:
    //   1. Optionally resolve a template and substitute variables
    //   2. Insert into notifications
    //   3. Insert audience rule(s)
    //   4. If immediate (no scheduled_at) → fan out to recipients right away
    //      If scheduled  → dispatcher cron will pick it up later
    //
    // data = {
    //   company_id, branch_id?,
    //   created_by_user_id?,
    //   notification_type, channel?,
    //   template_code?,          // if provided, template is resolved automatically
    //   template_variables?,     // { employee_name, leave_type, ... }
    //   title?, body?,           // used when no template_code is given (custom)
    //   deep_link?,
    //   entity_type?, entity_id?,
    //   scheduled_at?,           // NULL = send immediately
    //   timezone?,
    //   delivery_window_start?, delivery_window_end?,
    //   recurrence_cron?, recurrence_end_at?,
    //   audience: {
    //     type: 'all_company' | 'all_branch' | 'specific_employee' | 'specific_employees'
    //         | 'role_based' | 'department'
    //     branch_id?,          // required for 'all_branch'
    //     employee_id?,        // required for 'specific_employee'
    //     employee_ids?,       // required for 'specific_employees' (array, max 500)
    //     role?,               // required for 'role_based' — Role enum value as a string: "0" admin | "1" manager | "2" employee
    //     department_id?,      // required for 'department'
    //   }
    // }
    // ─────────────────────────────────────────────────────────────────────────
    async send(data) {
        try {
            const {
                company_id,
                branch_id = null,
                created_by_user_id = null,
                notification_type,
                channel = "push",
                template_code = null,
                template_variables = {},
                entity_type = null,
                entity_id = null,
                scheduled_at = null,
                timezone = "UTC",
                delivery_window_start = null,
                delivery_window_end = null,
                recurrence_cron = null,
                recurrence_end_at = null,
                audience,
            } = data;

            const audienceError = validateAudience(audience);
            if (audienceError) {
                return { success: false, message: audienceError };
            }

            // ── Step 1: Resolve template (if template_code provided) ───────
            let title = data.title || "";
            let body = data.body || "";
            let deep_link = data.deep_link || null;
            let template_id = null;

            if (template_code) {
                const template = await NotificationTemplate.findByCode(
                    template_code, channel, company_id
                );

                if (!template) {
                    return {
                        success: false,
                        message: `Template '${template_code}' not found for channel '${channel}'`,
                    };
                }

                template_id = template.id;
                title = resolvePlaceholders(template.title_template, template_variables);
                body = resolvePlaceholders(template.body_template, template_variables);
                deep_link = resolvePlaceholders(template.deep_link_template || "", template_variables) || null;
            }

            if (!title || !body) {
                return { success: false, message: "title and body are required when no template_code is provided" };
            }

            // ── Step 2: Insert notification row ───────────────────────────
            let notification;
            try {
                notification = await Notification.create({
                    company_id, branch_id, created_by_user_id,
                    notification_type, channel, template_id,
                    title, body, deep_link,
                    entity_type, entity_id,
                    scheduled_at, timezone,
                    delivery_window_start, delivery_window_end,
                    recurrence_cron, recurrence_end_at,
                });
            } catch (error) {
                // 23505 = unique_violation — e.g. uq_attendance_reminder_once_per_day.
                // A reminder for this employee/day already exists; treat as a
                // no-op instead of creating a duplicate notification.
                if (error.code === "23505") {
                    return {
                        success: true,
                        message: "Reminder already scheduled — skipped duplicate",
                        skipped: true,
                    };
                }
                throw error;
            }

            // ── Step 3: Insert audience rule(s) ─────────────────────────────
            // 'specific_employees' fans out to one row per employee_id
            const audienceRows = buildAudienceRuleRows(notification.id, audience);
            for (const row of audienceRows) {
                await NotificationAudienceRule.create(row);
            }

            // ── Step 4: Fan-out (only for immediate notifications) ─────────
            if (!scheduled_at) {
                await NotificationService._fanOut(notification, company_id);
            }

            return {
                success: true,
                message: scheduled_at
                    ? "Notification scheduled successfully"
                    : "Notification sent successfully",
                data: notification,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },


    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL: Fan-out a notification to individual recipients
    // Called by send() for immediate notifications, and by the
    // dispatch cron job for scheduled ones.
    // ─────────────────────────────────────────────────────────────────────────
    async _fanOut(notification, company_id) {
        try {
            // 1. Resolve employee_ids from audience rules
            const employeeIds = await NotificationAudienceRule.resolveEmployeeIds(
                notification.id, company_id
            );

            if (!employeeIds.length) return { success: true, recipients: 0 };

            // 2. Filter out employees who have opted out
            const preferences = await NotificationPreference.findByEmployeeIds(
                employeeIds, notification.notification_type, notification.channel
            );

            // Build a quick lookup: { employee_id → is_enabled }
            const prefMap = {};
            for (const pref of preferences) {
                prefMap[pref.employee_id] = pref.is_enabled;
            }

            // Employees with no preference row default to opted-in (true)
            const filteredIds = employeeIds.filter(
                (id) => prefMap[id] !== false
            );

            if (!filteredIds.length) return { success: true, recipients: 0 };

            // 3. Fetch active device tokens for all recipients in one query
            const deviceTokens = notification.channel === "push"
                ? await EmployeeDeviceToken.findActiveByEmployeeIds(filteredIds)
                : [];

            // Build lookup: { employee_id → [token, token, ...] }
            const tokenMap = {};
            for (const dt of deviceTokens) {
                if (!tokenMap[dt.employee_id]) tokenMap[dt.employee_id] = [];
                tokenMap[dt.employee_id].push(dt.push_token);
            }

            // 4. Build bulk-insert rows
            const recipientRows = [];
            for (const employee_id of filteredIds) {
                const tokens = tokenMap[employee_id];

                if (notification.channel === "push" && tokens?.length) {
                    // One recipient row per device token
                    for (const token of tokens) {
                        recipientRows.push({
                            notification_id: notification.id,
                            employee_id,
                            company_id,
                            channel: notification.channel,
                            device_token: token,
                        });
                    }
                } else if (notification.channel !== "push") {
                    // in_app / email / sms — no device token needed
                    recipientRows.push({
                        notification_id: notification.id,
                        employee_id,
                        company_id,
                        channel: notification.channel,
                        device_token: null,
                    });
                }
                // If push channel but no token → employee has no device registered; skip silently
            }

            // 5. Bulk-insert recipient rows
            const recipients = await NotificationRecipient.bulkCreate(recipientRows);

            // 6. Mark notification as dispatched
            if (notification.channel === "push") {
                for (const recipient of recipients) {
                    if (!recipient?.device_token) continue;
                    try {
                        await expoPushSender.send(
                            recipient.device_token,
                            notification.title,
                            notification.body,
                            {
                                notification_id: notification.id,
                                entity_type: notification.entity_type ?? "",
                                entity_id: notification.entity_id ?? "",
                                deep_link: notification.deep_link ?? "",
                            }
                        );
                        await NotificationRecipient.markAsSent(recipient.id, recipient.device_token);
                    } catch (err) {
                        console.error("[EXPO ERROR] code:", err.code, "| message:", err.message, "| token:", recipient.device_token?.slice(0, 20));

                        const isInvalidToken = isInvalidTokenError(err);

                        const MAX_RETRIES = 3;
                        const retryAt = isInvalidToken || recipient.retry_count >= MAX_RETRIES
                            ? null
                            : new Date(Date.now() + 5 * 60 * 1000).toISOString();

                        await NotificationRecipient.markAsFailed(recipient.id, err.message, retryAt);

                        if (isInvalidToken) {
                            await EmployeeDeviceToken.deactivateByToken(recipient.device_token);
                        }
                    }
                }
            } else {
                // in_app / email / sms — mark all as sent immediately
                for (const recipient of recipients) {
                    await NotificationRecipient.markAsSent(recipient.id);
                }
            }


            // 7. Mark notification as dispatched
            await Notification.updateDispatchStatus(
                notification.id, "dispatched", new Date()
            );

            return { success: true, recipients: recipients.length };
        } catch (error) {
            // Mark notification as partially failed — don't throw, let caller handle
            await Notification.updateDispatchStatus(notification.id, "partially_failed");
            return { success: false, message: error.message, error };
        }
    },


    // ─────────────────────────────────────────────────────────────────────────
    // SCHEDULER: Process queued / scheduled notifications
    // Called by your cron job (e.g. every minute)
    // ─────────────────────────────────────────────────────────────────────────
    async processDispatchQueue() {
        try {
            await db.query(`
                        UPDATE notifications
                        SET dispatch_status = 'queued'
                        WHERE dispatch_status = 'processing'
                        AND updated_at < NOW() - INTERVAL '10 minutes'
                        AND deleted_at IS NULL
                    `);
            const queue = await Notification.getDispatchQueue();
            const results = [];

            for (const notification of queue) {
                // Mark as processing to prevent duplicate dispatch
                await Notification.updateDispatchStatus(notification.id, "processing");

                const result = await NotificationService._fanOut(
                    notification, notification.company_id
                );
                results.push({ notification_id: notification.id, ...result });
            }

            return { success: true, processed: results.length, results };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },


    // ─────────────────────────────────────────────────────────────────────────
    // SCHEDULER: Retry failed push deliveries whose next_retry_at has passed
    // Previously dead code — NotificationRecipient.getRetryQueue() existed
    // but nothing ever called it, so failed sends (transient network errors,
    // Expo hiccups, etc.) were marked "failed" and never retried, even
    // though they still showed up in the employee's in-app inbox.
    // Called by the same per-minute cron as processDispatchQueue().
    // ─────────────────────────────────────────────────────────────────────────
    async processRetryQueue() {
        try {
            const queue = await NotificationRecipient.getRetryQueue();
            const results = [];

            for (const recipient of queue) {
                if (!recipient.device_token) continue;

                try {
                    await expoPushSender.send(
                        recipient.device_token,
                        recipient.title,
                        recipient.body,
                        {
                            notification_id: recipient.notification_id,
                            entity_type: recipient.entity_type ?? "",
                            entity_id: recipient.entity_id ?? "",
                            deep_link: recipient.deep_link ?? "",
                        }
                    );
                    await NotificationRecipient.markAsSent(recipient.id, recipient.device_token);
                    results.push({ recipient_id: recipient.id, success: true });
                } catch (err) {
                    const isInvalidToken = isInvalidTokenError(err);
                    const MAX_RETRIES = 3;
                    const retryAt = isInvalidToken || recipient.retry_count >= MAX_RETRIES
                        ? null
                        : new Date(Date.now() + 5 * 60 * 1000).toISOString();

                    await NotificationRecipient.markAsFailed(recipient.id, err.message, retryAt);

                    if (isInvalidToken) {
                        await EmployeeDeviceToken.deactivateByToken(recipient.device_token);
                    }
                    results.push({ recipient_id: recipient.id, success: false, message: err.message });
                }
            }

            return { success: true, processed: results.length, results };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },


    // ─────────────────────────────────────────────────────────────────────────
    // SCHEDULER: Schedule attendance check-in/out reminders for a given day
    //
    // Called daily by a cron job.
    // For each active employee with a shift, computes the local reminder time
    // (shift.start_time - grace_minutes) and creates a scheduled notification.
    //
    // employees = [{ id, shift_start_time, shift_end_time, timezone, company_id }]
    // ─────────────────────────────────────────────────────────────────────────
    async scheduleAttendanceReminders(employees = [], reminderMinutesBefore = 15) {
        try {
            const results = [];

            for (const emp of employees) {
                const tz = emp.timezone || "UTC";

                // ── Check-in reminder ─────────────────────────────────────
                // checkin_reminder_at is only ever a real future UTC ISO string
                // or null (the caller already collapsed "SKIP"/invalid times to
                // null). scheduled_at=null means "send immediately" to
                // NotificationService.send(), so a null reminder time must be
                // skipped entirely here rather than passed through — otherwise
                // employees with a past/invalid reminder time get an immediate
                // out-of-band push instead of no reminder at all.
                if (emp.shift_start_time && emp.checkin_reminder_at) {
                    const checkinResult = await NotificationService.send({
                        company_id: emp.company_id,
                        notification_type: "attendance_checkin_reminder",
                        channel: "push",
                        template_code: "attendance_checkin_reminder",
                        template_variables: {
                            shift_start_time: emp.shift_start_time,
                        },
                        timezone: tz,
                        // scheduled_at is computed by the caller using the employee's
                        // branch timezone — passed in as a UTC ISO string
                        scheduled_at: emp.checkin_reminder_at,
                        delivery_window_start: "06:00",
                        delivery_window_end: "22:00",
                        entity_type: "attendance_reminder",
                        entity_id: emp.id,
                        audience: {
                            type: "specific_employee",
                            employee_id: emp.id,
                        },
                    });
                    results.push({ type: "checkin", employee_id: emp.id, ...checkinResult });
                }

                // ── Check-out reminder ────────────────────────────────────
                if (emp.shift_end_time && emp.checkout_reminder_at) {
                    const checkoutResult = await NotificationService.send({
                        company_id: emp.company_id,
                        notification_type: "attendance_checkout_reminder",
                        channel: "push",
                        template_code: "attendance_checkout_reminder",
                        template_variables: {
                            shift_end_time: emp.shift_end_time,
                        },
                        timezone: tz,
                        scheduled_at: emp.checkout_reminder_at,
                        delivery_window_start: "06:00",
                        delivery_window_end: "22:00",
                        entity_type: "attendance_reminder",
                        entity_id: emp.id,
                        audience: {
                            type: "specific_employee",
                            employee_id: emp.id,
                        },
                    });
                    results.push({ type: "checkout", employee_id: emp.id, ...checkoutResult });
                }
            }

            return { success: true, scheduled: results.length, results };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },


    // ─────────────────────────────────────────────────────────────────────────
    // LEAVE: Notify admin/manager when employee submits a leave request
    // ─────────────────────────────────────────────────────────────────────────
    async notifyLeaveRequest({ company_id, branch_id, leave_id, employee_name, employee_code, leave_type, start_date, end_date }) {
        return NotificationService.send({
            company_id,
            branch_id,
            notification_type: "leave_request",
            channel: "push",
            template_code: "leave_request_submitted",
            template_variables: { employee_name, employee_code, leave_type, start_date, end_date, leave_id },
            entity_type: "leave_requests",
            entity_id: leave_id,
            audience: { type: "role_based", role: "admin" },
        });
    },


    // ─────────────────────────────────────────────────────────────────────────
    // LEAVE: Notify employee when their leave is approved or rejected
    // ─────────────────────────────────────────────────────────────────────────
    async notifyLeaveStatusUpdate({ company_id, employee_id, leave_id, status, leave_type, start_date, end_date, actioned_by, rejection_reason = null }) {
        const isApproved = status === "approved";
        const template_code = isApproved ? "leave_status_approved" : "leave_status_rejected";

        return NotificationService.send({
            company_id,
            notification_type: "leave_status_update",
            channel: "push",
            template_code,
            template_variables: {
                leave_type,
                start_date,
                end_date,
                leave_id,
                approved_by: isApproved ? actioned_by : undefined,
                rejected_by: isApproved ? undefined : actioned_by,
                rejection_reason: rejection_reason || "N/A",
            },
            entity_type: "leave_requests",
            entity_id: leave_id,
            audience: { type: "specific_employee", employee_id },
        });
    },


    // ─────────────────────────────────────────────────────────────────────────
    // HOLIDAY: Notify employees when a holiday is created
    // Scope: company-wide OR branch-specific depending on the holiday
    // ─────────────────────────────────────────────────────────────────────────
    async notifyHolidayCreated({ company_id, branch_id = null, holiday_id, holiday_name, holiday_date, is_company_wide }) {
        return NotificationService.send({
            company_id,
            branch_id: is_company_wide ? null : branch_id,
            notification_type: "holiday_created",
            channel: "push",
            template_code: "holiday_created",
            template_variables: { holiday_name, holiday_date, holiday_id },
            entity_type: "holidays",
            entity_id: holiday_id,
            // Audience: all_company for company-wide, all_branch for branch-scoped
            audience: is_company_wide
                ? { type: "all_company" }
                : { type: "all_branch", branch_id },
        });
    },


    // ─────────────────────────────────────────────────────────────────────────
    // HOLIDAY REQUEST: Notify admin when employee requests a holiday
    // ─────────────────────────────────────────────────────────────────────────
    async notifyHolidayRequest({ company_id, branch_id, request_id, employee_name, holiday_date }) {
        return NotificationService.send({
            company_id,
            branch_id,
            notification_type: "holiday_request",
            channel: "push",
            template_code: "holiday_request_submitted",
            template_variables: { employee_name, holiday_date, request_id },
            entity_type: "holiday_requests",
            entity_id: request_id,
            audience: { type: "role_based", role: "admin" },
        });
    },


    // ─────────────────────────────────────────────────────────────────────────
    // CUSTOM: Admin sends an ad-hoc notification (instant or scheduled)
    //
    // data = {
    //   company_id, branch_id?, created_by_user_id,
    //   title, body, deep_link?,
    //   scheduled_at?,           // NULL = instant
    //   timezone?,
    //   audience: { type, branch_id?, employee_id?, role?, department_id? }
    // }
    // ─────────────────────────────────────────────────────────────────────────
    async sendCustomNotification(data) {
        const {
            company_id,
            branch_id = null,
            created_by_user_id = null,
            title,
            body,
            deep_link = null,
            scheduled_at = null,
            timezone = "UTC",
            audience,
        } = data;

        if (!title || !body) {
            return { success: false, message: "title and body are required for custom notifications" };
        }
        if (!audience || !audience.type) {
            return { success: false, message: "audience.type is required" };
        }

        return NotificationService.send({
            company_id,
            branch_id,
            created_by_user_id,
            notification_type: "custom",
            channel: "push",
            title,
            body,
            deep_link,
            scheduled_at,
            timezone,
            audience,
        });
    },


    // ─────────────────────────────────────────────────────────────────────────
    // NOTIFICATIONS: Fetch & manage
    // ─────────────────────────────────────────────────────────────────────────

    async getNotificationById(id) {
        try {
            const result = await Notification.findById(id);
            if (!result) return { success: false, message: "Notification not found" };
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getNotificationsByCompany(company_id, { limit, offset } = {}) {
        try {
            const result = await Notification.getAllByCompany(company_id, { limit, offset });
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async cancelNotification(id, cancellation_reason = null) {
        try {
            const notification = await Notification.findById(id);
            if (!notification) return { success: false, message: "Notification not found" };

            if (notification.dispatch_status === "dispatched") {
                return { success: false, message: "Notification already dispatched and cannot be cancelled" };
            }

            // Cancel the notification itself
            const result = await Notification.cancel(id, cancellation_reason);

            // Cancel any pending recipient rows that haven't been dispatched yet
            await NotificationRecipient.cancelAllPendingByNotification(id);

            return { success: true, message: "Notification cancelled successfully", data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deleteNotification(id) {
        try {
            const result = await Notification.delete(id);
            if (!result) return { success: false, message: "Notification not found" };
            return { success: true, message: "Notification deleted successfully", data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },


    // ─────────────────────────────────────────────────────────────────────────
    // INBOX: Employee notification inbox (mobile app / web bell icon)
    // ─────────────────────────────────────────────────────────────────────────

    async getEmployeeInbox(employee_id, { limit, offset } = {}) {
        try {
            const [inbox, unreadCount] = await Promise.all([
                NotificationRecipient.getInboxByEmployee(employee_id, { limit, offset }),
                NotificationRecipient.getUnreadCount(employee_id),
            ]);
            return { success: true, data: { inbox, unread_count: unreadCount } };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async markAsRead(recipient_id) {
        try {
            const result = await NotificationRecipient.markAsRead(recipient_id);
            if (!result) return { success: false, message: "Notification not found" };
            return { success: true, message: "Notification marked as read", data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async markAllAsRead(employee_id) {
        try {
            const result = await NotificationRecipient.markAllAsRead(employee_id);
            return { success: true, message: "All notifications marked as read", data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getUnreadCount(employee_id) {
        try {
            const count = await NotificationRecipient.getUnreadCount(employee_id);
            return { success: true, data: { unread_count: count } };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },


    // ─────────────────────────────────────────────────────────────────────────
    // DEVICE TOKENS: Register / deactivate push tokens
    // ─────────────────────────────────────────────────────────────────────────

    async registerDeviceToken(data) {
        try {
            const result = await EmployeeDeviceToken.upsert(data);
            return { success: true, message: "Device token registered successfully", data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async deactivateDeviceToken(employee_id, device_id) {
        try {
            const result = await EmployeeDeviceToken.deactivateByDevice(employee_id, device_id);
            if (!result) return { success: false, message: "Device token not found" };
            return { success: true, message: "Device token deactivated successfully", data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // Tells the caller whether THIS device already has a token on file for
    // this employee, and whether it's currently active. registered=false
    // means the client should treat this as a brand-new device. This says
    // nothing about OS-level notification permission — that's client-only.
    async getDeviceTokenStatus(employee_id, device_id) {
        try {
            const token = await EmployeeDeviceToken.findByEmployeeAndDevice(employee_id, device_id);
            if (!token) {
                return { success: true, data: { registered: false } };
            }
            return {
                success: true,
                data: {
                    registered: true,
                    is_active: token.is_active,
                    platform: token.platform,
                    last_used_at: token.last_used_at,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },


    // ─────────────────────────────────────────────────────────────────────────
    // PREFERENCES: Employee notification opt-in/out
    // ─────────────────────────────────────────────────────────────────────────

    async upsertPreference(data) {
        try {
            const result = await NotificationPreference.upsert(data);
            return { success: true, message: "Preference updated successfully", data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async getPreferencesByEmployee(employee_id) {
        try {
            const result = await NotificationPreference.findByEmployee(employee_id);
            return { success: true, data: result };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = NotificationService;