const db = require("../../config/database");

/**
 * Task categories — the buckets a company files work under (Bug, Feature,
 * Operations, ...). Company-owned: there is no global row, because one
 * company's "Operations" is not another's.
 */

const DEFAULT_TASK_CATEGORIES = [
    { name: "Bug",           description: "Something is broken and needs fixing",         color_hex: "#E5484D" },
    { name: "Feature",       description: "New capability or enhancement",                color_hex: "#3E63DD" },
    { name: "Operations",    description: "Day-to-day operational work",                  color_hex: "#F5A524" },
    { name: "Support",       description: "Customer or internal support request",         color_hex: "#12A594" },
    { name: "Documentation", description: "Written material, reports and records",        color_hex: "#8E4EC6" },
    { name: "Other",         description: "Anything that does not fit the buckets above", color_hex: "#889096" },
];

const TaskCategoryModel = {
    // --------------------------------------------------------
    // CREATE
    // --------------------------------------------------------

    async create(data) {
        const {
            company_id,
            name,
            description = null,
            color_hex = null,
            is_active = true,
        } = data;

        const result = await db.query(
            `INSERT INTO task_categories (
                company_id, name, description, color_hex, is_active
            ) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [company_id, name, description, color_hex, is_active]
        );
        return result.rows[0];
    },

    // --------------------------------------------------------
    // CREATE — bulk seed defaults for a company (single query)
    // --------------------------------------------------------

    async seedDefaults(company_id) {
        const values = [];
        const placeholders = DEFAULT_TASK_CATEGORIES.map((c, i) => {
            const base = i * 4;
            values.push(company_id, c.name, c.description, c.color_hex);
            return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
        });

        // ON CONFLICT DO NOTHING rather than failing the whole batch: a company
        // that already renamed "Bug" and kept the rest should still be able to
        // pull in the ones it is missing.
        const result = await db.query(
            `INSERT INTO task_categories (company_id, name, description, color_hex)
             VALUES ${placeholders.join(", ")}
             ON CONFLICT DO NOTHING
             RETURNING *`,
            values
        );
        return result.rows;
    },

    // --------------------------------------------------------
    // READ
    // --------------------------------------------------------

    async findById(id) {
        const result = await db.query(
            `SELECT * FROM task_categories WHERE id = $1 AND deleted_at IS NULL`,
            [id]
        );
        return result.rows[0] || null;
    },

    async findByCompany(company_id, { activeOnly = false } = {}) {
        const result = await db.query(
            `SELECT c.*,
                    (SELECT COUNT(*) FROM tasks t
                      WHERE t.category_id = c.id AND t.deleted_at IS NULL) AS task_count
               FROM task_categories c
              WHERE c.company_id = $1
                AND c.deleted_at IS NULL
                ${activeOnly ? "AND c.is_active = TRUE" : ""}
              ORDER BY c.name ASC`,
            [company_id]
        );
        return result.rows;
    },

    async hasCategories(company_id) {
        const result = await db.query(
            `SELECT 1 FROM task_categories
              WHERE company_id = $1 AND deleted_at IS NULL LIMIT 1`,
            [company_id]
        );
        return result.rowCount > 0;
    },

    // --------------------------------------------------------
    // UPDATE
    // --------------------------------------------------------

    async update(id, data) {
        const allowed = ["name", "description", "color_hex", "is_active"];
        const sets = [];
        const values = [];

        for (const field of allowed) {
            if (data[field] !== undefined) {
                values.push(data[field]);
                sets.push(`${field} = $${values.length}`);
            }
        }

        if (!sets.length) return TaskCategoryModel.findById(id);

        values.push(id);
        const result = await db.query(
            `UPDATE task_categories
                SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP
              WHERE id = $${values.length} AND deleted_at IS NULL
              RETURNING *`,
            values
        );
        return result.rows[0] || null;
    },

    // --------------------------------------------------------
    // DELETE — soft
    // --------------------------------------------------------

    async softDelete(id) {
        const result = await db.query(
            `UPDATE task_categories
                SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
              WHERE id = $1 AND deleted_at IS NULL
              RETURNING *`,
            [id]
        );
        return result.rows[0] || null;
    },

    /** Tasks still filed under this category. Blocks deletion in the service. */
    async countOpenTasks(id) {
        const result = await db.query(
            `SELECT COUNT(*)::int AS count
               FROM tasks
              WHERE category_id = $1
                AND deleted_at IS NULL
                AND status NOT IN ('completed', 'cancelled')`,
            [id]
        );
        return result.rows[0].count;
    },
};

module.exports = { TaskCategoryModel, DEFAULT_TASK_CATEGORIES };
