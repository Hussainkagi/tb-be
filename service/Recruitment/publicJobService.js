/**
 * The public job portal: no sign-in. Lists open jobs across every agency,
 * shows one job, and takes applications.
 *
 * Nothing private leaves this file: a hidden client's name, a hidden salary,
 * internal ids and the location-bound centre point are all stripped here.
 */
const db = require("../../config/database");
const JobModel = require("../../models/Recruitment/jobModel");
const ApplicationModel = require("../../models/Recruitment/applicationModel");
const { uploadToCloudinary } = require("../../utils/cloudinaryHelper");
const { distanceInMeters } = require("../../utils/geofence");
const { resolveForm, validateAnswers } = require("../../utils/recruitmentForm");
const { EMPLOYMENT_TYPES, WORK_MODES, CV_TYPES, safeFileName, str } = require("./recruitmentShared");

const ok = (data, message = "Success", status = 200) => ({ success: true, status, message, data });
const fail = (message, status = 400, errors) => ({ success: false, status, message, ...(errors ? { errors } : {}) });

const isAccepting = (job) =>
    job.status === "open" && (!job.deadline || new Date(job.deadline) >= new Date(new Date().toDateString()));

/** The public shape of a job — the only one the portal ever receives. */
function toPublic(row, { detail = false } = {}) {
    const job = {
        slug: row.slug,
        title: row.title,
        sector: row.sector,
        employment_type: row.employment_type,
        work_mode: row.work_mode,
        openings: row.openings,
        location_city: row.location_city,
        location_country: row.location_country,
        experience_min: row.experience_min == null ? null : Number(row.experience_min),
        experience_max: row.experience_max == null ? null : Number(row.experience_max),
        education: row.education,
        tags: row.tags || [],
        skills: row.skills || [],
        deadline: row.deadline,
        published_at: row.published_at,
        updated_at: row.updated_at,
        salary: row.show_salary && (row.salary_min != null || row.salary_max != null)
            ? {
                min: row.salary_min == null ? null : Number(row.salary_min),
                max: row.salary_max == null ? null : Number(row.salary_max),
                currency: row.salary_currency,
                period: row.salary_period,
            }
            : null,
        company: row.show_company && row.client_name
            ? { name: row.client_name, logo_url: row.client_logo_url, website: detail ? row.client_website : undefined }
            : null,
        agency: { name: row.agency_name, logo_url: row.agency_logo_url, slug: row.agency_slug },
    };
    if (!detail) {
        job.excerpt = row.excerpt;
        return job;
    }
    return {
        ...job,
        description: row.description,
        responsibilities: row.responsibilities,
        requirements: row.requirements,
        benefits: row.benefits,
        listed: row.list_on_portal,
        accepting_applications: isAccepting(row),
        agency: { ...job.agency, about: row.agency_about, website: row.agency_website },
        location_requirement: row.location_bound
            ? { label: row.bound_label || row.location_city || "the job location", radius_km: Number(row.bound_radius_km) }
            : null,
        form: resolveForm(row.form_config),
    };
}

