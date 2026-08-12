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
            // Two-stage approval routing — decided by the service
            department_id = null,
            approval_stage = "admin",
            hod_status = "not_required",
            hod_employee_id = null,
        } = data;

        const result = await db.query(
            `INSERT INTO leave_requests (
                company_id, branch_id, employee_id, leave_type_id,
                from_date, to_date, total_days, is_half_day,
                reason, document_url,
                department_id, approval_stage, hod_status, hod_employee_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            RETURNING *`,
            [
                company_id, branch_id, employee_id, leave_type_id,
                from_date, to_date, total_days, is_half_day,
                reason, document_url,
                department_id, approval_stage, hod_status, hod_employee_id,
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
                    lt.is_half_day_allowed,
                    e.first_name      AS employee_first_name,
                    e.last_name       AS employee_last_name,
                    e.employee_code,
                    d.department_name,
                    hod.first_name    AS hod_first_name,
                    hod.last_name     AS hod_last_name
             FROM leave_requests lr
             JOIN leave_types lt ON lt.id = lr.leave_type_id
             JOIN employees   e  ON e.id  = lr.employee_id
             LEFT JOIN departments d   ON d.id   = lr.department_id
             LEFT JOIN employees   hod ON hod.id = lr.hod_employee_id
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
            `SELECT
            lr.*,
            lt.leave_name,
            lt.is_paid,
            e.employee_code,
            e.first_name,
            e.last_name,
            e.email,
            e.gender
         FROM leave_requests lr
         JOIN leave_types  lt ON lt.id = lr.leave_type_id
         JOIN employees    e  ON e.id  = lr.employee_id
         WHERE lr.branch_id  = $1
           AND lr.deleted_at IS NULL
         ORDER BY lr.from_date DESC`,
            [branch_id]
        );
        return result.rows;
    },

    async getByBranchAndStatus(branch_id, status) {
        const result = await db.query(
            `SELECT
            lr.*,
            lt.leave_name,
            lt.is_paid,
            e.employee_code,
            e.first_name,
            e.last_name,
            e.email,
            e.gender
         FROM leave_requests lr
         JOIN leave_types  lt ON lt.id = lr.leave_type_id
         JOIN employees    e  ON e.id  = lr.employee_id
         WHERE lr.branch_id  = $1
           AND lr.status     = $2
           AND lr.deleted_at IS NULL
         ORDER BY lr.from_date DESC`,
            [branch_id, status]
        );
        return result.rows;
    },

    // --------------------------------------------------------
    // READ — head of department scope
    // --------------------------------------------------------

    // Everything raised inside the departments this employee heads.
    // `stage` narrows it to one leg of the workflow:
    //   "hod"   → waiting for the HOD to act (their action queue)
    //   "admin" → cleared by the HOD, waiting on the admin
    async getAllForHod(hod_employee_id, { stage = null, status = null } = {}) {
        const params = [hod_employee_id];
        let clauses = "";

        if (stage) {
            params.push(stage);
            clauses += ` AND lr.approval_stage = $${params.length}`;
        }
        if (status) {
            params.push(status);
            clauses += ` AND lr.status = $${params.length}`;
        }

        const result = await db.query(
            `SELECT lr.*,
                    lt.leave_name,
                    lt.is_paid,
                    e.employee_code,
                    e.first_name,
                    e.last_name,
                    e.email,
                    e.gender,
                    d.department_name
             FROM leave_requests lr
             JOIN leave_types lt ON lt.id = lr.leave_type_id
             JOIN employees   e  ON e.id  = lr.employee_id
             LEFT JOIN departments d ON d.id = lr.department_id
             WHERE lr.hod_employee_id = $1
               AND lr.deleted_at IS NULL${clauses}
             ORDER BY lr.created_at DESC`,
            params
        );
        return result.rows;
    },

    async countPendingForHod(hod_employee_id) {
        const result = await db.query(
            `SELECT COUNT(*)::int AS count
             FROM leave_requests
             WHERE hod_employee_id = $1
               AND approval_stage  = 'hod'
               AND status          = 'pending'
               AND deleted_at IS NULL`,
            [hod_employee_id]
        );
        return result.rows[0].count;
    },

    // --------------------------------------------------------
    // UPDATE — head of department leg
    // --------------------------------------------------------

    // HOD signs off — the request moves on to the admin, `status` stays pending
    async hodApprove(id, hod_approved_by) {
        const result = await db.query(
            `UPDATE leave_requests
             SET hod_status      = 'approved',
                 hod_approved_by = $2,
                 hod_approved_at = NOW(),
                 approval_stage  = 'admin'
             WHERE id             = $1
               AND deleted_at     IS NULL
               AND approval_stage = 'hod'
             RETURNING *`,
            [id, hod_approved_by]
        );
        return result.rows[0];
    },

    // HOD rejects — the request ends here, it never reaches the admin
    async hodReject(id, hod_approved_by, rejection_reason) {
        const result = await db.query(
            `UPDATE leave_requests
             SET hod_status           = 'rejected',
                 hod_approved_by      = $2,
                 hod_approved_at      = NOW(),
                 hod_rejection_reason = $3,
                 approval_stage       = 'completed',
                 status               = 'rejected',
                 rejection_reason     = $3
             WHERE id             = $1
               AND deleted_at     IS NULL
               AND approval_stage = 'hod'
             RETURNING *`,
            [id, hod_approved_by, rejection_reason]
        );
        return result.rows[0];
    },

    // A department got a new head — hand the still-waiting requests over to
    // them so nothing is stuck with the previous head.
    async reassignHodForDepartment(department_id, new_hod_employee_id) {
        const result = await db.query(
            `UPDATE leave_requests
             SET hod_employee_id = $2
             WHERE department_id  = $1
               AND approval_stage = 'hod'
               AND status         = 'pending'
               AND deleted_at IS NULL
               AND employee_id != $2
             RETURNING *`,
            [department_id, new_hod_employee_id]
        );
        return result.rows;
    },

    // A department lost its head — the HOD stage can no longer be served, so
    // the waiting requests fall through to the admin instead of stalling.
    async releaseHodStageForDepartment(department_id) {
        const result = await db.query(
            `UPDATE leave_requests
             SET approval_stage  = 'admin',
                 hod_status      = 'not_required',
                 hod_employee_id = NULL
             WHERE department_id  = $1
               AND approval_stage = 'hod'
               AND status         = 'pending'
               AND deleted_at IS NULL
             RETURNING *`,
            [department_id]
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

    // The admin queue — pending requests that already cleared the HOD stage
    // (plus the ones that never needed it). Pass stage 'hod' to see what is
    // still sitting with the department heads.
    async getByCompanyAndStage(company_id, stage) {
        const result = await db.query(
            `SELECT lr.*,
                    lt.leave_name,
                    lt.is_paid,
                    e.employee_code,
                    e.first_name,
                    e.last_name,
                    e.email,
                    d.department_name,
                    hod.first_name AS hod_first_name,
                    hod.last_name  AS hod_last_name
             FROM leave_requests lr
             JOIN leave_types lt ON lt.id = lr.leave_type_id
             JOIN employees   e  ON e.id  = lr.employee_id
             LEFT JOIN departments d   ON d.id   = lr.department_id
             LEFT JOIN employees   hod ON hod.id = lr.hod_employee_id
             WHERE lr.company_id     = $1
               AND lr.approval_stage = $2
               AND lr.status         = 'pending'
               AND lr.deleted_at IS NULL
             ORDER BY lr.created_at DESC`,
            [company_id, stage]
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
             SET status         = 'approved',
                 approved_by    = $2,
                 approved_at    = NOW(),
                 approval_stage = 'completed'
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
                 rejection_reason = $3,
                 approval_stage   = 'completed'
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
             SET status         = 'cancelled',
                 approval_stage = 'completed'
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