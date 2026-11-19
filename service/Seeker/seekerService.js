/**
 * Everything a signed-in job seeker does on the job board:
 *   profile · CVs · saved jobs · drafts · applications · applying.
 *
 * The profile fills itself: every CV upload is read, and any profile field
 * that is still empty is filled from it. Anything the person typed is never
 * overwritten.
 */
const db = require("../../config/database");
const storage = require("../../utils/storage");
const CvParseService = require("./cvParseService");
const PublicJobService = require("../Recruitment/publicJobService");
const JobModel = require("../../models/Recruitment/jobModel");
const SeekerAuthService = require("./seekerAuthService");

const ok = (data, message = "OK", status = 200) => ({ success: true, status, message, data });
const fail = (message, status = 400, errors) => ({ success: false, status, message, ...(errors ? { errors } : {}) });
const str = (v, max) => {
    const s = String(v ?? "").trim();
    return s ? s.slice(0, max) : null;
};

const CV_TYPES = {
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};
const CV_MAX_BYTES = 5 * 1024 * 1024;
const MAX_CVS = 5;

const PROFILE_TEXT = {
    first_name: 100, last_name: 100, phone: 40, headline: 160, current_company: 160, country: 100,
    city: 100, nationality: 100, linkedin_url: 300, portfolio_url: 300, summary: 4000,
};
const PROFILE_LISTS = ["skills", "languages", "certifications"];
const PROFILE_OBJECT_LISTS = ["experience", "education"];

// ── Helpers ──

/** A DATE column as YYYY-MM-DD. pg gives local-midnight Dates; toISOString would shift a day east of UTC. */
const ymd = (d) => {
    if (!d) return null;
    if (typeof d === "string") return d.slice(0, 10);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

async function getSeeker(id) {
    const { rows } = await db.query(`SELECT * FROM job_seekers WHERE id = $1`, [id]);
    return rows[0] || null;
}

function profileOut(row) {
    return {
        ...SeekerAuthService.publicSeeker(row),
        phone: row.phone,
        headline: row.headline,
        current_company: row.current_company,
        total_experience_years: row.total_experience_years == null ? null : Number(row.total_experience_years),
        country: row.country,
        city: row.city,
        nationality: row.nationality,
        gender: row.gender,
        date_of_birth: ymd(row.date_of_birth),
        age_years: row.age_years ?? null,
        linkedin_url: row.linkedin_url,
        portfolio_url: row.portfolio_url,
        summary: row.summary,
        skills: row.skills || [],
        languages: row.languages || [],
        certifications: row.certifications || [],
        experience: row.experience || [],
        education: row.education || [],
    };
}

const cleanList = (v, max = 40, len = 80) =>
    [...new Set((Array.isArray(v) ? v : []).map((x) => str(x, len)).filter(Boolean))].slice(0, max);
const cleanObjects = (v, keys, max = 20) =>
    (Array.isArray(v) ? v : []).slice(0, max).map((o) => {
        const out = {};
        for (const k of keys) out[k] = k === "current" ? Boolean(o?.[k]) : str(o?.[k], k === "summary" ? 600 : 160);
        return out;
    }).filter((o) => Object.values(o).some((x) => x && x !== false));
const EXP_KEYS = ["title", "company", "location", "start", "end", "current", "summary"];
const EDU_KEYS = ["degree", "field", "institution", "start", "end"];

/** Profile columns from a parsed CV — only values that are actually there. */
function fromCv(p) {
    if (!p) return {};
    const out = {};
    for (const k of Object.keys(PROFILE_TEXT)) if (k !== "first_name" && k !== "last_name" && str(p[k], PROFILE_TEXT[k])) out[k] = str(p[k], PROFILE_TEXT[k]);
    if (["male", "female"].includes(p.gender)) out.gender = p.gender;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(p.date_of_birth || ""))) out.date_of_birth = p.date_of_birth;
    const age = Number(p.age_years);
    if (Number.isFinite(age) && age >= 14 && age <= 90) out.age_years = Math.round(age);
    const yrs = Number(p.total_experience_years);
    if (Number.isFinite(yrs) && yrs >= 0 && yrs <= 60) out.total_experience_years = Math.round(yrs * 10) / 10;
    for (const k of PROFILE_LISTS) {
        const l = cleanList(p[k]);
        if (l.length) out[k] = l;
    }
    const exp = cleanObjects(p.experience, EXP_KEYS);
    if (exp.length) out.experience = exp;
    const edu = cleanObjects(p.education, EDU_KEYS);
    if (edu.length) out.education = edu;
    return out;
}

