/**
 * "Upload a job description" → Gemini reads it → the Post-a-job form is filled.
 *
 * Two outputs from one read:
 *   fields         — what the form shows; the user can change anything.
 *   match_profile  — hidden. Saved with the job (recruitment_job_profiles) and
 *                    used later to score applicants. Never sent to a browser.
 *
 * The browser only gets the fields and a parse id. When the job is saved with
 * that id, the profile is attached to the job (attachToJob).
 */
const db = require("../../config/database");
const storage = require("../../utils/storage");
const { parseDocx } = require("../../utils/docxParser");
const { generateJson, geminiConfigured, geminiModel } = require("../../utils/gemini");
const { EMPLOYMENT_TYPES, WORK_MODES, SALARY_PERIODS } = require("./recruitmentShared");

const MAX_BYTES = 5 * 1024 * 1024;
const MIN_TEXT = 80;
const MAX_TEXT = 40_000;

const FILE_TYPES = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "text/plain": "txt",
};

// Same list the form offers; the model may still return another sector.
const SECTORS = [
    "Accounting & Finance", "Administration", "Banking", "Construction", "Customer Service", "Education",
    "Engineering", "Healthcare", "Hospitality", "Human Resources", "IT & Software", "Legal", "Logistics",
    "Manufacturing", "Marketing", "Oil & Gas", "Real Estate", "Retail", "Sales", "Security", "Transport",
];

const ok = (data, message = "OK", status = 200) => ({ success: true, status, message, data });
const fail = (message, status = 400) => ({ success: false, status, message });

// ── What we ask for ──────────────────────────────────────────────────────────

const S = (description, extra = {}) => ({ type: "STRING", description, nullable: true, ...extra });
const N = (description) => ({ type: "NUMBER", description, nullable: true });
const LIST = (description) => ({ type: "ARRAY", items: { type: "STRING" }, description });

const SCHEMA = {
    type: "OBJECT",
    properties: {
        is_job_description: { type: "BOOLEAN", description: "false if the document is not a job description at all" },
        job: {
            type: "OBJECT",
            properties: {
                title: S("Job title, concise, no company name"),
                sector: S(`Best fit from: ${SECTORS.join(", ")}. Another short sector name only if none fits.`),
                employment_type: S("Employment type", { enum: EMPLOYMENT_TYPES }),
                work_mode: S("Work mode", { enum: WORK_MODES }),
                location_city: S("City of the job"),
                location_country: S("Country of the job, full English name"),
                openings: N("Number of positions, if stated"),
                deadline: S("Application deadline as YYYY-MM-DD, only if stated"),
                description: S("About the role: 2–5 sentence plain-text overview"),
                responsibilities: S('Responsibilities, one per line, each starting with "- "'),
                requirements: S('Requirements/qualifications, one per line, each starting with "- "'),
                benefits: S('Benefits, one per line, each starting with "- ", only if stated'),
                experience_min: N('The LOWER bound of required experience in years. "minimum of 3 years" → 3; "3–5 years" → 3; "5+ years" → 5. Never 0 unless the document says no experience is needed.'),
                experience_max: N('The UPPER bound in years — ONLY when the document gives a range or a cap ("3–5 years" → 5, "up to 2 years" → 2). "minimum of 3 years" or "3+ years" → null.'),
                education: S("Degree / qualification required, short"),
                skills: LIST("Up to 15 concrete skills, each 1–4 words"),
                tags: LIST("4–8 lowercase hyphenated SEO tags (role, city, sector, seniority), e.g. accountant, dubai-jobs"),
                salary_min: N("Minimum salary, only if stated"),
                salary_max: N("Maximum salary, only if stated"),
                salary_currency: S("ISO 4217 currency code, e.g. AED"),
                salary_period: S("Salary period", { enum: SALARY_PERIODS }),
            },
        },
        match_profile: {
            type: "OBJECT",
            description: "Structured requirements used later to score applicants against this job",
            properties: {
                summary: S("One-paragraph summary of the ideal candidate"),
                seniority: S("Seniority", { enum: ["entry", "junior", "mid", "senior", "lead", "manager", "director", "executive"] }),
                role_family: S("Broad role family, e.g. finance, software engineering, sales"),
                must_have_skills: LIST("Skills a candidate must have"),
                nice_to_have_skills: LIST("Skills that are a plus"),
                min_years_experience: N('Lower bound of required experience in years ("minimum of 3 years" → 3)'),
                max_years_experience: N("Upper bound in years only if a range or cap is stated, else null"),
                education_level: S("Minimum education level", { enum: ["none", "high_school", "diploma", "bachelor", "master", "doctorate"] }),
                education_fields: LIST("Accepted fields of study"),
                certifications: LIST("Certifications or licences required or preferred"),
                languages: LIST("Languages required"),
                industries: LIST("Industries where prior experience is valued"),
                key_responsibilities: LIST("Core responsibilities, short phrases"),
                soft_skills: LIST("Soft skills"),
                location_requirement: S("Where the candidate must be / relocation / visa notes"),
                legal_requirements: LIST("Visa, driving licence, nationality or similar requirements"),
                keywords: LIST("Keywords to look for in a CV"),
                deal_breakers: LIST("Anything that disqualifies a candidate"),
                screening_questions: LIST("3–5 questions a recruiter could ask to verify fit"),
                scoring_weights: {
                    type: "OBJECT",
                    description: "Relative importance (0–100, summing to about 100) for scoring",
                    properties: {
                        skills: { type: "NUMBER" },
                        experience: { type: "NUMBER" },
                        education: { type: "NUMBER" },
                        certifications: { type: "NUMBER" },
                        location: { type: "NUMBER" },
                        languages: { type: "NUMBER" },
                    },
                },
            },
        },
    },
    required: ["is_job_description", "job", "match_profile"],
};

