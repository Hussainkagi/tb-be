const { scheduleJob } = require("./scheduler");
const { DateTime } = require("luxon");
const BackupSettingsModel = require("../models/backupSettingsModel");
const BackupJobModel = require("../models/backupJobModel");
const backupService = require("../service/backupService");

// ─────────────────────────────────────────────────────────────────────────────
// MONTHLY EMAILED BACKUP
//
// Same shape as jobs/birthdayNotificationJob.js: run hourly, evaluate every
// opted-in company against ITS OWN local date (a company on UTC+4 rolls over
// to a new day 4 hours before UTC does), and rely on a stamped "already
// dispatched this month" marker for idempotency rather than trying to hit the
// exact right hour once.
//
// day_of_month is clamped to the real length of the company's current local
// month, so a company that picked day 28 fires reliably in February and a
// company that picked something invalid never gets skipped.
// ─────────────────────────────────────────────────────────────────────────────

function isBackupDueToday(setting, localDate) {
    if (setting.last_scheduled_month === localDate.toFormat("yyyy-LL")) return false;
    const lastDayOfMonth = localDate.daysInMonth;
    const targetDay = Math.min(setting.day_of_month, lastDayOfMonth);
    return localDate.day === targetDay;
}

async function runBackupExportJob() {
    console.log(`[CRON][${new Date().toISOString()}] Monthly backup export job started`);

    try {
        const settings = await BackupSettingsModel.getAllEnabled();
        console.log(`[CRON] Companies with monthly backup enabled: ${settings.length}`);

        let dispatched = 0;

        for (const setting of settings) {
            try {
                const tz = setting.timezone || "UTC";
                const localDate = DateTime.now().setZone(tz).startOf("day");

                if (!isBackupDueToday(setting, localDate)) continue;

                const job = await BackupJobModel.create({
                    company_id: setting.company_id,
                    job_type: "export",
                    trigger_type: "scheduled",
                    scope: backupService.SECTIONS.map((s) => s.key),
                });

                await backupService.runExportJob(job.id);
                dispatched++;
            } catch (companyError) {
                console.error(
                    `[CRON] Backup export failed for company ${setting.company_id}:`,
                    companyError.message
                );
            }
        }

        console.log(`[CRON] Monthly backup export job complete — dispatched: ${dispatched}`);
        return { dispatched };
    } catch (error) {
        console.error("[CRON] Monthly backup export job FAILED:", error.message, error.stack);
    }
}

scheduleJob("monthly-backup-export", "15 * * * *", runBackupExportJob, { timezone: "UTC" });

module.exports = { runBackupExportJob, isBackupDueToday };