const isEmpty = (v) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

/** SET fragment for the given columns (jsonb for lists). */
function setClause(values, start = 2) {
    const cols = Object.keys(values);
    const sets = cols.map((c, i) => {
        const json = PROFILE_LISTS.includes(c) || PROFILE_OBJECT_LISTS.includes(c);
        return `${c} = $${i + start}${json ? "::jsonb" : ""}`;
    });
    const params = cols.map((c) => (PROFILE_LISTS.includes(c) || PROFILE_OBJECT_LISTS.includes(c) ? JSON.stringify(values[c]) : values[c]));
    return { sets, params };
}

// A job row as the job board shows it (company hidden when the agency hides it).
const JOB_CARD = `
    j.id AS job_id, j.slug, j.title, j.status, j.employment_type, j.work_mode, j.location_city, j.location_country,
    j.published_at, j.deadline,
    CASE WHEN j.show_salary THEN j.salary_min END AS salary_min,
    CASE WHEN j.show_salary THEN j.salary_max END AS salary_max,
    CASE WHEN j.show_salary THEN j.salary_currency END AS salary_currency,
    CASE WHEN j.show_salary THEN j.salary_period END AS salary_period,
    CASE WHEN j.show_company THEN c.name END AS company_name,
    CASE WHEN j.show_company THEN c.logo_url END AS company_logo_url,
    ag.display_name AS agency_name, ag.logo_url AS agency_logo_url`;
const JOB_JOINS = `
    JOIN recruitment_jobs j ON j.id = x.job_id
    LEFT JOIN recruitment_clients c ON c.id = j.client_id
    LEFT JOIN recruitment_agencies ag ON ag.company_id = j.agency_company_id`;

const STAGE_LABEL = {
    applied: "Applied", screening: "In review", shortlisted: "Shortlisted", interview: "Interview",
    offered: "Offer", hired: "Hired", rejected: "Not selected",
};

function prefillFor(seeker) {
    const edu = (seeker.education || [])[0];
    return {
        full_name: `${seeker.first_name || ""} ${seeker.last_name || ""}`.trim(),
        email: seeker.email,
        phone: seeker.phone || "",
        linkedin_url: seeker.linkedin_url || "",
        portfolio_url: seeker.portfolio_url || "",
        current_location: [seeker.city, seeker.country].filter(Boolean).join(", "),
        nationality: seeker.nationality || "",
        total_experience: seeker.total_experience_years == null ? "" : String(Number(seeker.total_experience_years)),
        highest_education: edu ? [edu.degree, edu.field].filter(Boolean).join(" in ") : "",
    };
}

// ── Service ──────────────────────────────────────────────────────────────────