const PublicJobService = {
    async list(query = {}) {
        const page = Math.max(1, Math.min(500, parseInt(query.page, 10) || 1));
        const limit = Math.max(1, Math.min(50, parseInt(query.limit, 10) || 20));
        const { rows, total } = await JobModel.listPublic({
            q: str(query.q, 100) || undefined,
            sector: str(query.sector, 120) || undefined,
            location: str(query.location, 120) || undefined,
            type: EMPLOYMENT_TYPES.includes(query.type) ? query.type : undefined,
            mode: WORK_MODES.includes(query.mode) ? query.mode : undefined,
            tag: str(query.tag, 40) || undefined,
            agency: str(query.agency, 80) || undefined,
            page,
            limit,
        });
        return ok({
            jobs: rows.map((r) => toPublic(r)),
            pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
        });
    },

    async facets() {
        const rows = await JobModel.publicFacets();
        return ok({
            sectors: rows.filter((r) => r.kind === "sector").map(({ value, count }) => ({ value, count })),
            locations: rows.filter((r) => r.kind === "location").map(({ value, count }) => ({ value, count })),
        });
    },

    async get(slug) {
        const row = await JobModel.findPublicBySlug(String(slug || "").slice(0, 160));
        if (!row) return fail("This job is no longer available", 404);
        return ok(toPublic(row, { detail: true }));
    },

    async sitemap() {
        return ok(await JobModel.sitemap());
    },

    /**
     * Takes one application.
     * @param {object} body  multipart text fields
     * @param {object} file  multer file (the CV), optional
     */
    async apply(slug, body = {}, file = null) {
        // Honeypot: a field real people never see. Bots fill it; pretend success.
        if (body.website_url) return ok({ id: null }, "Application received", 201);

        const job = await JobModel.findPublicBySlug(String(slug || "").slice(0, 160));
        if (!job) return fail("This job is no longer available", 404);
        if (!isAccepting(job)) return fail("This job is not accepting applications any more", 409);

        const { answers, errors } = validateAnswers(job.form_config, body, { hasFile: Boolean(file) });
        if (Object.keys(errors).length) return fail("Please check the highlighted fields", 422, errors);

        // Location-bound: the browser's position must be inside the circle.
        let applicant_latitude = null, applicant_longitude = null, distance_km = null;
        if (job.location_bound) {
            const lat = Number(body.latitude), lng = Number(body.longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
                return fail("This job needs your location. Please allow location access and try again.", 422, { location: "Location is required" });
            }
            distance_km = Math.round(distanceInMeters(lat, lng, Number(job.bound_latitude), Number(job.bound_longitude)) / 10) / 100;
            if (distance_km > Number(job.bound_radius_km)) {
                const where = job.bound_label || job.location_city || "the job location";
                return fail(`This job is only open to candidates in ${where}. You appear to be about ${Math.round(distance_km)} km away.`, 422, { location: "Outside the hiring area" });
            }
            applicant_latitude = lat;
            applicant_longitude = lng;
        }

        if (await ApplicationModel.alreadyApplied(job.id, answers.email)) {
            return fail("You have already applied for this job with this email", 409);
        }

        let cv = { url: null, public_id: null, name: null };
        if (file) {
            const ext = CV_TYPES[file.mimetype];
            if (!ext) return fail("CV must be a PDF or Word document", 422, { cv: "PDF, DOC or DOCX only" });
            const name = safeFileName(file.originalname, ext);
            // "raw" keeps the file byte-for-byte; the extension must be in the public_id.
            const upload = await uploadToCloudinary(file.buffer, {
                folder: `recruitment/cv/${job.agency_company_id}`,
                resourceType: "raw",
                publicId: `${Date.now()}_${name}`,
            });
            cv = { url: upload.secureUrl, public_id: upload.publicId, name: String(file.originalname || name).slice(0, 255) };
        }

        const client = await db.getClient();
        try {
            await client.query("BEGIN");
            const candidate = await ApplicationModel.upsertCandidate(client, {
                agency_company_id: job.agency_company_id,
                full_name: answers.full_name,
                email: answers.email.toLowerCase(),
                phone: answers.phone || null,
                linkedin_url: answers.linkedin_url || null,
                current_location: answers.current_location || null,
                cv_url: cv.url,
                cv_public_id: cv.public_id,
            });
            const created = await ApplicationModel.create(client, {
                agency_company_id: job.agency_company_id,
                job_id: job.id,
                candidate_id: candidate.id,
                answers,
                cv_url: cv.url,
                cv_public_id: cv.public_id,
                cv_file_name: cv.name,
                applicant_latitude,
                applicant_longitude,
                distance_km,
                source: body.source === "link" ? "link" : "portal",
            });
            await client.query("COMMIT");
            return ok({ id: created.id }, "Application received", 201);
        } catch (error) {
            await client.query("ROLLBACK");
            if (error.code === "23505") return fail("You have already applied for this job with this email", 409);
            throw error;
        } finally {
            client.release();
        }
    },
};

module.exports = PublicJobService;
