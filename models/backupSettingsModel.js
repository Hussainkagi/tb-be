const db = require("../config/database");

/**
 * Per-company monthly-backup opt-in. One row per company, created lazily on
 * first read/write — a company that never touched Backup settings has no row,
 * which getByCompany surfaces as `null` rather than a row of defaults, so the
 * frontend can tell "never configured" apart from "explicitly disabled".
 */
const BackupSettingsModel = {
    async getByCompany(company_id) {
        const result = await db.query(
            `SELECT * FROM company_backup_settings WHERE company_id = $1`,
            [company_id]
        );
        return result.rows[0] || null;
    },

    async upsert(company_id, { is_enabled, day_of_month, updated_by }) {
        const result = await db.query(
            `INSERT INTO company_backup_settings (company_id, is_enabled, day_of_month, updated_by)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (company_id) DO UPDATE SET
                is_enabled   = EXCLUDED.is_enabled,
                day_of_month = EXCLUDED.day_of_month,
                updated_by   = EXCLUDED.updated_by
             RETURNING *`,
            [company_id, is_enabled, day_of_month, updated_by || null]
        );
        return result.rows[0];
    },

    async markDispatched(company_id, yearMonth) {
        await db.query(
            `UPDATE company_backup_settings SET last_scheduled_month = $2 WHERE company_id = $1`,
            [company_id, yearMonth]
        );
    },

    /**
     * Every company with the monthly backup enabled. The job evaluates each
     * one against ITS OWN local date in JS (luxon) — the same per-timezone
     * approach jobs/birthdayNotificationJob.js uses for birthdays — rather
     * than pushing date math into SQL across mixed timezones.
     */
    async getAllEnabled() {
        const result = await db.query(
            `SELECT cbs.*, c.company_name, c.timezone
             FROM company_backup_settings cbs
             JOIN companies c ON c.id = cbs.company_id
             WHERE cbs.is_enabled = TRUE
               AND c.deleted_at IS NULL
               AND c.is_active = TRUE`
        );
        return result.rows;
    },
};

module.exports = BackupSettingsModel;