const SeekerService = {
    async me(seeker_id) {
        const s = await getSeeker(seeker_id);
        if (!s) return fail("Account not found", 404);
        return ok(profileOut(s));
    },

    async updateProfile(seeker_id, body = {}) {
        const values = {};
        for (const [k, max] of Object.entries(PROFILE_TEXT)) if (body[k] !== undefined) values[k] = str(body[k], max);
        if (body.first_name !== undefined && !values.first_name) return fail("First name can't be empty");
        if (body.gender !== undefined) values.gender = ["male", "female", "other"].includes(body.gender) ? body.gender : null;
        if (body.date_of_birth !== undefined) values.date_of_birth = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date_of_birth || "")) ? body.date_of_birth : null;
        if (body.total_experience_years !== undefined) {
            const n = Number(body.total_experience_years);
            values.total_experience_years = body.total_experience_years === "" || body.total_experience_years === null ? null : Number.isFinite(n) && n >= 0 && n <= 60 ? n : undefined;
            if (values.total_experience_years === undefined) return fail("Experience must be a number of years");
        }
        for (const k of PROFILE_LISTS) if (body[k] !== undefined) values[k] = cleanList(body[k]);
        if (body.experience !== undefined) values.experience = cleanObjects(body.experience, EXP_KEYS);
        if (body.education !== undefined) values.education = cleanObjects(body.education, EDU_KEYS);
        if (!Object.keys(values).length) return this.me(seeker_id);

        const { sets, params } = setClause(values);
        await db.query(`UPDATE job_seekers SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1`, [seeker_id, ...params]);
        const res = await this.me(seeker_id);
        res.message = "Profile saved";
        return res;
    },

    // ── CVs ────────────────────────────────────────────────────────────────
    async listCvs(seeker_id) {
        const { rows } = await db.query(
            `SELECT id, file_name, mime, size_bytes, is_default, created_at, file_ref AS url
               FROM job_seeker_cvs WHERE seeker_id = $1 ORDER BY is_default DESC, created_at DESC`,
            [seeker_id],
        );
        return ok(rows);
    },

    /** Upload a CV, read it, and fill any empty profile fields from it. */
    async uploadCv(seeker_id, file) {
        if (!file) return fail("Choose a CV to upload");
        const ext = CV_TYPES[file.mimetype];
        if (!ext) return fail("Upload your CV as a PDF or Word file", 422);
        if (file.size > CV_MAX_BYTES) return fail("The CV is larger than 5 MB", 422);

        const seeker = await getSeeker(seeker_id);
        if (!seeker) return fail("Account not found", 404);
        const { rows: count } = await db.query(`SELECT COUNT(*)::int n FROM job_seeker_cvs WHERE seeker_id = $1`, [seeker_id]);
        if (count[0].n >= MAX_CVS) return fail(`You can keep up to ${MAX_CVS} CVs — delete one first`, 422);

        const who = `${storage.slug(`${seeker.first_name} ${seeker.last_name}`, 40) || "candidate"}-${storage.shortId(seeker.id)}`;
        const upload = await storage.uploadFile(file.buffer, {
            area: "candidates",
            path: [who, "cvs"],
            name: `${storage.stamp()}-${storage.fileName(file.originalname, ext)}`,
            contentType: file.mimetype,
            cloudinary: { folder: `recruitment/candidates/${seeker.id}`, resourceType: "raw", publicId: `${Date.now()}_${storage.fileName(file.originalname, ext)}` },
        });

        const parsed = await CvParseService.read(file.buffer, file.mimetype, file.originalname);
        const first = count[0].n === 0;

        const { rows } = await db.query(
            `INSERT INTO job_seeker_cvs (seeker_id, file_ref, file_name, mime, size_bytes, is_default, parsed)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, file_name, mime, size_bytes, is_default, created_at, file_ref AS url`,
            [seeker_id, upload.publicId, String(file.originalname || `cv.${ext}`).slice(0, 255), file.mimetype, file.size, first, parsed],
        );

        // Fill whatever is still empty — never overwrite what they typed.
        const found = fromCv(parsed);
        const fill = {};
        for (const [k, v] of Object.entries(found)) if (isEmpty(seeker[k])) fill[k] = v;
        let filled = [];
        if (Object.keys(fill).length) {
            const { sets, params } = setClause(fill);
            await db.query(
                `UPDATE job_seekers SET ${sets.join(", ")}, profile_filled_at = COALESCE(profile_filled_at, NOW()), updated_at = NOW() WHERE id = $1`,
                [seeker_id, ...params],
            );
            filled = Object.keys(fill);
        } else if (parsed && !seeker.profile_filled_at) {
            await db.query(`UPDATE job_seekers SET profile_filled_at = NOW() WHERE id = $1`, [seeker_id]);
        }

        const profile = (await this.me(seeker_id)).data;
        return ok(
            { cv: rows[0], profile, filled, read: Boolean(parsed) },
            filled.length ? `CV saved — ${filled.length} profile details filled from it` : "CV saved",
            201,
        );
    },

    async setDefaultCv(seeker_id, cv_id) {
        const client = await db.getClient();
        try {
            await client.query("BEGIN");
            const { rows } = await client.query(`SELECT 1 FROM job_seeker_cvs WHERE id = $1 AND seeker_id = $2`, [cv_id, seeker_id]);
            if (!rows.length) {
                await client.query("ROLLBACK");
                return fail("CV not found", 404);
            }
            await client.query(`UPDATE job_seeker_cvs SET is_default = FALSE WHERE seeker_id = $1 AND is_default`, [seeker_id]);
            await client.query(`UPDATE job_seeker_cvs SET is_default = TRUE WHERE id = $1`, [cv_id]);
            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK").catch(() => {});
            throw error;
        } finally {
            client.release();
        }
        const res = await this.listCvs(seeker_id);
        res.message = "Default CV updated";
        return res;
    },

    async deleteCv(seeker_id, cv_id) {
        const { rows } = await db.query(`DELETE FROM job_seeker_cvs WHERE id = $1 AND seeker_id = $2 RETURNING is_default, file_ref`, [cv_id, seeker_id]);
        if (!rows.length) return fail("CV not found", 404);
        // Applications already sent keep pointing at the file, so the stored file stays.
        if (rows[0].is_default) {
            await db.query(
                `UPDATE job_seeker_cvs SET is_default = TRUE
                  WHERE id = (SELECT id FROM job_seeker_cvs WHERE seeker_id = $1 ORDER BY created_at DESC LIMIT 1)`,
                [seeker_id],
            );
        }
        const res = await this.listCvs(seeker_id);
        res.message = "CV removed";
        return res;
    },

    // ── Saved jobs ─────────────────────────────────────────────────────────
    async savedIds(seeker_id) {
        const { rows } = await db.query(
            `SELECT j.slug FROM job_seeker_saved_jobs s JOIN recruitment_jobs j ON j.id = s.job_id WHERE s.seeker_id = $1`,
            [seeker_id],
        );
        return ok(rows.map((r) => r.slug));
    },

    async listSaved(seeker_id) {
        const { rows } = await db.query(
            `SELECT ${JOB_CARD}, x.created_at AS saved_at FROM job_seeker_saved_jobs x ${JOB_JOINS}
              WHERE x.seeker_id = $1 ORDER BY x.created_at DESC`,
            [seeker_id],
        );
        return ok(rows);
    },

    async save(seeker_id, slug) {
        const job = await JobModel.findPublicBySlug(String(slug || "").slice(0, 160));
        if (!job) return fail("This job is no longer available", 404);
        await db.query(`INSERT INTO job_seeker_saved_jobs (seeker_id, job_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [seeker_id, job.id]);
        return ok({ slug: job.slug, saved: true }, "Job saved");
    },

    async unsave(seeker_id, slug) {
        await db.query(
            `DELETE FROM job_seeker_saved_jobs WHERE seeker_id = $1 AND job_id = (SELECT id FROM recruitment_jobs WHERE slug = $2)`,
            [seeker_id, String(slug || "").slice(0, 160)],
        );
        return ok({ slug, saved: false }, "Removed from saved jobs");
    },

    // ── Applications ───────────────────────────────────────────────────────
    async listApplications(seeker_id) {
        const { rows } = await db.query(
            `SELECT ${JOB_CARD}, x.id AS application_id, x.stage, x.created_at AS applied_at, x.cv_file_name
               FROM recruitment_applications x ${JOB_JOINS}
              WHERE x.seeker_id = $1 ORDER BY x.created_at DESC`,
            [seeker_id],
        );
        return ok(rows.map((r) => ({ ...r, status_label: STAGE_LABEL[r.stage] || "Applied" })));
    },

    // ── Drafts ─────────────────────────────────────────────────────────────
    async listDrafts(seeker_id) {
        const { rows } = await db.query(
            `SELECT ${JOB_CARD}, x.updated_at FROM job_seeker_drafts x ${JOB_JOINS}
              WHERE x.seeker_id = $1
                AND NOT EXISTS (SELECT 1 FROM recruitment_applications a WHERE a.seeker_id = x.seeker_id AND a.job_id = x.job_id)
              ORDER BY x.updated_at DESC`,
            [seeker_id],
        );
        return ok(rows);
    },

    async saveDraft(seeker_id, slug, body = {}) {
        const job = await JobModel.findPublicBySlug(String(slug || "").slice(0, 160));
        if (!job) return fail("This job is no longer available", 404);
        const answers = {};
        for (const [k, v] of Object.entries(body.answers || {})) {
            if (/^[a-z0-9_]{1,40}$/i.test(k) && v != null) answers[k] = String(v).slice(0, 5000);
        }
        let cv_id = null;
        if (body.cv_id) {
            const { rows } = await db.query(`SELECT id FROM job_seeker_cvs WHERE id = $1 AND seeker_id = $2`, [body.cv_id, seeker_id]);
            cv_id = rows[0]?.id || null;
        }
        await db.query(
            `INSERT INTO job_seeker_drafts (seeker_id, job_id, answers, cv_id, updated_at) VALUES ($1, $2, $3, $4, NOW())
             ON CONFLICT (seeker_id, job_id) DO UPDATE SET answers = EXCLUDED.answers, cv_id = EXCLUDED.cv_id, updated_at = NOW()`,
            [seeker_id, job.id, answers, cv_id],
        );
        return ok({ saved: true }, "Draft saved");
    },

    async deleteDraft(seeker_id, slug) {
        await db.query(
            `DELETE FROM job_seeker_drafts WHERE seeker_id = $1 AND job_id = (SELECT id FROM recruitment_jobs WHERE slug = $2)`,
            [seeker_id, String(slug || "").slice(0, 160)],
        );
        return ok({ deleted: true }, "Draft discarded");
    },

    // ── Applying ───────────────────────────────────────────────────────────
    /** Everything the apply page needs: the job, prefilled answers, CVs, any draft. */
    async applyContext(seeker_id, slug) {
        const jobRes = await PublicJobService.get(slug);
        if (!jobRes.success) return jobRes;
        const seeker = await getSeeker(seeker_id);
        if (!seeker) return fail("Account not found", 404);
        const job = await JobModel.findPublicBySlug(String(slug).slice(0, 160));

        const [cvs, draft, applied] = await Promise.all([
            this.listCvs(seeker_id),
            db.query(`SELECT answers, cv_id, updated_at FROM job_seeker_drafts WHERE seeker_id = $1 AND job_id = $2`, [seeker_id, job.id]),
            db.query(`SELECT created_at FROM recruitment_applications WHERE job_id = $1 AND (seeker_id = $2 OR LOWER((answers->>'email')) = LOWER($3)) LIMIT 1`, [job.id, seeker_id, seeker.email]),
        ]);
        return ok({
            job: jobRes.data,
            prefill: prefillFor(seeker),
            cvs: cvs.data,
            draft: draft.rows[0] || null,
            applied_at: applied.rows[0]?.created_at || null,
        });
    },

    async apply(seeker_id, slug, body = {}) {
        const seeker = await getSeeker(seeker_id);
        if (!seeker) return fail("Account not found", 404);

        let cv = null;
        if (body.cv_id) {
            const { rows } = await db.query(`SELECT file_ref, file_name FROM job_seeker_cvs WHERE id = $1 AND seeker_id = $2`, [body.cv_id, seeker_id]);
            if (!rows.length) return fail("Choose one of your CVs", 422, { cv: "Choose a CV" });
            cv = { url: rows[0].file_ref, public_id: rows[0].file_ref, name: rows[0].file_name };
        }

        // The account's email is the application's email — it's who we'll reply to.
        const fields = { ...body, email: seeker.email };
        delete fields.cv_id;
        const result = await PublicJobService.apply(slug, fields, null, { seekerId: seeker_id, cv });
        if (result.success) {
            const job = await JobModel.findPublicBySlug(String(slug).slice(0, 160));
            if (job) await db.query(`DELETE FROM job_seeker_drafts WHERE seeker_id = $1 AND job_id = $2`, [seeker_id, job.id]);
            // Keep the phone they applied with if the profile had none.
            if (!seeker.phone && fields.phone) await db.query(`UPDATE job_seekers SET phone = $2 WHERE id = $1 AND phone IS NULL`, [seeker_id, str(fields.phone, 40)]);
        }
        return result;
    },
};

module.exports = SeekerService;
