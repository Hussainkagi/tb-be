const XLSX = require("xlsx");
const db = require("../config/database");
const CompanyModel = require("../models/companyModel");
const UserCompanyModel = require("../models/userCompanyModel");
const BackupJobModel = require("../models/backupJobModel");
const BackupSettingsModel = require("../models/backupSettingsModel");
const { sendEmail } = require("../utils/mailer");
const { backupReadyEmail, backupFailedEmail } = require("../utils/emailTemplates");
const { Role } = require("../enums/roles");

// ─────────────────────────────────────────────────────────────────────────────
// BACKUP & RESTORE
//
// One XLSX workbook, one sheet per section, covers a company's full data —
// everything payroll-relevant, minus anything that is audit trail, transient,
// or platform-level (see the exclusion note in each caller-facing surface:
// controller/backupController.js and the frontend Backup settings page).
//
// SECTIONS is read by BOTH export (fetch + write sheets) and restore
// (delete + insert), in the SAME array, so the two can never drift out of
// sync with each other. Restore deletes in REVERSE of this order (children
// before parents) and inserts in FORWARD order (parents before children) —
// this order is exactly the tables' FK dependency graph, verified against
// every migration file under database/migration/.
//
// Two columns need special handling because the graph isn't a pure DAG in
// insert order: departments.head_employee_id and employees.manager_id both
// point at rows that don't exist yet at insert time (a department's head is
// an employee; an employee's manager is another employee). Both are declared
// `deferredColumns` below — restoreAllSections() inserts the row with that
// column NULLed out, remembers the real value, and backfills it with an
// UPDATE once every row in the workbook exists.
// ─────────────────────────────────────────────────────────────────────────────

const FORMAT_VERSION = 1;
const META_SHEET = "_meta";

// Resend's hard cap is 40MB per email; base64 inflates a raw buffer by ~33%,
// so 20MB of actual XLSX bytes is a safe ceiling that leaves headroom.
const MAX_WORKBOOK_BYTES = 20 * 1024 * 1024;

const WEEKLY_THROTTLE_MS = 7 * 24 * 60 * 60 * 1000;

