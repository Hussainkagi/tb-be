const db = require("../config/database");

const LeaveRequestModel = {
    // --------------------------------------------------------
    // CREATE
    // --------------------------------------------------------

    async create(data) {
        const {
            company_id,
            branch_id,
            employee_id,
            leave_type_id,
            from_date,
            to_date,
            total_days,
            is_half_day = false,
            reason,
            document_url = null,
        } = data;

        const result = await db.query(
            `INSERT INTO leave_requests (
                company_id, branch_id, employee_id, leave_type_id,
                from_date, to_date, total_days, is_half_day,
                reason, document_url
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *`,
            [
                company_id, branch_id, employee_id, leave_type_id,
                from_date, to_date, total_days, is_half_day,
                reason, document_url,
            ]
        );
        return result.rows[0];
    },

    // --------------------------------------------------------
    // READ — single record
    // --------------------------------------------------------

    async findById(id) {
        const result = await db.query(
            `SELECT lr.*,
                    lt.leave_name,
                    lt.is_paid,
                    lt.requires_document,
                    lt.is_half_day_allowed
             FROM leave_requests lr
             JOIN leave_types lt ON lt.id = lr.leave_type_id
             WHERE lr.id = $1 AND lr.deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    },

    // --------------------------------------------------------
    // READ — employee scope
    // --------------------------------------------------------

    async getAllByEmployee(employee_id) {
        const result = await db.query(
            `SELECT lr.*,
                    lt.leave_name,
                    lt.is_paid
             FROM leave_requests lr
             JOIN leave_types lt ON lt.id = lr.leave_type_id
             WHERE lr.employee_id = $1
               AND lr.deleted_at  IS NULL
             ORDER BY lr.from_date DESC`,
            [employee_id]
        );
        return result.rows;
    },

    async getByEmployeeAndStatus(employee_id, status) {
        const result = await db.query(
            `SELECT lr.*,
                    lt.leave_name,
                    lt.is_paid
             FROM leave_requests lr
             JOIN leave_types lt ON lt.id = lr.leave_type_id
             WHERE lr.employee_id = $1
               AND lr.status      = $2
               AND lr.deleted_at  IS NULL
             ORDER BY lr.from_date DESC`,
            [employee_id, status]
        );
        return result.rows;
    },

    // --------------------------------------------------------
    // READ — branch scope
    // --------------------------------------------------------

    async getAllByBranch(branch_id) {
        const result = await db.query(
            `SELECT lr.*,
                    lt.leave_name,
                    lt.is_paid
             FROM leave_requests lr
             JOIN leave_types lt ON lt.id = lr.leave_type_id
             WHERE lr.branch_id  = $1
               AND lr.deleted_at IS NULL
             ORDER BY lr.from_date DESC`,
            [branch_id]
        );
        return result.rows;
    },

    async getByBranchAndStatus(branch_id, status) {
        const result = await db.query(
            `SELECT lr.*,
                    lt.leave_name,
                    lt.is_paid
             FROM leave_requests lr
             JOIN leave_types lt ON lt.id = lr.leave_type_id
             WHERE lr.branch_id  = $1
               AND lr.status     = $2
               AND lr.deleted_at IS NULL
             ORDER BY lr.from_date DESC`,
            [branch_id, status]
        );
        return result.rows;
    },

    // --------------------------------------------------------
    // READ — company scope
    // --------------------------------------------------------

    async getAllByCompany(company_id) {
        const result = await db.query(
            `SELECT lr.*,
                    lt.leave_name,
                    lt.is_paid
             FROM leave_requests lr
             JOIN leave_types lt ON lt.id = lr.leave_type_id
             WHERE lr.company_id = $1
               AND lr.deleted_at IS NULL
             ORDER BY lr.from_date DESC`,
            [company_id]
        );
        return result.rows;
    },

    async getByCompanyAndStatus(company_id, status) {
        const result = await db.query(
            `SELECT lr.*,
                    lt.leave_name,
                    lt.is_paid
             FROM leave_requests lr
             JOIN leave_types lt ON lt.id = lr.leave_type_id
             WHERE lr.company_id = $1
               AND lr.status     = $2
               AND lr.deleted_at IS NULL
             ORDER BY lr.from_date DESC`,
            [company_id, status]
        );
        return result.rows;
    },

    // --------------------------------------------------------
    // READ — date range (payroll / reporting)
    // --------------------------------------------------------

    async getByDateRange(company_id, from_date, to_date, branch_id = null) {
        const params = [company_id, from_date, to_date];
        let branchClause = "";

        if (branch_id) {
            params.push(branch_id);
            branchClause = `AND lr.branch_id = $${params.length}`;
        }

        const result = await db.query(
            `SELECT lr.*,
                    lt.leave_name,
                    lt.is_paid
             FROM leave_requests lr
             JOIN leave_types lt ON lt.id = lr.leave_type_id
             WHERE lr.company_id   = $1
               AND lr.from_date   <= $3
               AND lr.to_date     >= $2
               AND lr.deleted_at  IS NULL
               AND lr.status       = 'approved'
               ${branchClause}
             ORDER BY lr.from_date ASC`,
            params
        );
        return result.rows;
    },

    // Check if employee has an overlapping pending/approved leave
    async getOverlapping(employee_id, from_date, to_date, exclude_id = null) {
        const params = [employee_id, from_date, to_date];
        let excludeClause = "";

        if (exclude_id) {
            params.push(exclude_id);
            excludeClause = `AND lr.id != $${params.length}`;
        }

        const result = await db.query(
            `SELECT * FROM leave_requests lr
             WHERE lr.employee_id  = $1
               AND lr.from_date   <= $3
               AND lr.to_date     >= $2
               AND lr.status      IN ('pending', 'approved')
               AND lr.deleted_at  IS NULL
               ${excludeClause}`,
            params
        );
        return result.rows;
    },

    // --------------------------------------------------------
    // UPDATE — approval workflow
    // --------------------------------------------------------

    async approve(id, approved_by) {
        const result = await db.query(
            `UPDATE leave_requests
             SET status      = 'approved',
                 approved_by = $2,
                 approved_at = NOW()
             WHERE id          = $1
               AND deleted_at  IS NULL
             RETURNING *`,
            [id, approved_by]
        );
        return result.rows[0];
    },

    async reject(id, approved_by, rejection_reason) {
        const result = await db.query(
            `UPDATE leave_requests
             SET status           = 'rejected',
                 approved_by      = $2,
                 approved_at      = NOW(),
                 rejection_reason = $3
             WHERE id         = $1
               AND deleted_at IS NULL
             RETURNING *`,
            [id, approved_by, rejection_reason]
        );
        return result.rows[0];
    },

    async cancel(id) {
        const result = await db.query(
            `UPDATE leave_requests
             SET status = 'cancelled'
             WHERE id         = $1
               AND deleted_at IS NULL
             RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    // General field update (reason, document_url — only while pending)
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
        const query = `UPDATE leave_requests SET ${updates.join(", ")}
                       WHERE id = $${paramCount}
                         AND deleted_at IS NULL
                       RETURNING *`;

        const result = await db.query(query, values);
        return result.rows[0];
    },

    // --------------------------------------------------------
    // DELETE — soft delete
    // --------------------------------------------------------

    async delete(id) {
        const result = await db.query(
            `UPDATE leave_requests SET deleted_at = NOW()
             WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },
};

module.exports = LeaveRequestModel;