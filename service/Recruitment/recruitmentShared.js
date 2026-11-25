/**
 * Validation and shaping shared by the agency, client and public services.
 */
const crypto = require("crypto");
const { normalizeFormConfig } = require("../../utils/recruitmentForm");

const EMPLOYMENT_TYPES = ["full_time", "part_time", "contract", "temporary", "internship", "freelance"];
const WORK_MODES = ["onsite", "hybrid", "remote"];
const SALARY_PERIODS = ["hour", "day", "month", "year"];
const AGENCY_JOB_STATUSES = ["draft", "open", "paused", "closed", "filled"];
const STAGES = ["applied", "screening", "shortlisted", "interview", "offered", "hired", "rejected"];
const CLIENT_DECISIONS = ["pending", "approved", "rejected", "finalized"];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "Senior Accountant – Dubai" → "senior-accountant-dubai" */
function slugify(text, max = 70) {
    return String(text || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, max)
        .replace(/-+$/g, "");
}

const shortId = () => crypto.randomBytes(4).toString("hex").slice(0, 6);

const str = (v, max) => {
    if (v === undefined) return undefined;
    if (v === null) return null;
    const s = String(v).trim();
    return s ? s.slice(0, max) : null;
};

const num = (v) => {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
};

const bool = (v) => (v === undefined ? undefined : v === true || v === "true" || v === 1 || v === "1");

/** Array or comma-separated string → unique, trimmed, case-insensitively deduped. */
function list(v, { max = 20, maxLen = 40 } = {}) {
    if (v === undefined) return undefined;
    const raw = Array.isArray(v) ? v : String(v || "").split(",");
    const seen = new Set();
    const out = [];
    for (const item of raw) {
        const s = String(item || "").trim().replace(/^#/, "").slice(0, maxLen);
        if (!s || seen.has(s.toLowerCase())) continue;
        seen.add(s.toLowerCase());
        out.push(s);
        if (out.length >= max) break;
    }
    return out;
}

/**
 * Cleans a job payload. `partial` leaves absent keys out (for updates).
 * Returns { data } or { error }.
 */
function sanitizeJob(body = {}, { partial = false } = {}) {
    const d = {
        title: str(body.title, 200),
        sector: str(body.sector, 120),
        employment_type: body.employment_type,
        work_mode: body.work_mode,
        openings: num(body.openings),
        description: str(body.description, 20000),
        responsibilities: str(body.responsibilities, 20000),
        requirements: str(body.requirements, 20000),
        benefits: str(body.benefits, 10000),
        experience_min: num(body.experience_min),
        experience_max: num(body.experience_max),
        education: str(body.education, 200),
        skills: list(body.skills, { max: 30, maxLen: 50 }),
        tags: list(body.tags, { max: 20, maxLen: 40 }),
        location_city: str(body.location_city, 120),
        location_country: str(body.location_country, 120),
        salary_min: num(body.salary_min),
        salary_max: num(body.salary_max),
        salary_currency: str(body.salary_currency, 10)?.toUpperCase(),
        salary_period: body.salary_period,
        show_salary: bool(body.show_salary),
        show_company: bool(body.show_company),
        list_on_portal: bool(body.list_on_portal),
        form_config: body.form_config === undefined ? undefined : normalizeFormConfig(body.form_config),
        location_bound: bool(body.location_bound),
        bound_label: str(body.bound_label, 120),
        bound_latitude: num(body.bound_latitude),
        bound_longitude: num(body.bound_longitude),
        bound_radius_km: num(body.bound_radius_km),
        deadline: body.deadline === undefined ? undefined : body.deadline || null,
    };

    if (!partial || body.title !== undefined) {
        if (!d.title) return { error: "Job title is required" };
    }
    if (d.employment_type !== undefined && !EMPLOYMENT_TYPES.includes(d.employment_type)) return { error: "Unknown employment type" };
    if (d.work_mode !== undefined && !WORK_MODES.includes(d.work_mode)) return { error: "Work mode must be onsite, hybrid or remote" };
    if (d.salary_period !== undefined && !SALARY_PERIODS.includes(d.salary_period)) return { error: "Unknown salary period" };

    for (const key of ["openings", "experience_min", "experience_max", "salary_min", "salary_max", "bound_latitude", "bound_longitude", "bound_radius_km"]) {
        if (Number.isNaN(d[key])) return { error: `${key.replace(/_/g, " ")} must be a number` };
        if (d[key] != null && d[key] < 0 && !key.startsWith("bound_l")) return { error: `${key.replace(/_/g, " ")} cannot be negative` };
    }
    if (d.openings != null && (d.openings < 1 || !Number.isInteger(d.openings))) return { error: "Openings must be a whole number of at least 1" };
    if (d.experience_min != null && d.experience_max != null && d.experience_min > d.experience_max) return { error: "Minimum experience is more than the maximum" };
    if (d.salary_min != null && d.salary_max != null && d.salary_min > d.salary_max) return { error: "Minimum salary is more than the maximum" };
    if (d.deadline && Number.isNaN(Date.parse(d.deadline))) return { error: "Deadline is not a valid date" };

    if (d.location_bound) {
        if (d.bound_latitude == null || d.bound_longitude == null || !d.bound_radius_km) {
            return { error: "A location-bound job needs a centre point and a radius" };
        }
        if (Math.abs(d.bound_latitude) > 90 || Math.abs(d.bound_longitude) > 180) return { error: "Location coordinates are out of range" };
    }

    // Drop undefined so a partial update only touches what was sent.
    const data = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
    return { data };
}

/** Accepted CV formats, by MIME type and extension. */
const CV_TYPES = {
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};
const CV_MAX_BYTES = 5 * 1024 * 1024;

/** A file name that is safe inside a Cloudinary public_id, extension kept. */
function safeFileName(original, ext) {
    const base = String(original || "cv").replace(/\.[^.]+$/, "");
    return `${slugify(base, 60) || "cv"}.${ext}`;
}

module.exports = {
    EMPLOYMENT_TYPES, WORK_MODES, SALARY_PERIODS, AGENCY_JOB_STATUSES, STAGES, CLIENT_DECISIONS,
    EMAIL_RE, CV_TYPES, CV_MAX_BYTES,
    slugify, shortId, sanitizeJob, safeFileName, str,
};