const SYSTEM = `You read job descriptions for a recruitment agency (mostly UAE / GCC roles) and fill a job-posting form.
Rules:
- Use only what the document says. Never invent a salary, deadline, benefits or a number of openings — use null when absent.
- Write in clear, professional English even if the document is in another language.
- Plain text only. Bullet lists: one item per line, each line starting with "- ". No markdown headings or bold.
- Remove the hiring company's name and contact details from the text fields (the agency may keep the client confidential).
- Years of experience are numbers: "3–5 years" → min 3, max 5; "5+ years", "at least 5 years" or "minimum of 5 years" → min 5, max null; "up to 3 years" → min null, max 3. Never turn a stated minimum into a maximum.
- employment_type, work_mode and salary_period must be one of the allowed values or null.
- The match_profile is for internal candidate scoring: be specific and complete.`;

// ── Cleaning the answer ──────────────────────────────────────────────────────

const text = (v, max) => {
    if (v === null || v === undefined) return null;
    const s = String(v).replace(/\r/g, "").trim();
    return s ? s.slice(0, max) : null;
};
const num = (v, { min = 0, max = 1e9 } = {}) => {
    const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[^\d.]/g, ""));
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 10) / 10 : null;
};
const list = (v, maxItems, maxLen) =>
    [...new Set((Array.isArray(v) ? v : []).map((x) => text(x, maxLen)).filter(Boolean))].slice(0, maxItems);
const oneOf = (v, allowed) => (allowed.includes(v) ? v : null);

