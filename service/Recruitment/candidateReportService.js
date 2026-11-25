/**
 * Candidate report for a client — for agencies whose clients don't use the
 * client portal.
 *
 *   pdf(...)   → one PDF: the job and the picked candidates' details
 *   email(...) → mails the client that PDF + a ZIP of the candidates' CVs,
 *                from the platform address, replying to the agency user
 *
 * Only what the client should see goes in: no private notes, no fit scores.
 */
const PDFDocument = require("pdfkit");
const db = require("../../config/database");
const AgencyModel = require("../../models/Recruitment/agencyModel");
const JobModel = require("../../models/Recruitment/jobModel");
const storage = require("../../utils/storage");
const { createZip } = require("../../utils/zip");
const { sendEmail } = require("../../utils/mailer");
const { FIELD_CATALOG, normalizeFormConfig } = require("../../utils/recruitmentForm");

const ok = (data, message = "OK", status = 200) => ({ success: true, status, message, data });
const fail = (message, status = 400) => ({ success: false, status, message });

const MAX_CANDIDATES = 20;
const MAX_ATTACH_BYTES = 30 * 1024 * 1024; // Resend allows 40 MB per email
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STAGE_LABEL = { applied: "New", screening: "Screening", shortlisted: "Shortlisted", interview: "Interview", offered: "Offered", hired: "Hired", rejected: "Rejected" };
const TYPE_LABEL = { full_time: "Full-time", part_time: "Part-time", contract: "Contract", temporary: "Temporary", internship: "Internship", freelance: "Freelance" };
const FIELD_LABEL = Object.fromEntries(FIELD_CATALOG.map((f) => [f.key, f.label]));
const SKIP_FIELDS = new Set(["full_name", "email", "cv", "phone", "linkedin_url", "current_location", "total_experience"]);

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const safeName = (s) => String(s || "file").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
const where = (j) => [j.location_city, j.location_country].filter(Boolean).join(", ");

async function load(company_id, job_id, ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : []).map(String))].slice(0, MAX_CANDIDATES + 1);
    if (!list.length) return fail("Pick at least one candidate");
    if (list.length > MAX_CANDIDATES) return fail(`A report can include up to ${MAX_CANDIDATES} candidates`);

    const job = await JobModel.findForAgency(job_id, company_id);
    if (!job) return fail("Job not found", 404);
    const [agency, client] = await Promise.all([
        AgencyModel.findByCompany(company_id),
        job.client_id ? AgencyModel.findClient(job.client_id, company_id) : null,
    ]);
    const { rows: apps } = await db.query(
        `SELECT a.id, a.stage, a.answers, a.cv_public_id, a.cv_file_name, a.created_at,
                cd.full_name, cd.email, cd.phone, cd.linkedin_url, cd.current_location,
                sk.total_experience_years AS profile_experience_years
           FROM recruitment_applications a
           JOIN recruitment_candidates cd ON cd.id = a.candidate_id
           LEFT JOIN job_seekers sk ON sk.id = a.seeker_id
          WHERE a.agency_company_id = $1 AND a.job_id = $2 AND a.id = ANY($3::uuid[])
          ORDER BY cd.full_name`,
        [company_id, job_id, list],
    );
    if (!apps.length) return fail("Those candidates aren't on this job", 404);
    return ok({ job, agency, client, apps });
}

