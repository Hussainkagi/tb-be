const db = require("../config/database");
const AttendanceRequestModel = require("../models/attendanceRequestModel");
const AttendanceModel = require("../models/attendanceModel");
const EmployeeModel = require("../models/employeeModel");
const ShiftModel = require("../models/shiftModel");
const BranchLocationModel = require("../models/branchLocationModel");
const NotificationService = require("./notificationService");
const { checkGeofence } = require("../utils/geofence");
const { timeHelpers } = require("./attendanceService");

const { getTodayInTimezone, calculateAttendanceStatus, uploadSelfie } = timeHelpers;

const TYPES = ["check-in", "check-out"];
const ACTIONS = ["approve", "approve_half_day", "reject"];
const MAX_BATCH = 200;

const label = (type) => (type === "check-in" ? "check in" : "check out");

const timeIn = (date, timezone) => {
    try {
        return new Intl.DateTimeFormat("en-GB", {
            timeZone: timezone || "UTC", hour: "2-digit", minute: "2-digit",
        }).format(new Date(date));
    } catch {
        return new Date(date).toISOString().slice(11, 16);
    }
};

const AttendanceRequestService = {
    // ─────────────────────────────────────────────────────────────────────
    // EMPLOYEE: ask to be checked in / out from where they are
    // ─────────────────────────────────────────────────────────────────────
    async create(user_id, company_id, payload) {
        try {
            const { request_type, latitude, longitude, address = null, reason, selfie_file = null } = payload;

            if (!TYPES.includes(request_type)) {
                return { success: false, message: "request_type must be check-in or check-out" };
            }
            const lat = Number(latitude);
            const lng = Number(longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
                return { success: false, message: "Your location is required to send a request" };
            }
            const why = String(reason ?? "").trim();
            if (why.length < 3) {
                return { success: false, message: "Add a short reason so your admin can approve it" };
            }

            const employee = await EmployeeModel.findByUserAndCompany(user_id, company_id);
            if (!employee) return { success: false, message: "Employee profile not found for this company" };

            const shift = employee.shift_id ? await ShiftModel.findById(employee.shift_id) : null;
            const timezone = shift?.timezone ?? "UTC";
            const attendance_date = getTodayInTimezone(timezone);
            const record = await AttendanceModel.findByEmployeeAndDate(employee.id, attendance_date);

            if (request_type === "check-in") {
                if (record?.check_in) return { success: false, message: "You have already checked in today" };
            } else {
                if (record?.check_out) return { success: false, message: "You have already checked out today" };
                const checkInPending = await AttendanceRequestModel.findPending(employee.id, attendance_date, "check-in");
                if (!record?.check_in && !checkInPending) {
                    return { success: false, message: "Check in first, or request a check-in, before checking out" };
                }
            }
            if (await AttendanceRequestModel.findPending(employee.id, attendance_date, request_type)) {
                return { success: false, message: `You already have a ${label(request_type)} request waiting for approval today` };
            }

            let selfie = null;
            let selfie_url = null;
            if (selfie_file) {
                try {
                    const uploaded = await uploadSelfie(selfie_file, employee.id, request_type);
                    selfie = uploaded.path;
                    selfie_url = uploaded.url;
                } catch (err) {
                    console.error("[AttendanceRequest] Selfie upload failed:", err.message);
                }
            }

            const request = await AttendanceRequestModel.create({
                company_id,
                branch_id: employee.branch_id,
                employee_id: employee.id,
                request_type,
                attendance_date,
                requested_at: new Date(),
                latitude: lat,
                longitude: lng,
                address,
                selfie,
                selfie_url,
                reason: why,
            });

            sendAdminAlert(employee, request, timezone);

            return {
                success: true,
                message: `Your ${label(request_type)} request was sent for approval`,
                data: {
                    id: request.id,
                    request_type: request.request_type,
                    attendance_date: request.attendance_date,
                    requested_at: request.requested_at,
                    status: request.status,
                },
            };
        } catch (error) {
            if (error?.code === "23505") {
                return { success: false, message: "You already have a request of this kind waiting for approval today" };
            }
            return { success: false, message: error.message };
        }
    },

    /** EMPLOYEE: today's requests, so the app can show "waiting for approval". */
    async listMineToday(user_id, company_id) {
        try {
            const employee = await EmployeeModel.findByUserAndCompany(user_id, company_id);
            if (!employee) return { success: false, message: "Employee profile not found for this company" };
            const shift = employee.shift_id ? await ShiftModel.findById(employee.shift_id) : null;
            const date = getTodayInTimezone(shift?.timezone ?? "UTC");
            return { success: true, data: await AttendanceRequestModel.findForEmployeeOnDate(employee.id, date) };
        } catch (error) {
            return { success: false, message: error.message };
        }
    },

    // ─────────────────────────────────────────────────────────────────────
    // ADMIN: the queue
    // ─────────────────────────────────────────────────────────────────────
    async list(company_id, filters = {}) {
        try {
            const rows = await AttendanceRequestModel.listByCompany(company_id, filters);

            // How far each request was from anywhere the employee may normally
            // check in, so the reviewer can tell "500 m off" from "another city".
            const sitesByBranch = new Map();
            for (const row of rows) {
                if (row.branch_id && !sitesByBranch.has(row.branch_id)) {
                    sitesByBranch.set(row.branch_id, await BranchLocationModel.findActiveByBranch(row.branch_id));
                }
            }

            const data = rows.map((row) => {
                let nearest_place = null;
                let distance_m = null;
                if (row.latitude != null && row.longitude != null) {
                    const fence = checkGeofence(
                        Number(row.latitude),
                        Number(row.longitude),
                        { branch_name: row.branch_name, latitude: row.branch_latitude, longitude: row.branch_longitude, attendance_radius: row.branch_radius },
                        sitesByBranch.get(row.branch_id) ?? []
                    );
                    if (fence.configured) {
                        nearest_place = fence.place.name;
                        distance_m = fence.distance;
                    }
                }
                const { branch_latitude, branch_longitude, branch_radius, ...rest } = row;
                return { ...rest, employee_name: `${row.first_name} ${row.last_name}`.trim(), nearest_place, distance_m };
            });

            return { success: true, data };
        } catch (error) {
            return { success: false, message: error.message };
        }
    },

    /**
     * ADMIN: approve (full day or half day) or reject many requests at once.
     *
     * Each request is decided in its own transaction, so one that cannot be
     * applied (e.g. the employee has since checked in normally) is reported
     * and left pending without blocking the rest. Check-ins are applied
     * before check-outs, so a day's pair can be approved together.
     */
    async review(company_id, reviewer_user_id, { ids, action, note = null }) {
        if (!ACTIONS.includes(action)) {
            return { success: false, message: `action must be one of: ${ACTIONS.join(", ")}` };
        }
        if (!Array.isArray(ids) || ids.length === 0) return { success: false, message: "Select at least one request" };
        if (ids.length > MAX_BATCH) return { success: false, message: `At most ${MAX_BATCH} requests at a time` };

        const reviewNote = note ? String(note).trim() || null : null;
        const halfDay = action === "approve_half_day";

        try {
            const found = await AttendanceRequestModel.findManyForCompany(company_id, [...new Set(ids)]);
            const byId = new Map(found.map((r) => [r.id, r]));
            const ordered = [...found].sort((a, b) =>
                a.request_type === b.request_type
                    ? new Date(a.requested_at) - new Date(b.requested_at)
                    : a.request_type === "check-in" ? -1 : 1
            );

            const shifts = new Map();
            const shiftOf = async (shift_id) => {
                if (!shift_id) return null;
                if (!shifts.has(shift_id)) shifts.set(shift_id, (await ShiftModel.findById(shift_id)) ?? null);
                return shifts.get(shift_id);
            };

            const results = ids.filter((id) => !byId.has(id)).map((id) => ({ id, ok: false, message: "Request not found" }));

            for (const request of ordered) {
                if (request.status !== "pending") {
                    results.push({ id: request.id, ok: false, message: `Already ${request.status}` });
                    continue;
                }
                const outcome = action === "reject"
                    ? await rejectOne(request, reviewer_user_id, reviewNote)
                    : await approveOne(request, reviewer_user_id, reviewNote, halfDay, await shiftOf(request.shift_id));
                results.push({ id: request.id, ...outcome });
                if (outcome.ok) notifyEmployee(request, action, reviewNote);
            }

            const done = results.filter((r) => r.ok).length;
            return {
                success: true,
                message: `${done} of ${ids.length} request${ids.length === 1 ? "" : "s"} ${action === "reject" ? "rejected" : "approved"}`,
                data: { results, succeeded: done, failed: results.length - done },
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    },
};

// ─────────────────────────────────────────────────────────────────────────
// Applying one decision
// ─────────────────────────────────────────────────────────────────────────

async function rejectOne(request, reviewer, note) {
    const result = await db.query(
        `UPDATE attendance_requests
         SET status = 'rejected', reviewed_by = $2, reviewed_at = NOW(), review_note = $3
         WHERE id = $1 AND status = 'pending'
         RETURNING id`,
        [request.id, reviewer, note]
    );
    return result.rows[0]
        ? { ok: true, message: "Rejected" }
        : { ok: false, message: "Already reviewed by someone else" };
}

async function approveOne(request, reviewer, note, halfDay, shift) {
    const client = await db.getClient();
    try {
        await client.query("BEGIN");

        const locked = await client.query(
            "SELECT status FROM attendance_requests WHERE id = $1 FOR UPDATE",
            [request.id]
        );
        if (locked.rows[0]?.status !== "pending") {
            await client.query("ROLLBACK");
            return { ok: false, message: "Already reviewed by someone else" };
        }

        const existing = (await client.query(
            `SELECT id, check_in, check_out, is_half_day FROM attendance
             WHERE employee_id = $1 AND attendance_date = $2
             FOR UPDATE`,
            [request.employee_id, request.attendance_date]
        )).rows[0];

        const timezone = shift?.timezone ?? "UTC";
        let attendanceId;

        if (request.request_type === "check-in") {
            if (existing?.check_in) {
                await client.query("ROLLBACK");
                return {
                    ok: false,
                    message: `Already checked in at ${timeIn(existing.check_in, timezone)} that day. Reject this request instead.`,
                };
            }
            const attendanceStatus = shift ? calculateAttendanceStatus(new Date(request.requested_at), shift, timezone) : null;
            if (existing) {
                await client.query(
                    `UPDATE attendance SET
                        check_in = $2, check_in_latitude = $3, check_in_longitude = $4,
                        check_in_address = $5, check_in_selfie = $6, check_in_selfie_url = $7,
                        attendance_status = $8, status = 'checked-in',
                        is_half_day = is_half_day OR $9
                     WHERE id = $1`,
                    [existing.id, request.requested_at, request.latitude, request.longitude,
                        request.address, request.selfie, request.selfie_url, attendanceStatus, halfDay]
                );
                attendanceId = existing.id;
            } else {
                const inserted = await client.query(
                    `INSERT INTO attendance (
                        company_id, branch_id, employee_id, attendance_date,
                        check_in, check_in_latitude, check_in_longitude, check_in_address,
                        check_in_selfie, check_in_selfie_url, attendance_status, status, is_half_day
                     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'checked-in', $12)
                     RETURNING id`,
                    [request.company_id, request.branch_id, request.employee_id, request.attendance_date,
                        request.requested_at, request.latitude, request.longitude, request.address,
                        request.selfie, request.selfie_url, attendanceStatus, halfDay]
                );
                attendanceId = inserted.rows[0].id;
            }
        } else {
            if (!existing?.check_in) {
                await client.query("ROLLBACK");
                return { ok: false, message: "No check-in for that day yet. Approve the check-in request first." };
            }
            if (existing.check_out) {
                await client.query("ROLLBACK");
                return { ok: false, message: `Already checked out at ${timeIn(existing.check_out, timezone)} that day. Reject this request instead.` };
            }
            const hours = (new Date(request.requested_at) - new Date(existing.check_in)) / 3600000;
            if (hours < 0) {
                await client.query("ROLLBACK");
                return { ok: false, message: "This check-out is earlier than the day's check-in" };
            }
            await client.query(
                `UPDATE attendance SET
                    check_out = $2, check_out_latitude = $3, check_out_longitude = $4,
                    check_out_address = $5, check_out_selfie = $6, check_out_selfie_url = $7,
                    total_hours = $8, status = 'checked-out',
                    is_half_day = is_half_day OR $9
                 WHERE id = $1`,
                [existing.id, request.requested_at, request.latitude, request.longitude,
                    request.address, request.selfie, request.selfie_url, Number(hours.toFixed(2)), halfDay]
            );
            attendanceId = existing.id;
        }

        await client.query(
            `UPDATE attendance_requests
             SET status = 'approved', approved_as_half_day = $2, reviewed_by = $3,
                 reviewed_at = NOW(), review_note = $4, attendance_id = $5
             WHERE id = $1`,
            [request.id, halfDay, reviewer, note, attendanceId]
        );

        await client.query("COMMIT");
        return { ok: true, message: halfDay ? "Approved as half day" : "Approved" };
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        return { ok: false, message: error.message };
    } finally {
        client.release();
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Notifications: fire and forget, never block the request itself
// ─────────────────────────────────────────────────────────────────────────

function sendAdminAlert(employee, request, timezone) {
    NotificationService.notifyAttendanceRequest({
        company_id: employee.company_id,
        branch_id: employee.branch_id,
        request_id: request.id,
        employee_name: `${employee.first_name} ${employee.last_name}`.trim(),
        employee_code: employee.employee_code,
        request_label: label(request.request_type),
        attendance_date: String(request.attendance_date).slice(0, 10),
        request_time: timeIn(request.requested_at, timezone),
    }).catch((err) => console.error("[Notification] notifyAttendanceRequest failed:", err.message));
}

function notifyEmployee(request, action, note) {
    NotificationService.notifyAttendanceRequestDecision({
        company_id: request.company_id,
        employee_id: request.employee_id,
        request_id: request.id,
        approved: action !== "reject",
        request_label: label(request.request_type),
        attendance_date: String(request.attendance_date).slice(0, 10),
        half_day: action === "approve_half_day",
        review_note: note,
    }).catch((err) => console.error("[Notification] notifyAttendanceRequestDecision failed:", err.message));
}

module.exports = AttendanceRequestService;
