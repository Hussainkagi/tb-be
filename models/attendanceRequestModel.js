const db = require("../config/database");

const AttendanceRequestModel = {
    async create(data) {
        const result = await db.query(
            `INSERT INTO attendance_requests (
                company_id, branch_id, employee_id, request_type, attendance_date,
                requested_at, latitude, longitude, address, selfie, selfie_url, reason
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             RETURNING *`,
            [
                data.company_id, data.branch_id, data.employee_id, data.request_type,
                data.attendance_date, data.requested_at, data.latitude, data.longitude,
                data.address ?? null, data.selfie ?? null, data.selfie_url ?? null, data.reason ?? null,
            ]
        );
        return result.rows[0];
    },

    /** One employee's requests for one day, oldest first. */
    async findForEmployeeOnDate(employee_id, attendance_date) {
        const result = await db.query(
            `SELECT id, request_type, attendance_date::text, requested_at, status,
                    approved_as_half_day, review_note, reason, created_at
             FROM attendance_requests
             WHERE employee_id = $1 AND attendance_date = $2
             ORDER BY requested_at ASC`,
            [employee_id, attendance_date]
        );
        return result.rows;
    },

    async findPending(employee_id, attendance_date, request_type) {
        const result = await db.query(
            `SELECT id FROM attendance_requests
             WHERE employee_id = $1 AND attendance_date = $2
               AND request_type = $3 AND status = 'pending'`,
            [employee_id, attendance_date, request_type]
        );
        return result.rows[0];
    },

    /** The admin queue, with what a reviewer needs to decide. */
    async listByCompany(company_id, { status = "pending", branch_id = null, from = null, to = null, limit = 500 } = {}) {
        const values = [company_id];
        const where = ["r.company_id = $1"];
        if (status && status !== "all") {
            values.push(status);
            where.push(`r.status = $${values.length}`);
        }
        if (branch_id) {
            values.push(branch_id);
            where.push(`r.branch_id = $${values.length}`);
        }
        if (from) {
            values.push(from);
            where.push(`r.attendance_date >= $${values.length}`);
        }
        if (to) {
            values.push(to);
            where.push(`r.attendance_date <= $${values.length}`);
        }
        values.push(Math.min(Number(limit) || 500, 1000));

        const result = await db.query(
            `SELECT r.id, r.employee_id, r.branch_id, r.request_type,
                    r.attendance_date::text, r.requested_at, r.latitude, r.longitude,
                    r.address, r.selfie_url, r.reason, r.status, r.approved_as_half_day,
                    r.review_note, r.reviewed_at, r.created_at,
                    e.first_name, e.last_name, e.employee_code,
                    b.branch_name, b.latitude AS branch_latitude, b.longitude AS branch_longitude,
                    b.attendance_radius AS branch_radius,
                    s.timezone AS shift_timezone,
                    TRIM(CONCAT(ru.first_name, ' ', ru.last_name)) AS reviewed_by_name
             FROM attendance_requests r
             JOIN employees e      ON e.id = r.employee_id
             LEFT JOIN branches b  ON b.id = r.branch_id
             LEFT JOIN shifts s    ON s.id = e.shift_id
             LEFT JOIN users ru    ON ru.id = r.reviewed_by
             WHERE ${where.join(" AND ")}
             ORDER BY r.requested_at DESC
             LIMIT $${values.length}`,
            values
        );
        return result.rows;
    },

    /** Requests of this company among `ids`, for review. */
    async findManyForCompany(company_id, ids) {
        const result = await db.query(
            `SELECT r.*, r.attendance_date::text AS attendance_date,
                    e.first_name, e.last_name, e.employee_code, e.shift_id, e.company_id AS employee_company_id
             FROM attendance_requests r
             JOIN employees e ON e.id = r.employee_id
             WHERE r.company_id = $1 AND r.id = ANY($2::uuid[])`,
            [company_id, ids]
        );
        return result.rows;
    },

    /** Closes the employee's open request(s) for a day once they checked in normally. */
    async cancelPending(employee_id, attendance_date, request_type) {
        await db.query(
            `UPDATE attendance_requests
             SET status = 'cancelled', review_note = 'Checked in at an allowed location instead'
             WHERE employee_id = $1 AND attendance_date = $2
               AND request_type = $3 AND status = 'pending'`,
            [employee_id, attendance_date, request_type]
        );
    },
};

module.exports = AttendanceRequestModel;
