const db = require("../config/database");

const BackupJobModel = {
    async create({ company_id, job_type, trigger_type, scope = [], requested_by = null }) {
        const result = await db.query(
            `INSERT INTO company_data_jobs (company_id, job_type, trigger_type, scope, requested_by)
             VALUES ($1, $2, $3, $4::jsonb, $5)
             RETURNING *`,
            [company_id, job_type, trigger_type, JSON.stringify(scope), requested_by]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT * FROM company_data_jobs WHERE id = $1`,
            [id]
        );
        return result.rows[0] || null;
    },

    async markProcessing(id) {
        const result = await db.query(
            `UPDATE company_data_jobs SET status = 'processing', started_at = NOW()
             WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    async markCompleted(id, { file_bytes = null, summary = null } = {}) {
        const result = await db.query(
            `UPDATE company_data_jobs
             SET status = 'completed', completed_at = NOW(),
                 file_bytes = $2, summary = $3::jsonb
             WHERE id = $1 RETURNING *`,
            [id, file_bytes, summary ? JSON.stringify(summary) : null]
        );
        return result.rows[0];
    },

    async markFailed(id, error_message) {
        const result = await db.query(
            `UPDATE company_data_jobs
             SET status = 'failed', completed_at = NOW(), error_message = $2
             WHERE id = $1 RETURNING *`,
            [id, String(error_message).slice(0, 2000)]
        );
        return result.rows[0];
    },

    async listByCompany(company_id, { limit = 20 } = {}) {
        const result = await db.query(
            `SELECT * FROM company_data_jobs
             WHERE company_id = $1
             ORDER BY created_at DESC
             LIMIT $2`,
            [company_id, limit]
        );
        return result.rows;
    },

    /**
     * Most recent manual export for this company that isn't a failure — the
     * once-a-week throttle. A failed attempt must not count against the
     * admin, otherwise a transient error (mail outage, oversized workbook)
     * would lock them out for a week with nothing to show for it.
     */
    async findRecentManualExport(company_id, sinceDate) {
        const result = await db.query(
            `SELECT * FROM company_data_jobs
             WHERE company_id = $1
               AND job_type = 'export'
               AND trigger_type = 'manual'
               AND status != 'failed'
               AND created_at >= $2
             ORDER BY created_at DESC
             LIMIT 1`,
            [company_id, sinceDate]
        );
        return result.rows[0] || null;
    },

};

module.exports = BackupJobModel;