const SECTIONS = [
    {
        key: "company_profile",
        label: "Company profile",
        sheetName: "Company",
        mode: "update_only",
        sql: `SELECT company_name, logo_url, email, phone, country, country_code, timezone, currency
              FROM companies WHERE id = $1`,
    },
    {
        key: "payroll_settings",
        label: "Payroll settings",
        table: "payroll_settings",
        sheetName: "PayrollSettings",
        sql: `SELECT * FROM payroll_settings WHERE company_id = $1`,
    },
    {
        key: "branches",
        label: "Branches",
        table: "branches",
        sheetName: "Branches",
        sql: `SELECT * FROM branches WHERE company_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    },
    {
        key: "departments",
        label: "Departments",
        table: "departments",
        sheetName: "Departments",
        deferredColumns: ["head_employee_id"],
        sql: `SELECT * FROM departments WHERE company_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    },
    {
        key: "shifts",
        label: "Shifts",
        table: "shifts",
        sheetName: "Shifts",
        sql: `SELECT * FROM shifts WHERE company_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    },
    {
        key: "holidays",
        label: "Holidays",
        table: "holidays",
        sheetName: "Holidays",
        sql: `SELECT holidays.*,
                     to_char(holiday_start_date, 'YYYY-MM-DD') AS holiday_start_date,
                     to_char(holiday_end_date,   'YYYY-MM-DD') AS holiday_end_date
              FROM holidays WHERE company_id = $1 AND deleted_at IS NULL ORDER BY holidays.holiday_start_date`,
    },
    {
        key: "employees",
        label: "Employees",
        table: "employees",
        sheetName: "Employees",
        deferredColumns: ["manager_id"],
        sql: `SELECT employees.*,
                     to_char(joining_date,  'YYYY-MM-DD') AS joining_date,
                     to_char(date_of_birth, 'YYYY-MM-DD') AS date_of_birth,
                     to_char(exit_date,     'YYYY-MM-DD') AS exit_date
              FROM employees WHERE company_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    },
    {
        key: "attendance",
        label: "Attendance",
        table: "attendance",
        sheetName: "Attendance",
        sql: `SELECT attendance.*,
                     to_char(attendance_date, 'YYYY-MM-DD') AS attendance_date
              FROM attendance WHERE company_id = $1 ORDER BY attendance.attendance_date`,
    },
    {
        key: "employee_bank_accounts",
        label: "Employee bank details",
        table: "employee_bank_accounts",
        sheetName: "BankAccounts",
        jsonColumns: ["extra"],
        sql: `SELECT * FROM employee_bank_accounts WHERE company_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    },
    {
        key: "employee_salary_structures",
        label: "Salary structures",
        table: "employee_salary_structures",
        sheetName: "SalaryStructures",
        sql: `SELECT employee_salary_structures.*,
                     to_char(effective_from, 'YYYY-MM-DD') AS effective_from,
                     to_char(effective_to,   'YYYY-MM-DD') AS effective_to
              FROM employee_salary_structures WHERE company_id = $1 ORDER BY created_at`,
    },
    {
        key: "employee_gratuity_configs",
        label: "Gratuity configuration",
        table: "employee_gratuity_configs",
        sheetName: "GratuityConfigs",
        jsonColumns: ["tiers"],
        sql: `SELECT employee_gratuity_configs.*,
                     to_char(service_start_date, 'YYYY-MM-DD') AS service_start_date
              FROM employee_gratuity_configs WHERE company_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    },
    {
        key: "leave_types",
        label: "Leave types",
        table: "leave_types",
        sheetName: "LeaveTypes",
        sql: `SELECT * FROM leave_types WHERE company_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    },
    {
        key: "leave_requests",
        label: "Leave requests",
        table: "leave_requests",
        sheetName: "LeaveRequests",
        sql: `SELECT leave_requests.*,
                     to_char(from_date, 'YYYY-MM-DD') AS from_date,
                     to_char(to_date,   'YYYY-MM-DD') AS to_date
              FROM leave_requests WHERE company_id = $1 AND deleted_at IS NULL ORDER BY leave_requests.from_date`,
    },
    {
        key: "leave_salary_configs",
        label: "Leave salary configuration",
        table: "leave_salary_configs",
        sheetName: "LeaveSalaryConfig",
        sql: `SELECT leave_salary_configs.*,
                     to_char(opening_balance_cutoff_date, 'YYYY-MM-DD') AS opening_balance_cutoff_date
              FROM leave_salary_configs WHERE company_id = $1 AND deleted_at IS NULL`,
    },
    {
        key: "employee_leave_salary_configs",
        label: "Employee leave salary configuration",
        table: "employee_leave_salary_configs",
        sheetName: "EmployeeLeaveSalaryCfg",
        sql: `SELECT employee_leave_salary_configs.*,
                     to_char(accrual_start_date,    'YYYY-MM-DD') AS accrual_start_date,
                     to_char(opening_balance_as_of, 'YYYY-MM-DD') AS opening_balance_as_of
              FROM employee_leave_salary_configs WHERE company_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
    },
    {
        key: "leave_salary_accruals",
        label: "Leave salary accrual ledger",
        table: "leave_salary_accruals",
        sheetName: "LeaveSalaryAccruals",
        sql: `SELECT leave_salary_accruals.*,
                     to_char(period_end_date, 'YYYY-MM-DD') AS period_end_date
              FROM leave_salary_accruals WHERE company_id = $1 ORDER BY leave_salary_accruals.period_end_date`,
    },
    {
        key: "leave_salary_advances",
        label: "Leave salary advances",
        table: "leave_salary_advances",
        sheetName: "LeaveSalaryAdvances",
        sql: `SELECT leave_salary_advances.*,
                     to_char(leave_from_date, 'YYYY-MM-DD') AS leave_from_date,
                     to_char(leave_to_date,   'YYYY-MM-DD') AS leave_to_date
              FROM leave_salary_advances WHERE company_id = $1 ORDER BY created_at`,
    },
    {
        key: "leave_salary_encashments",
        label: "Leave salary encashments",
        table: "leave_salary_encashments",
        sheetName: "LeaveSalaryEncashments",
        sql: `SELECT leave_salary_encashments.*,
                     to_char(effective_date, 'YYYY-MM-DD') AS effective_date
              FROM leave_salary_encashments WHERE company_id = $1 ORDER BY created_at`,
    },
    {
        key: "employee_separations",
        label: "Offboarding / separations",
        table: "employee_separations",
        sheetName: "Separations",
        jsonColumns: ["clearance_checklist"],
        sql: `SELECT employee_separations.*,
                     to_char(requested_last_working_date, 'YYYY-MM-DD') AS requested_last_working_date,
                     to_char(notice_start_date,           'YYYY-MM-DD') AS notice_start_date,
                     to_char(last_working_date,           'YYYY-MM-DD') AS last_working_date
              FROM employee_separations WHERE company_id = $1 AND deleted_at IS NULL ORDER BY submitted_at`,
    },
    {
        key: "employee_final_settlements",
        label: "Final settlements",
        table: "employee_final_settlements",
        sheetName: "FinalSettlements",
        jsonColumns: ["calculation_snapshot"],
        sql: `SELECT employee_final_settlements.*,
                     to_char(last_working_date, 'YYYY-MM-DD') AS last_working_date
              FROM employee_final_settlements WHERE company_id = $1 ORDER BY created_at`,
    },
    {
        key: "payroll_periods",
        label: "Payroll periods",
        table: "payroll_periods",
        sheetName: "PayrollPeriods",
        sql: `SELECT payroll_periods.*,
                     to_char(start_date, 'YYYY-MM-DD') AS start_date,
                     to_char(end_date,   'YYYY-MM-DD') AS end_date
              FROM payroll_periods WHERE company_id = $1 ORDER BY payroll_periods.start_date`,
    },
    {
        key: "payroll_runs",
        label: "Payroll runs",
        table: "payroll_runs",
        sheetName: "PayrollRuns",
        sql: `SELECT * FROM payroll_runs WHERE company_id = $1 ORDER BY created_at`,
    },
    {
        key: "payrolls",
        label: "Payroll records",
        table: "payrolls",
        sheetName: "Payrolls",
        sql: `SELECT * FROM payrolls WHERE company_id = $1 ORDER BY created_at`,
    },
    {
        key: "payroll_adjustments",
        label: "Payroll adjustments",
        table: "payroll_adjustments",
        sheetName: "PayrollAdjustments",
        deleteSql: `DELETE FROM payroll_adjustments WHERE payroll_id IN (SELECT id FROM payrolls WHERE company_id = $1)`,
        sql: `SELECT pa.* FROM payroll_adjustments pa
              JOIN payrolls p ON p.id = pa.payroll_id
              WHERE p.company_id = $1 ORDER BY pa.created_at`,
    },
    {
        key: "payslips",
        label: "Payslips",
        table: "payslips",
        sheetName: "Payslips",
        deleteSql: `DELETE FROM payslips WHERE payroll_id IN (SELECT id FROM payrolls WHERE company_id = $1)`,
        sql: `SELECT ps.* FROM payslips ps
              JOIN payrolls p ON p.id = ps.payroll_id
              WHERE p.company_id = $1 ORDER BY ps.generated_at`,
    },
];