/** The report PDF as a Buffer. */
function buildPdf({ job, agency, client, apps }) {
    const ORANGE = "#ea580c";
    const INK = "#111827";
    const MUTED = "#6b7280";
    const LINE = "#e5e7eb";
    const agencyName = agency?.display_name || "Recruitment partner";
    const questions = normalizeFormConfig(job.form_config || {}).questions || [];
    const qLabel = Object.fromEntries(questions.map((q) => [`q_${q.id}`, q.label]));

    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ size: "A4", margin: 48, bufferPages: true, info: { Title: `${job.title} — candidates`, Author: agencyName } });
        const chunks = [];
        doc.on("data", (c) => chunks.push(c));
        doc.on("end", () => resolve(Buffer.concat(chunks)));
        doc.on("error", reject);

        const left = 48;
        const width = doc.page.width - 96;
        const bottom = () => doc.page.height - 64;

        // Header band
        doc.rect(0, 0, doc.page.width, 92).fill("#fff7ed");
        doc.fillColor(ORANGE).font("Helvetica-Bold").fontSize(9).text("CANDIDATE REPORT", left, 30, { characterSpacing: 1.5 });
        doc.fillColor(INK).font("Helvetica-Bold").fontSize(18).text(agencyName, left, 44, { width: width - 140 });
        doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }), left, 36, { width, align: "right" });

        // Job
        let y = 116;
        doc.fillColor(MUTED).font("Helvetica").fontSize(9).text("POSITION", left, y, { characterSpacing: 1 });
        y += 14;
        doc.fillColor(INK).font("Helvetica-Bold").fontSize(16).text(job.title, left, y, { width });
        y = doc.y + 4;
        const jobMeta = [client?.name ? `Client: ${client.name}` : null, where(job), TYPE_LABEL[job.employment_type], job.openings > 1 ? `${job.openings} openings` : null].filter(Boolean).join("   ·   ");
        doc.fillColor(MUTED).font("Helvetica").fontSize(10).text(jobMeta, left, y, { width });
        y = doc.y + 18;
        doc.moveTo(left, y).lineTo(left + width, y).strokeColor(LINE).lineWidth(1).stroke();
        y += 16;
        doc.fillColor(INK).font("Helvetica-Bold").fontSize(12).text(`Selected candidates (${apps.length})`, left, y);
        y = doc.y + 10;

        apps.forEach((a, i) => {
            const ans = a.answers || {};
            const exp = ans.total_experience || a.profile_experience_years;
            const rows = [
                ["Email", a.email],
                ["Phone / WhatsApp", a.phone || ans.phone],
                ["Location", a.current_location || ans.current_location],
                ["Experience", exp ? `${Number(exp)} years` : null],
                ["LinkedIn", a.linkedin_url || ans.linkedin_url],
                ...Object.entries(ans)
                    .filter(([k, v]) => !SKIP_FIELDS.has(k) && !k.startsWith("q_") && v)
                    .map(([k, v]) => [FIELD_LABEL[k] || k, v]),
                ...Object.entries(ans)
                    .filter(([k, v]) => k.startsWith("q_") && v && qLabel[k])
                    .map(([k, v]) => [qLabel[k], v === "yes" ? "Yes" : v === "no" ? "No" : v]),
                ["CV", a.cv_public_id ? `Attached — ${a.cv_file_name || "CV"}` : "Not provided"],
            ].filter(([, v]) => v != null && String(v).trim() !== "");

            // Rough height so a candidate isn't split across pages.
            const need = 54 + rows.reduce((n, [, v]) => n + Math.max(16, Math.ceil(String(v).length / 70) * 13), 0);
            if (y + Math.min(need, 400) > bottom()) {
                doc.addPage();
                y = 56;
            }

            const top = y;
            doc.fillColor(ORANGE).font("Helvetica-Bold").fontSize(10).text(String(i + 1).padStart(2, "0"), left + 14, top + 14);
            doc.fillColor(INK).font("Helvetica-Bold").fontSize(13).text(a.full_name, left + 40, top + 12, { width: width - 160 });
            doc.fillColor(ORANGE).font("Helvetica-Bold").fontSize(9).text(STAGE_LABEL[a.stage] || a.stage, left, top + 15, { width: width - 14, align: "right" });
            let ry = Math.max(doc.y, top + 30) + 6;
            for (const [label, value] of rows) {
                doc.fillColor(MUTED).font("Helvetica").fontSize(9).text(label, left + 40, ry, { width: 120 });
                doc.fillColor(INK).font("Helvetica").fontSize(10).text(String(value), left + 165, ry - 1, { width: width - 180 });
                ry = Math.max(doc.y, ry + 12) + 4;
            }
            const h = ry - top + 8;
            doc.roundedRect(left, top, width, h, 8).lineWidth(1).strokeColor(LINE).stroke();
            y = top + h + 12;
        });

        // Footer on every page
        const range = doc.bufferedPageRange();
        for (let p = range.start; p < range.start + range.count; p++) {
            doc.switchToPage(p);
            doc.page.margins.bottom = 0; // the footer sits in the margin — don't let it spill onto a new page
            doc.fillColor(MUTED).font("Helvetica").fontSize(8).text(`Prepared by ${agencyName} · ${job.title}`, left, doc.page.height - 40, { width, align: "left", lineBreak: false });
            doc.text(`Page ${p + 1} of ${range.count}`, left, doc.page.height - 40, { width, align: "right", lineBreak: false });
        }
        doc.end();
    });
}

async function cvZip(apps) {
    const used = new Set();
    const files = [];
    for (const a of apps) {
        if (!a.cv_public_id) continue;
        try {
            const res = await fetch(await storage.downloadUrl(a.cv_public_id, { resourceType: "raw", name: a.cv_file_name || undefined }));
            if (!res.ok) continue;
            const data = Buffer.from(await res.arrayBuffer());
            const ext = (a.cv_file_name || "").split(".").pop().toLowerCase();
            let name = `${safeName(a.full_name)} - CV.${["pdf", "doc", "docx"].includes(ext) ? ext : "pdf"}`;
            for (let n = 2; used.has(name.toLowerCase()); n++) name = name.replace(/( \(\d+\))?(\.\w+)$/, ` (${n})$2`);
            used.add(name.toLowerCase());
            files.push({ name, data });
        } catch (error) {
            console.warn("[report] CV fetch failed:", error.message);
        }
    }
    return files.length ? { buffer: createZip(files), count: files.length } : null;
}

