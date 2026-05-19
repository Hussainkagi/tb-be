const db = require("../config/database");

const DEFAULT_LEAVE_TYPES = [
    {
        leave_name: "Annual Leave",
        total_days: 21,
        is_paid: true,
        is_carry_forward: true,
        max_carry_forward_days: 10,
        requires_document: false,
        is_half_day_allowed: true,
    },
    {
        leave_name: "Sick Leave",
        total_days: 10,
        is_paid: true,
        is_carry_forward: false,
        max_carry_forward_days: null,
        requires_document: true,
        is_half_day_allowed: false,
    },
    {
        leave_name: "Unpaid Leave",
        total_days: 30,
        is_paid: false,
        is_carry_forward: false,
        max_carry_forward_days: null,
        requires_document: false,
        is_half_day_allowed: true,
    },
    {
        leave_name: "Maternity Leave",
        total_days: 90,
        is_paid: true,
        is_carry_forward: false,
        max_carry_forward_days: null,
        requires_document: true,
        is_half_day_allowed: false,
    },
    {
        leave_name: "Paternity Leave",
        total_days: 7,
        is_paid: true,
        is_carry_forward: false,
        max_carry_forward_days: null,
        requires_document: false,
        is_half_day_allowed: false,
    },
    {
        leave_name: "Emergency Leave",
        total_days: 3,
        is_paid: true,
        is_carry_forward: false,
        max_carry_forward_days: null,
        requires_document: false,
        is_half_day_allowed: false,
    },
];

const LeaveTypeModel = {
    // --------------------------------------------------------
    // CREATE
    // --------------------------------------------------------

    async create(data) {
        const {
            company_id,
            leave_name,
            total_days,
            is_paid = true,
            is_carry_forward = false,
            max_carry_forward_days = null,
            requires_document = false,
            is_half_day_allowed = false,
        } = data;

        const result = await db.query(
            `INSERT INTO leave_types (
                company_id,
                leave_name,
                total_days,
                is_paid,
                is_carry_forward,
                max_carry_forward_days,
                requires_document,
                is_half_day_allowed
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [
                company_id,
                leave_name,
                total_days,
                is_paid,
                is_carry_forward,
                max_carry_forward_days,
                requires_document,
                is_half_day_allowed,
            ]
        );
        return result.rows[0];
    },

    // --------------------------------------------------------
    // CREATE — bulk seed defaults for a company (single query)
    // --------------------------------------------------------

    async seedDefaults(company_id) {
        const values = [];
        const placeholders = DEFAULT_LEAVE_TYPES.map((lt, i) => {
            const base = i * 8;
            values.push(
                company_id,
                lt.leave_name,
                lt.total_days,
                lt.is_paid,
                lt.is_carry_forward,
                lt.max_carry_forward_days,
                lt.requires_document,
                lt.is_half_day_allowed
            );
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`;
        });

        const result = await db.query(
            `INSERT INTO leave_types (
                company_id,
                leave_name,
                total_days,
                is_paid,
                is_carry_forward,
                max_carry_forward_days,
                requires_document,
                is_half_day_allowed
            ) VALUES ${placeholders.join(", ")} RETURNING *`,
            values
        );
        return result.rows;
    },

    // --------------------------------------------------------
    // READ — existence check (for onboarding UI)
    // --------------------------------------------------------

    async hasLeaveTypes(company_id) {
        const result = await db.query(
            `SELECT EXISTS (
                SELECT 1 FROM leave_types
                WHERE company_id = $1
                  AND deleted_at IS NULL
             ) AS has_leave_types`,
            [company_id]
        );
        return result.rows[0].has_leave_types;
    },

    // --------------------------------------------------------
    // READ — single record
    // --------------------------------------------------------

    async findById(id) {
        const result = await db.query(
            `SELECT * FROM leave_types
             WHERE id = $1 AND deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    },

    // --------------------------------------------------------
    // READ — company scope
    // --------------------------------------------------------

    // All leave types for a company (active + inactive)
    async getAllByCompany(company_id) {
        const result = await db.query(
            `SELECT * FROM leave_types
             WHERE company_id = $1
               AND deleted_at IS NULL
             ORDER BY leave_name ASC`,
            [company_id]
        );
        return result.rows;
    },

    // Only active leave types
    async getActiveByCompany(company_id) {
        const result = await db.query(
            `SELECT * FROM leave_types
             WHERE company_id = $1
               AND is_active  = TRUE
               AND deleted_at IS NULL
             ORDER BY leave_name ASC`,
            [company_id]
        );
        return result.rows;
    },

    // Only paid leave types
    async getPaidByCompany(company_id) {
        const result = await db.query(
            `SELECT * FROM leave_types
             WHERE company_id = $1
               AND is_paid    = TRUE
               AND is_active  = TRUE
               AND deleted_at IS NULL
             ORDER BY leave_name ASC`,
            [company_id]
        );
        return result.rows;
    },

    // Only unpaid leave types
    async getUnpaidByCompany(company_id) {
        const result = await db.query(
            `SELECT * FROM leave_types
             WHERE company_id = $1
               AND is_paid    = FALSE
               AND is_active  = TRUE
               AND deleted_at IS NULL
             ORDER BY leave_name ASC`,
            [company_id]
        );
        return result.rows;
    },

    // Only carry-forward leave types
    async getCarryForwardByCompany(company_id) {
        const result = await db.query(
            `SELECT * FROM leave_types
             WHERE company_id       = $1
               AND is_carry_forward = TRUE
               AND is_active        = TRUE
               AND deleted_at       IS NULL
             ORDER BY leave_name ASC`,
            [company_id]
        );
        return result.rows;
    },

    // --------------------------------------------------------
    // UPDATE
    // --------------------------------------------------------

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
        const query = `UPDATE leave_types SET ${updates.join(", ")}
                       WHERE id = $${paramCount}
                         AND deleted_at IS NULL
                       RETURNING *`;

        const result = await db.query(query, values);
        return result.rows[0];
    },

    async deactivate(id) {
        const result = await db.query(
            `UPDATE leave_types SET is_active = FALSE
             WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    async activate(id) {
        const result = await db.query(
            `UPDATE leave_types SET is_active = TRUE
             WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    // --------------------------------------------------------
    // DELETE — soft delete
    // --------------------------------------------------------

    async delete(id) {
        const result = await db.query(
            `UPDATE leave_types SET deleted_at = NOW()
             WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },
};

module.exports = LeaveTypeModel;