// What the UI shows an admin BEFORE they enable/download a backup, and what
// stays out no matter what — see components/settings/BackupSettings.tsx.
const EXCLUDED_NOTES = [
    "Activity logs / audit trail",
    "Notifications (in-app + push) and device tokens",
    "Admin inbox messages",
    "OTP records",
    "Payroll daily attendance breakdown lines (regenerated from attendance + payroll automatically)",
    "Uploaded document files (contracts, IDs, etc.) — only other records reference their filenames, not the files themselves",
    "Legal policies / terms & conditions (platform-level, not company data)",
    "The company's subscription plan and billing state (never changed by a restore)",
];

// "company_profile" is always included in every export (see buildWorkbook)
// and isn't a meaningful choice, so it's left out of the picker the frontend
// builds from this.
function getSectionCatalog() {
    return SECTIONS.filter((s) => s.key !== "company_profile").map((s) => ({ key: s.key, label: s.label }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Row ↔ spreadsheet-cell normalisation
// ─────────────────────────────────────────────────────────────────────────────

// A JSONB column comes back from pg as a parsed object/array — write it to the
// sheet as JSON text (a raw object would otherwise stringify to
// "[object Object]"). Any other Date instance still on the row (created_at,
// approved_at, etc. — every true DATE column was already cast to text in the
// SQL above) is safe to widen to a full ISO instant.
function normalizeRowForSheet(row, jsonColumns) {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
        if (jsonColumns.includes(key)) {
            out[key] = value == null ? null : JSON.stringify(value);
        } else if (value instanceof Date) {
            out[key] = value.toISOString();
        } else {
            out[key] = value;
        }
    }
    return out;
}

function buildMetaRows(meta) {
    return Object.entries(meta).map(([key, value]) => ({
        key,
        value: Array.isArray(value) || (value && typeof value === "object")
            ? JSON.stringify(value)
            : String(value),
    }));
}

function readMetaSheet(workbook) {
    const sheet = workbook.Sheets[META_SHEET];
    if (!sheet) return null;

    const rows = XLSX.utils.sheet_to_json(sheet, { defval: null });
    const meta = {};
    for (const row of rows) {
        if (!row.key) continue;
        meta[row.key] = row.value;
    }
    if (!meta.company_id) return null;

    if (typeof meta.sections_included === "string") {
        try {
            meta.sections_included = JSON.parse(meta.sections_included);
        } catch {
            meta.sections_included = [];
        }
    }
    return meta;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────────────────────

async function buildWorkbook(company_id, sectionKeys, company) {
    const wanted = new Set(
        sectionKeys && sectionKeys.length ? sectionKeys : SECTIONS.map((s) => s.key)
    );
    // The company profile and payroll settings are always included — they are
    // not "data" an admin would deliberately leave out, and restore depends on
    // the profile sheet existing.
    wanted.add("company_profile");

    const workbook = XLSX.utils.book_new();
    const includedSections = SECTIONS.filter((s) => wanted.has(s.key));

    XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.json_to_sheet(
            buildMetaRows({
                format_version: FORMAT_VERSION,
                company_id,
                company_name: company?.company_name || "",
                exported_at: new Date().toISOString(),
                sections_included: includedSections.map((s) => s.key),
            })
        ),
        META_SHEET
    );

    for (const section of includedSections) {
        const { rows } = await db.query(section.sql, [company_id]);
        const normalized = rows.map((r) => normalizeRowForSheet(r, section.jsonColumns || []));
        XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(normalized), section.sheetName);
    }

    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
    return { buffer, sections: includedSections.map((s) => s.key) };
}

// ─────────────────────────────────────────────────────────────────────────────
// RESTORE
// ─────────────────────────────────────────────────────────────────────────────

async function insertRow(client, table, row, jsonColumns) {
    const cols = Object.keys(row);
    if (cols.length === 0) return;
    const values = cols.map((c) => row[c]);
    const placeholders = cols.map((c, i) => (jsonColumns.includes(c) ? `$${i + 1}::jsonb` : `$${i + 1}`));
    await client.query(
        `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${placeholders.join(", ")})`,
        values
    );
}

async function updateCompanyProfile(client, company_id, row) {
    if (!row) return;
    await client.query(
        `UPDATE companies SET
            company_name = $1, logo_url = $2, email = $3, phone = $4,
            country = $5, country_code = $6, timezone = $7, currency = $8
         WHERE id = $9`,
        [
            row.company_name, row.logo_url, row.email, row.phone,
            row.country, row.country_code, row.timezone, row.currency,
            company_id,
        ]
    );
}

/**
 * Wipes and reloads every backed-up table for one company inside a single
 * transaction. `sectionRows` is keyed by section.key → array of plain row
 * objects, exactly as parsed off the workbook's sheets.
 *
 * Returns { [section.key]: rowsRestored } once the transaction has been
 * built — the caller is responsible for COMMIT/ROLLBACK around this call.
 */
async function restoreAllSections(client, company_id, sectionRows) {
    const dataSections = SECTIONS.filter((s) => s.mode !== "update_only");

    // 1. Company profile — UPDATE, never delete/insert.
    const profileRows = sectionRows.company_profile || [];
    await updateCompanyProfile(client, company_id, profileRows[0]);

    // 2. DELETE existing rows, children before parents.
    for (const section of [...dataSections].reverse()) {
        const sql = section.deleteSql || `DELETE FROM ${section.table} WHERE company_id = $1`;
        await client.query(sql, [company_id]);
    }

    // 3. INSERT the workbook's rows, parents before children. Any column that
    // points at a row inserted LATER in this same pass (department heads,
    // employee managers) is nulled here and backfilled in step 4.
    const deferred = [];
    const summary = { company_profile: profileRows.length ? 1 : 0 };

    for (const section of dataSections) {
        const rows = sectionRows[section.key] || [];
        let count = 0;

        for (const raw of rows) {
            // Defense in depth: never let a row claiming a different tenant
            // slip in, even though the _meta company_id check already gates
            // the whole file at a higher level.
            if (
                Object.prototype.hasOwnProperty.call(raw, "company_id") &&
                raw.company_id &&
                String(raw.company_id) !== String(company_id)
            ) {
                continue;
            }

            const row = { ...raw };
            for (const col of section.deferredColumns || []) {
                if (row[col] != null) {
                    deferred.push({ table: section.table, id: row.id, column: col, value: row[col] });
                }
                row[col] = null;
            }

            await insertRow(client, section.table, row, section.jsonColumns || []);
            count++;
        }

        summary[section.key] = count;
    }

    // 4. Backfill the deferred self/forward references.
    for (const b of deferred) {
        await client.query(`UPDATE ${b.table} SET ${b.column} = $1 WHERE id = $2`, [b.value, b.id]);
    }

    return summary;
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL RECIPIENTS
// ─────────────────────────────────────────────────────────────────────────────

async function getAdminEmails(company_id) {
    const members = await UserCompanyModel.findAllByCompanyId(company_id);
    return members
        .filter((m) => Number(m.role) === Role.ADMIN && m.email)
        .map((m) => m.email);
}

async function getUserEmail(user_id) {
    if (!user_id) return null;
    const { rows } = await db.query(`SELECT email FROM users WHERE id = $1`, [user_id]);
    return rows[0]?.email || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// JOBS
// ─────────────────────────────────────────────────────────────────────────────

function currentYearMonth(timezone) {
    // 'sv-SE' formats as YYYY-MM-DD, which slices cleanly to YYYY-MM.
    return new Date().toLocaleDateString("sv-SE", { timeZone: timezone || "UTC" }).slice(0, 7);
}

function backupFilename(company, suffix = "backup") {
    const code = (company?.company_code || "company").toLowerCase().replace(/[^a-z0-9]/g, "-");
    return `${code}-${suffix}-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

async function runExportJob(job_id) {
    const job = await BackupJobModel.findById(job_id);
    if (!job) return;

    await BackupJobModel.markProcessing(job_id);

    try {
        const company = await CompanyModel.findById(job.company_id);
        if (!company) throw new Error("Company not found.");

        const sectionKeys = Array.isArray(job.scope) && job.scope.length
            ? job.scope
            : SECTIONS.map((s) => s.key);

        const { buffer, sections } = await buildWorkbook(job.company_id, sectionKeys, company);

        if (buffer.length > MAX_WORKBOOK_BYTES) {
            await BackupJobModel.markFailed(
                job_id,
                `The backup file is too large to email (${(buffer.length / 1024 / 1024).toFixed(1)}MB). ` +
                `Try again with fewer sections selected.`
            );
            return;
        }

        const recipients = job.trigger_type === "scheduled"
            ? await getAdminEmails(job.company_id)
            : [await getUserEmail(job.requested_by)].filter(Boolean);

        if (recipients.length === 0) {
            await BackupJobModel.markFailed(job_id, "No recipient email could be resolved for this backup.");
            return;
        }

        const html = backupReadyEmail({
            company_name: company.company_name,
            sections: sections.map((key) => SECTIONS.find((s) => s.key === key)?.label || key),
            is_scheduled: job.trigger_type === "scheduled",
            generated_at: new Date(),
        });

        const attachments = [{ filename: backupFilename(company), content: buffer }];

        for (const to of recipients) {
            await sendEmail({
                to,
                subject: `${company.company_name} — your data backup is ready`,
                html,
                attachments,
            });
        }

        await BackupJobModel.markCompleted(job_id, {
            file_bytes: buffer.length,
            summary: { sections, recipients: recipients.length },
        });

        if (job.trigger_type === "scheduled") {
            await BackupSettingsModel.markDispatched(job.company_id, currentYearMonth(company.timezone));
        }
    } catch (error) {
        console.error(`[Backup] Export job ${job_id} failed:`, error.message);
        await BackupJobModel.markFailed(job_id, error.message);
        try {
            const company = await CompanyModel.findById(job.company_id);
            const to = job.trigger_type === "manual" ? await getUserEmail(job.requested_by) : null;
            if (to && company) {
                await sendEmail({
                    to,
                    subject: `${company.company_name} — your data backup failed`,
                    html: backupFailedEmail({ company_name: company.company_name, error_message: error.message }),
                });
            }
        } catch {
            // A failure notification failing too must not mask the original error.
        }
    }
}

async function runRestoreJob(job_id, fileBuffer) {
    const job = await BackupJobModel.findById(job_id);
    if (!job) return;

    await BackupJobModel.markProcessing(job_id);

    try {
        const company = await CompanyModel.findById(job.company_id);
        if (!company) throw new Error("Company not found.");

        let workbook;
        try {
            workbook = XLSX.read(fileBuffer, { type: "buffer" });
        } catch {
            throw new Error("This file could not be read as a backup workbook (.xlsx).");
        }

        const meta = readMetaSheet(workbook);
        if (!meta) {
            throw new Error("This file is missing its backup metadata sheet and cannot be restored.");
        }
        if (String(meta.company_id) !== String(job.company_id)) {
            throw new Error("This backup file was exported from a different company and cannot be restored here.");
        }

        // Safety net: a full export of the CURRENT data, emailed to the
        // requester before anything is touched, so a bad restore is
        // recoverable.
        const requesterEmail = await getUserEmail(job.requested_by);
        try {
            const { buffer: safetyBuffer } = await buildWorkbook(
                job.company_id,
                SECTIONS.map((s) => s.key),
                company
            );
            if (requesterEmail && safetyBuffer.length <= MAX_WORKBOOK_BYTES) {
                await sendEmail({
                    to: requesterEmail,
                    subject: `${company.company_name} — safety backup before restore`,
                    html: backupReadyEmail({
                        company_name: company.company_name,
                        sections: SECTIONS.map((s) => s.label),
                        is_scheduled: false,
                        generated_at: new Date(),
                        isPreRestoreSafety: true,
                    }),
                    attachments: [{ filename: backupFilename(company, "pre-restore-safety"), content: safetyBuffer }],
                });
            }
        } catch (safetyError) {
            // The safety backup is best-effort context, not a hard gate — a
            // company whose current data is already too large to email must
            // still be able to restore. Logged, not fatal.
            console.error(`[Backup] Pre-restore safety backup failed for job ${job_id}:`, safetyError.message);
        }

        const sectionRows = {};
        for (const section of SECTIONS) {
            const sheet = workbook.Sheets[section.sheetName];
            sectionRows[section.key] = sheet ? XLSX.utils.sheet_to_json(sheet, { defval: null }) : [];
        }

        const client = await db.getClient();
        let summary;
        try {
            await client.query("BEGIN");
            summary = await restoreAllSections(client, job.company_id, sectionRows);
            await client.query("COMMIT");
        } catch (txError) {
            await client.query("ROLLBACK");
            throw txError;
        } finally {
            client.release();
        }

        await BackupJobModel.markCompleted(job_id, { summary });

        if (requesterEmail) {
            await sendEmail({
                to: requesterEmail,
                subject: `${company.company_name} — data restore complete`,
                html: backupReadyEmail({
                    company_name: company.company_name,
                    sections: Object.keys(summary),
                    is_scheduled: false,
                    generated_at: new Date(),
                    isRestoreComplete: true,
                    summary,
                }),
            });
        }
    } catch (error) {
        console.error(`[Backup] Restore job ${job_id} failed:`, error.message);
        await BackupJobModel.markFailed(job_id, error.message);
        try {
            const company = await CompanyModel.findById(job.company_id);
            const to = await getUserEmail(job.requested_by);
            if (to && company) {
                await sendEmail({
                    to,
                    subject: `${company.company_name} — data restore failed`,
                    html: backupFailedEmail({ company_name: company.company_name, error_message: error.message }),
                });
            }
        } catch {
            // See note above — never let the failure email mask the real error.
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// THROTTLE
// ─────────────────────────────────────────────────────────────────────────────

async function checkWeeklyThrottle(company_id) {
    const since = new Date(Date.now() - WEEKLY_THROTTLE_MS);
    const recent = await BackupJobModel.findRecentManualExport(company_id, since);
    if (!recent) return { allowed: true };

    const nextAvailableAt = new Date(new Date(recent.created_at).getTime() + WEEKLY_THROTTLE_MS);
    return { allowed: false, next_available_at: nextAvailableAt.toISOString(), last_job_id: recent.id };
}

module.exports = {
    SECTIONS,
    EXCLUDED_NOTES,
    getSectionCatalog,
    buildWorkbook,
    runExportJob,
    runRestoreJob,
    checkWeeklyThrottle,
};