const CandidateReportService = {
    /** Suggested recipients: the client's contact + its portal users. */
    async recipients(company_id, job_id) {
        const job = await JobModel.findForAgency(job_id, company_id);
        if (!job) return fail("Job not found", 404);
        if (!job.client_id) return ok({ client: null, emails: [] });
        const client = await AgencyModel.findClient(job.client_id, company_id);
        const { rows } = await db.query(`SELECT full_name, email FROM recruitment_client_users WHERE client_id = $1 AND is_active ORDER BY full_name`, [job.client_id]);
        const emails = [
            ...(client?.contact_email ? [{ name: client.contact_name || client.name, email: client.contact_email }] : []),
            ...rows.map((r) => ({ name: r.full_name, email: r.email })),
        ].filter((e, i, all) => all.findIndex((x) => x.email.toLowerCase() === e.email.toLowerCase()) === i);
        return ok({ client: client ? { id: client.id, name: client.name } : null, emails });
    },

    async pdf(company_id, job_id, ids) {
        const res = await load(company_id, job_id, ids);
        if (!res.success) return res;
        const buffer = await buildPdf(res.data);
        return ok({ buffer, file_name: `${safeName(res.data.job.title)} - candidates.pdf` });
    },

    async email(company_id, user_id, job_id, body = {}) {
        const to = [...new Set((body.to || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))];
        const cc = [...new Set((body.cc || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean))].filter((e) => !to.includes(e));
        if (!to.length) return fail("Add the client's email address");
        const bad = [...to, ...cc].find((e) => !EMAIL_RE.test(e));
        if (bad) return fail(`"${bad}" isn't a valid email address`);
        if (to.length + cc.length > 10) return fail("Send to at most 10 addresses");

        const res = await load(company_id, job_id, body.application_ids);
        if (!res.success) return res;
        const { job, agency, client, apps } = res.data;

        const [pdf, zip, sender] = await Promise.all([
            buildPdf(res.data),
            body.include_cvs === false ? null : cvZip(apps),
            db.query(`SELECT email, first_name, last_name FROM users WHERE id = $1`, [user_id]).then((r) => r.rows[0]),
        ]);
        const title = safeName(job.title);
        const attachments = [{ filename: `${title} - candidates.pdf`, content: pdf }];
        if (zip) attachments.push({ filename: `${title} - CVs.zip`, content: zip.buffer });
        const size = attachments.reduce((n, a) => n + a.content.length, 0);
        if (size > MAX_ATTACH_BYTES) return fail("The CVs are too large to email together — send fewer candidates at once, or download the report instead", 413);

        const agencyName = agency?.display_name || "Your recruitment partner";
        const note = String(body.message || "").trim().slice(0, 2000);
        const senderName = sender ? `${sender.first_name || ""} ${sender.last_name || ""}`.trim() : "";
        const listHtml = apps
            .map((a) => `<li style="margin:0 0 6px"><b>${esc(a.full_name)}</b> — ${esc(a.email)}${a.phone ? ` · ${esc(a.phone)}` : ""}</li>`)
            .join("");

        await sendEmail({
            to,
            cc,
            replyTo: sender?.email || undefined,
            fromName: agencyName,
            subject: `${job.title} — ${apps.length === 1 ? "candidate" : `${apps.length} candidates`} from ${agencyName}`,
            html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827;line-height:1.55;max-width:600px">
                <p>Hello${client?.contact_name ? ` ${esc(client.contact_name)}` : ""},</p>
                ${note ? `<p style="white-space:pre-line">${esc(note)}</p>` : `<p>Please find our selected ${apps.length === 1 ? "candidate" : "candidates"} for <b>${esc(job.title)}</b>${client?.name ? ` at ${esc(client.name)}` : ""}.</p>`}
                <ul style="padding-left:18px;margin:14px 0">${listHtml}</ul>
                <p style="color:#6b7280;font-size:13px">Attached: the candidate report (PDF)${zip ? ` and ${zip.count === 1 ? "the CV" : `${zip.count} CVs`} (ZIP)` : ""}.</p>
                <p>Kind regards,<br/>${senderName ? `${esc(senderName)}<br/>` : ""}${esc(agencyName)}</p>
                <p style="color:#9ca3af;font-size:11px;margin-top:24px">Sent via teamBook. Reply to this email to reach ${esc(agencyName)}.</p>
              </div>`,
            attachments,
        });

        return ok({ sent_to: to, cc, candidates: apps.length, cvs: zip?.count ?? 0 }, `Report sent to ${to.join(", ")}`);
    },
};

module.exports = CandidateReportService;
