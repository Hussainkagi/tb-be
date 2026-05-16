const db = require("../config/database");

const Attendance = {

    async create(data) {
        const {
            company_id,
            branch_id = null,
            employee_id,
            attendance_date,
            check_in = null,
            check_in_latitude = null,
            check_in_longitude = null,
            check_in_address = null,
            check_in_selfie = null,
            check_in_selfie_url = null,
            check_out = null,
            check_out_latitude = null,
            check_out_longitude = null,
            check_out_address = null,
            check_out_selfie = null,
            check_out_selfie_url = null,
            total_hours = null,
            attendance_status = null,
            status = 'absent',
            remarks = null,
        } = data;

        const result = await db.query(
            `INSERT INTO attendance (
                company_id, branch_id, employee_id, attendance_date,
                check_in, check_in_latitude, check_in_longitude, check_in_address,
                check_in_selfie, check_in_selfie_url,
                check_out, check_out_latitude, check_out_longitude, check_out_address,
                check_out_selfie, check_out_selfie_url,
                total_hours, attendance_status, status, remarks
            ) VALUES (
                $1,  $2,  $3,  $4,
                $5,  $6,  $7,  $8,
                $9,  $10,
                $11, $12, $13, $14,
                $15, $16,
                $17, $18, $19, $20
            ) RETURNING *`,
            [
                company_id, branch_id, employee_id, attendance_date,
                check_in, check_in_latitude, check_in_longitude, check_in_address,
                check_in_selfie, check_in_selfie_url,
                check_out, check_out_latitude, check_out_longitude, check_out_address,
                check_out_selfie, check_out_selfie_url,
                total_hours, attendance_status, status, remarks,
            ]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT
                a.*,
                e.first_name,
                e.last_name,
                e.employee_code,
                e.email,
                d.department_name,
                s.shift_name,
                b.branch_name
             FROM attendance a
             LEFT JOIN employees e ON a.employee_id = e.id
             LEFT JOIN departments d ON e.department_id = d.id
             LEFT JOIN shifts s ON e.shift_id = s.id
             LEFT JOIN branches b ON a.branch_id = b.id
             WHERE a.id = $1`,
            [id]
        );
        return result.rows[0];
    },

    // Check if employee already has a record for the given date
    async findByEmployeeAndDate(employee_id, attendance_date) {
        const result = await db.query(
            `SELECT * FROM attendance
             WHERE employee_id = $1 AND attendance_date = $2`,
            [employee_id, attendance_date]
        );
        return result.rows[0];
    },

    async findByCompany(company_id, { startDate, endDate } = {}) {
        const values = [company_id];
        let dateFilter = '';

        if (startDate && endDate) {
            values.push(startDate, endDate);
            dateFilter = `AND a.attendance_date BETWEEN $2 AND $3`;
        } else if (startDate) {
            values.push(startDate);
            dateFilter = `AND a.attendance_date >= $2`;
        } else if (endDate) {
            values.push(endDate);
            dateFilter = `AND a.attendance_date <= $2`;
        }

        const result = await db.query(
            `SELECT
                a.*,
                e.first_name,
                e.last_name,
                e.employee_code,
                e.email,
                d.department_name,
                s.shift_name
             FROM attendance a
             LEFT JOIN employees e ON a.employee_id = e.id
             LEFT JOIN departments d ON e.department_id = d.id
             LEFT JOIN shifts s ON e.shift_id = s.id
             WHERE a.company_id = $1 ${dateFilter}
             ORDER BY a.attendance_date DESC, a.check_in DESC`,
            values
        );
        return result.rows;
    },

    async findByEmployee(employee_id, { startDate, endDate } = {}) {
        const values = [employee_id];
        let dateFilter = '';

        if (startDate && endDate) {
            values.push(startDate, endDate);
            dateFilter = `AND attendance_date BETWEEN $2 AND $3`;
        } else if (startDate) {
            values.push(startDate);
            dateFilter = `AND attendance_date >= $2`;
        } else if (endDate) {
            values.push(endDate);
            dateFilter = `AND attendance_date <= $2`;
        }

        const result = await db.query(
            `SELECT * FROM attendance
             WHERE employee_id = $1 ${dateFilter}
             ORDER BY attendance_date DESC`,
            values
        );
        return result.rows;
    },

    async findByBranch(branch_id, { startDate, endDate } = {}) {
        const values = [branch_id];
        let dateFilter = '';

        if (startDate && endDate) {
            values.push(startDate, endDate);
            dateFilter = `AND a.attendance_date BETWEEN $2 AND $3`;
        } else if (startDate) {
            values.push(startDate);
            dateFilter = `AND a.attendance_date >= $2`;
        } else if (endDate) {
            values.push(endDate);
            dateFilter = `AND a.attendance_date <= $2`;
        }

        const result = await db.query(
            `SELECT
                a.*,
                e.first_name,
                e.last_name,
                e.employee_code,
                e.email
             FROM attendance a
             LEFT JOIN employees e ON a.employee_id = e.id
             WHERE a.branch_id = $1 ${dateFilter}
             ORDER BY a.attendance_date DESC, a.check_in DESC`,
            values
        );
        return result.rows;
    },

    // Fetch all check-in locations for map visualization
    async findCheckInLocations(company_id, { startDate, endDate } = {}) {
        const values = [company_id];
        let dateFilter = '';

        if (startDate && endDate) {
            values.push(startDate, endDate);
            dateFilter = `AND a.attendance_date BETWEEN $2 AND $3`;
        } else if (startDate) {
            values.push(startDate);
            dateFilter = `AND a.attendance_date >= $2`;
        } else if (endDate) {
            values.push(endDate);
            dateFilter = `AND a.attendance_date <= $2`;
        }

        const result = await db.query(
            `SELECT
                a.id,
                a.employee_id,
                a.attendance_date,
                a.check_in,
                a.check_in_latitude,
                a.check_in_longitude,
                a.check_in_address,
                a.status,
                e.first_name,
                e.last_name,
                e.employee_code
             FROM attendance a
             LEFT JOIN employees e ON a.employee_id = e.id
             WHERE a.company_id = $1
               AND a.check_in_latitude IS NOT NULL
               AND a.check_in_longitude IS NOT NULL
               ${dateFilter}
             ORDER BY a.check_in DESC`,
            values
        );
        return result.rows;
    },

    // Update check-in fields only
    async checkIn(id, data) {
        const {
            check_in,
            check_in_latitude,
            check_in_longitude,
            check_in_address,
            check_in_selfie,
            check_in_selfie_url,
            attendance_status,
            status,
        } = data;

        const result = await db.query(
            `UPDATE attendance SET
                check_in            = $1,
                check_in_latitude   = $2,
                check_in_longitude  = $3,
                check_in_address    = $4,
                check_in_selfie     = $5,
                check_in_selfie_url = $6,
                attendance_status   = $7,
                status              = $8
             WHERE id = $9
             RETURNING *`,
            [
                check_in,
                check_in_latitude,
                check_in_longitude,
                check_in_address,
                check_in_selfie,
                check_in_selfie_url,
                attendance_status,
                status,
                id,
            ]
        );
        return result.rows[0];
    },

    // Update check-out fields only
    async checkOut(id, data) {
        const {
            check_out,
            check_out_latitude,
            check_out_longitude,
            check_out_address,
            check_out_selfie,
            check_out_selfie_url,
            total_hours,
            status,
        } = data;

        const result = await db.query(
            `UPDATE attendance SET
                check_out             = $1,
                check_out_latitude    = $2,
                check_out_longitude   = $3,
                check_out_address     = $4,
                check_out_selfie      = $5,
                check_out_selfie_url  = $6,
                total_hours           = $7,
                status                = $8
             WHERE id = $9
             RETURNING *`,
            [
                check_out,
                check_out_latitude,
                check_out_longitude,
                check_out_address,
                check_out_selfie,
                check_out_selfie_url,
                total_hours,
                status,
                id,
            ]
        );
        return result.rows[0];
    },

    // Generic update (admin overrides, remarks, manual status changes, etc.)
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
        const query = `UPDATE attendance SET ${updates.join(", ")}
                       WHERE id = $${paramCount}
                       RETURNING *`;

        const result = await db.query(query, values);
        return result.rows[0];
    },

    async delete(id) {
        const result = await db.query(
            `DELETE FROM attendance WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },
};

module.exports = Attendance;