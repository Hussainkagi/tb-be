const backupService = require("../service/backupService");
const BackupSettingsModel = require("../models/backupSettingsModel");
const BackupJobModel = require("../models/backupJobModel");

const VALID_DAY = (d) => Number.isInteger(d) && d >= 1 && d <= 28;

const BackupController = {
    /**
     * GET /companies/:company_id/backup/catalog
     * The sections a backup can include, and what's permanently excluded —
     * drives the "what's backed up" panel and the download-now section picker.
     */
    getCatalog(_req, res) {
        return res.status(200).json({
            success: true,
            data: {
                sections: backupService.getSectionCatalog(),
                excluded: backupService.EXCLUDED_NOTES,
            },
        });
    },

    /**
     * GET /companies/:company_id/backup/settings
     */
    async getSettings(req, res) {
        try {
            const settings = await BackupSettingsModel.getByCompany(req.params.company_id);
            return res.status(200).json({ success: true, data: settings });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Failed to load backup settings.", error: error.message });
        }
    },

    /**
     * PUT /companies/:company_id/backup/settings
     * Body: { is_enabled, day_of_month }
     */
    async updateSettings(req, res) {
        try {
            const { company_id } = req.params;
            const { is_enabled, day_of_month } = req.body;

            if (is_enabled && !VALID_DAY(day_of_month)) {
                return res.status(400).json({
                    success: false,
                    message: "day_of_month must be a whole number between 1 and 28.",
                });
            }

            const settings = await BackupSettingsModel.upsert(company_id, {
                is_enabled: !!is_enabled,
                day_of_month: day_of_month || 1,
                updated_by: req.user.user_id,
            });

            return res.status(200).json({ success: true, data: settings });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Failed to update backup settings.", error: error.message });
        }
    },

    /**
     * GET /companies/:company_id/backup/jobs
     */
    async listJobs(req, res) {
        try {
            const jobs = await BackupJobModel.listByCompany(req.params.company_id, { limit: 20 });
            const throttle = await backupService.checkWeeklyThrottle(req.params.company_id);
            return res.status(200).json({ success: true, data: { jobs, throttle } });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Failed to load backup history.", error: error.message });
        }
    },

    /**
     * GET /companies/:company_id/backup/jobs/:job_id
     * Polled by the frontend while an export/restore is running.
     */
    async getJob(req, res) {
        try {
            const job = await BackupJobModel.findById(req.params.job_id);
            if (!job || String(job.company_id) !== String(req.params.company_id)) {
                return res.status(404).json({ success: false, message: "Job not found." });
            }
            return res.status(200).json({ success: true, data: job });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Failed to load job status.", error: error.message });
        }
    },

    /**
     * POST /companies/:company_id/backup/export
     * Body: { sections?: string[] }  — omit for everything.
     *
     * Kicks the workbook build + email off in the background (this codebase
     * has no job queue — node-cron is the only other background mechanism —
     * so "background" here means "not awaited in this request") and returns
     * immediately with a job id to poll.
     */
    async requestExport(req, res) {
        try {
            const { company_id } = req.params;
            const throttle = await backupService.checkWeeklyThrottle(company_id);

            if (!throttle.allowed) {
                return res.status(429).json({
                    success: false,
                    code: "BACKUP_THROTTLED",
                    message: "An on-demand backup was already generated this week. Try again after the date shown.",
                    data: throttle,
                });
            }

            const validKeys = new Set(backupService.SECTIONS.map((s) => s.key));
            const sections = Array.isArray(req.body.sections) && req.body.sections.length
                ? req.body.sections.filter((k) => validKeys.has(k))
                : backupService.SECTIONS.map((s) => s.key);

            const job = await BackupJobModel.create({
                company_id,
                job_type: "export",
                trigger_type: "manual",
                scope: sections,
                requested_by: req.user.user_id,
            });

            // Fire and forget — the response carries the job id for polling.
            backupService.runExportJob(job.id).catch((err) =>
                console.error(`[Backup] Unhandled export job error (${job.id}):`, err.message)
            );

            return res.status(202).json({ success: true, data: job });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Failed to start backup export.", error: error.message });
        }
    },

    /**
     * POST /companies/:company_id/backup/restore
     * multipart/form-data, field "file" — the previously downloaded backup.
     */
    async requestRestore(req, res) {
        if (!req.file) {
            return res.status(400).json({ success: false, message: "No file uploaded. Send it in a field named 'file'." });
        }

        try {
            const { company_id } = req.params;

            const job = await BackupJobModel.create({
                company_id,
                job_type: "restore",
                trigger_type: "manual",
                scope: [],
                requested_by: req.user.user_id,
            });

            backupService.runRestoreJob(job.id, req.file.buffer).catch((err) =>
                console.error(`[Backup] Unhandled restore job error (${job.id}):`, err.message)
            );

            return res.status(202).json({ success: true, data: job });
        } catch (error) {
            return res.status(500).json({ success: false, message: "Failed to start data restore.", error: error.message });
        }
    },
};

module.exports = BackupController;
