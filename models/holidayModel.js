const db = require("../config/database");

const Holiday = {
    // --------------------------------------------------------
    // CREATE
    // --------------------------------------------------------

    async create(data) {
        const {
            company_id,
            branch_id = null,
            holiday_name,
            holiday_type = "public",
            holiday_start_date,
            holiday_end_date,
            is_company_wide = false,
            description = null,
        } = data;

        const result = await db.query(
            `INSERT INTO holidays (
                company_id, branch_id,
                holiday_name, holiday_type,
                holiday_start_date, holiday_end_date,
                is_company_wide, description
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [
                company_id, branch_id,
                holiday_name, holiday_type,
                holiday_start_date, holiday_end_date,
                is_company_wide, description,
            ]
        );
        return result.rows[0];
    },

    // --------------------------------------------------------
    // READ — single record
    // --------------------------------------------------------

    async findById(id) {
        const result = await db.query(
            `SELECT * FROM holidays
             WHERE id = $1 AND deleted_at IS NULL`,
            [id]
        );
        return result.rows[0];
    },

    // --------------------------------------------------------
    // READ — company scope
    // --------------------------------------------------------

    // All holidays for a company (both company-wide + all branch-specific)
    async getAllByCompany(company_id) {
        const result = await db.query(
            `SELECT * FROM holidays
             WHERE company_id = $1
               AND deleted_at IS NULL
             ORDER BY holiday_start_date ASC`,
            [company_id]
        );
        return result.rows;
    },

    // Only company-wide holidays (no branch_id)
    async getCompanyWide(company_id) {
        const result = await db.query(
            `SELECT * FROM holidays
             WHERE company_id    = $1
               AND is_company_wide = TRUE
               AND deleted_at    IS NULL
             ORDER BY holiday_start_date ASC`,
            [company_id]
        );
        return result.rows;
    },

    // --------------------------------------------------------
    // READ — branch scope
    // --------------------------------------------------------

    // All holidays applicable to a specific branch:
    // company-wide holidays UNION branch-specific holidays
    async getAllByBranch(company_id, branch_id) {
        const result = await db.query(
            `SELECT * FROM holidays
             WHERE company_id = $1
               AND deleted_at IS NULL
               AND is_active  = TRUE
               AND (
                     is_company_wide = TRUE
                  OR branch_id       = $2
                   )
             ORDER BY holiday_start_date ASC`,
            [company_id, branch_id]
        );
        return result.rows;
    },

    // Only branch-specific holidays (excludes company-wide)
    async getBranchSpecific(company_id, branch_id) {
        const result = await db.query(
            `SELECT * FROM holidays
             WHERE company_id    = $1
               AND branch_id     = $2
               AND is_company_wide = FALSE
               AND deleted_at    IS NULL
             ORDER BY holiday_start_date ASC`,
            [company_id, branch_id]
        );
        return result.rows;
    },

    // --------------------------------------------------------
    // READ — date / attendance helpers
    // --------------------------------------------------------

    // Check if a given date is a holiday for a branch
    // Returns true/false — used by attendance check-in/out logic
    async isHoliday(company_id, branch_id, date) {
        const result = await db.query(
            `SELECT EXISTS (
                SELECT 1 FROM holidays
                WHERE company_id = $1
                  AND deleted_at IS NULL
                  AND is_active  = TRUE
                  AND $3         BETWEEN holiday_start_date AND holiday_end_date
                  AND (
                        is_company_wide = TRUE
                     OR branch_id       = $2
                      )
             ) AS is_holiday`,
            [company_id, branch_id, date]
        );
        return result.rows[0].is_holiday;
    },

    // Get holidays within a date range for a branch (e.g. monthly payroll run)
    async getByDateRange(company_id, branch_id, from_date, to_date) {
        const result = await db.query(
            `SELECT * FROM holidays
             WHERE company_id = $1
               AND deleted_at IS NULL
               AND is_active  = TRUE
               AND holiday_start_date <= $4
               AND holiday_end_date   >= $3
               AND (
                     is_company_wide = TRUE
                  OR branch_id       = $2
                   )
             ORDER BY holiday_start_date ASC`,
            [company_id, branch_id, from_date, to_date]
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
        const query = `UPDATE holidays SET ${updates.join(", ")}
                       WHERE id = $${paramCount}
                         AND deleted_at IS NULL
                       RETURNING *`;

        const result = await db.query(query, values);
        return result.rows[0];
    },

    async deactivate(id) {
        const result = await db.query(
            `UPDATE holidays SET is_active = FALSE
             WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    async activate(id) {
        const result = await db.query(
            `UPDATE holidays SET is_active = TRUE
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
            `UPDATE holidays SET deleted_at = NOW()
             WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },
};

module.exports = Holiday;