function cleanFields(job = {}) {
    const deadline = /^\d{4}-\d{2}-\d{2}$/.test(String(job.deadline || "")) && new Date(job.deadline) > new Date() ? job.deadline : null;
    let exMin = num(job.experience_min, { max: 50 });
    let exMax = num(job.experience_max, { max: 50 });
    if (exMin !== null && exMax !== null && exMax < exMin) [exMin, exMax] = [exMax, exMin];
    let salMin = num(job.salary_min);
    let salMax = num(job.salary_max);
    if (salMin !== null && salMax !== null && salMax < salMin) [salMin, salMax] = [salMax, salMin];
    const openings = num(job.openings, { min: 1, max: 1000 });

    const fields = {
        title: text(job.title, 200),
        sector: text(job.sector, 120),
        employment_type: oneOf(job.employment_type, EMPLOYMENT_TYPES),
        work_mode: oneOf(job.work_mode, WORK_MODES),
        location_city: text(job.location_city, 120),
        location_country: text(job.location_country, 120),
        openings: openings ? Math.round(openings) : null,
        deadline,
        description: text(job.description, 20000),
        responsibilities: text(job.responsibilities, 20000),
        requirements: text(job.requirements, 20000),
        benefits: text(job.benefits, 10000),
        experience_min: exMin,
        experience_max: exMax,
        education: text(job.education, 200),
        skills: list(job.skills, 30, 50),
        tags: list(job.tags, 20, 40).map((t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")).filter(Boolean),
        salary_min: salMin,
        salary_max: salMax,
        salary_currency: text(job.salary_currency, 10)?.toUpperCase() || null,
        salary_period: oneOf(job.salary_period, SALARY_PERIODS),
    };
    // Drop empties so the form only overwrites what the document actually had.
    return Object.fromEntries(
        Object.entries(fields).filter(([, v]) => v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)),
    );
}

/**
 * The model tends to read "minimum of 3 years" as 0–3. When we have the text,
 * a stated floor ("minimum of N", "at least N", "N+ years") wins: min N, no max.
 */
function fixExperienceFloor(fields, profile, jdText) {
    if (!jdText) return;
    const m =
        /(?:minimum(?:\s+of)?|min\.?|at\s+least|not\s+less\s+than)\s+(\d+(?:\.\d+)?)\s*\+?\s*(?:years?|yrs?)/i.exec(jdText) ||
        /(\d+(?:\.\d+)?)\s*\+\s*(?:years?|yrs?)/i.exec(jdText);
    if (!m) return;
    const floor = Number(m[1]);
    const hasRange = new RegExp(`\\b${m[1]}\\s*(?:-|–|to)\\s*\\d+\\s*(?:years?|yrs?)`, "i").test(jdText);
    if (hasRange) return;
    if (!fields.experience_min || fields.experience_max === floor) {
        fields.experience_min = floor;
        delete fields.experience_max;
    }
    if (profile && (!profile.min_years_experience || profile.max_years_experience === floor)) {
        profile.min_years_experience = floor;
        profile.max_years_experience = null;
    }
}

// ── Service ──────────────────────────────────────────────────────────────────

const JdParseService = {
    /**
     * @param {object} input
     * @param {object} [input.file]  multer file (pdf / docx / txt)
     * @param {string} [input.text]  pasted job description
     */
    async parse(company_id, user_id, { file, text: pasted } = {}) {
        if (!geminiConfigured()) return fail("Filling a job from its description isn't available yet", 503);

        let parts;
        let jdText = null;
        let source = "text";
        let fileName = null;

        if (file) {
            source = "file";
            fileName = String(file.originalname || "job-description").slice(0, 255);
            const lower = fileName.toLowerCase();
            const kind = FILE_TYPES[file.mimetype] || (lower.endsWith(".docx") ? "docx" : lower.endsWith(".pdf") ? "pdf" : lower.endsWith(".txt") ? "txt" : null);
            if (!kind) {
                return fail(lower.endsWith(".doc") ? "Old .doc files aren't supported — save it as .docx or PDF" : "Upload a PDF, Word (.docx) or text file", 422);
            }
            if (file.size > MAX_BYTES) return fail("The file is larger than 5 MB", 422);

            if (kind === "pdf") {
                parts = [{ inline_data: { mime_type: "application/pdf", data: file.buffer.toString("base64") } }];
            } else {
                try {
                    jdText = kind === "docx" ? parseDocx(file.buffer).text : file.buffer.toString("utf8");
                } catch (error) {
                    return fail(error.message || "Could not read this document", 422);
                }
            }
        } else {
            jdText = String(pasted || "");
        }

        if (jdText !== null) {
            jdText = jdText.replace(/\u0000/g, "").trim().slice(0, MAX_TEXT);
            if (jdText.length < MIN_TEXT) return fail("That's too short to be a job description", 422);
            parts = [{ text: `Job description:\n\n${jdText}` }];
        }
        parts.push({ text: `Today's date is ${new Date().toISOString().slice(0, 10)}. Fill the job form and the match profile.` });

        let answer;
        try {
            answer = await generateJson({ system: SYSTEM, parts, schema: SCHEMA });
        } catch (error) {
            return fail(error.message, error.status || 502);
        }
        if (answer?.is_job_description === false) {
            return fail("This doesn't look like a job description — check the file and try again", 422);
        }

        const fields = cleanFields(answer?.job);
        if (!fields.title) return fail("Couldn't find a job title in this document — fill the form manually", 422);
        const matchProfile = answer?.match_profile && typeof answer.match_profile === "object" ? answer.match_profile : {};
        fixExperienceFloor(fields, matchProfile, jdText);

        // Keep the original file (best effort — the form fill doesn't depend on it).
        let fileRef = null;
        if (file) {
            try {
                const up = await storage.uploadFile(file.buffer, {
                    area: "sourcing",
                    companyId: company_id,
                    path: ["job-descriptions"],
                    name: `${storage.stamp()}-${storage.fileName(fileName, "pdf")}`,
                    contentType: file.mimetype || undefined,
                    cloudinary: { folder: `recruitment/job-descriptions/${company_id}`, resourceType: "raw", publicId: `${Date.now()}_${storage.fileName(fileName, "pdf")}` },
                });
                fileRef = up.publicId;
            } catch (error) {
                console.error("[jd-parse] could not store the file:", error.message);
            }
        }

        const { rows } = await db.query(
            `INSERT INTO recruitment_jd_parses
                (agency_company_id, created_by, source, file_ref, file_name, jd_text, fields, match_profile, model)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [company_id, user_id || null, source, fileRef, fileName, jdText, fields, matchProfile, geminiModel()],
        );

        return ok(
            { parse_id: rows[0].id, fields, filled: Object.keys(fields), file_name: fileName },
            `Filled ${Object.keys(fields).length} fields from the job description`,
        );
    },

    /** Attach a run's hidden profile to a saved job. Silently ignores a foreign / unknown id. */
    async attachToJob(company_id, parse_id, job_id) {
        if (!parse_id || !job_id) return;
        const { rows } = await db.query(
            `SELECT id, match_profile, file_ref, model FROM recruitment_jd_parses WHERE id = $1 AND agency_company_id = $2`,
            [parse_id, company_id],
        );
        const run = rows[0];
        if (!run) return;
        await db.query(
            `INSERT INTO recruitment_job_profiles (job_id, profile, jd_parse_id, jd_file_ref, model, updated_at)
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (job_id) DO UPDATE SET profile = EXCLUDED.profile, jd_parse_id = EXCLUDED.jd_parse_id,
                                                jd_file_ref = EXCLUDED.jd_file_ref, model = EXCLUDED.model, updated_at = NOW()`,
            [job_id, run.match_profile, run.id, run.file_ref, run.model],
        );
        await db.query(`UPDATE recruitment_jd_parses SET job_id = $2 WHERE id = $1`, [run.id, job_id]);
    },
};

module.exports = JdParseService;
