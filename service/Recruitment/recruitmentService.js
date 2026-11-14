/**
 * Agency side of recruitment: the agency profile, its clients and their
 * logins, jobs, and the candidate pipeline.
 *
 * Every function is scoped by `company_id` (the agency's tenant id from the
 * route, already checked against the token by validateTenant).
 */
const crypto = require("crypto");
const AgencyModel = require("../../models/Recruitment/agencyModel");
const JobModel = require("../../models/Recruitment/jobModel");
const ApplicationModel = require("../../models/Recruitment/applicationModel");
const CompanyModel = require("../../models/companyModel");
const { hashPassword } = require("../../utils/password");
const { uploadToCloudinary } = require("../../utils/cloudinaryHelper");
const { sendEmail } = require("../../utils/mailer");
const { FIELD_CATALOG, QUESTION_TYPES, normalizeFormConfig } = require("../../utils/recruitmentForm");
const {
    AGENCY_JOB_STATUSES, STAGES, EMAIL_RE,
    slugify, shortId, sanitizeJob, str,
} = require("./recruitmentShared");

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ok = (data, message = "Success", status = 200) => ({ success: true, status, message, data });
const fail = (message, status = 400) => ({ success: false, status, message });

const PORTAL_URL = () => (process.env.PUBLIC_SITE_URL || process.env.FRONTEND_URL || "https://teambook.ikration.com").replace(/\/$/, "");

/** A readable random password: 12 chars, always passes the usual rules. */
function generatePassword() {
    const body = crypto.randomBytes(9).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 9);
    return `${body}#${Math.floor(10 + Math.random() * 89)}`;
}

/** Public links for a job — the portal page and the direct apply form. */
function jobLinks(slug) {
    const base = `${PORTAL_URL()}/jobs/${slug}`;
    return { public_url: base, apply_url: `${base}/apply` };
}

const RecruitmentService = {
    // ── Agency profile (onboarding) ─────────────────────────────────────────
    async getAgency(company_id) {
        const agency = await AgencyModel.findByCompany(company_id);
        if (agency) return ok({ agency, is_setup: true });
        // Not set up yet: hand back sensible defaults for the onboarding form.
        const company = await CompanyModel.findById(company_id);
        return ok({
            agency: null,
            is_setup: false,
            defaults: {
                display_name: company?.company_name || "",
                slug: slugify(company?.company_name || "", 60),
                contact_email: company?.email || "",
                contact_phone: company?.phone || "",
            },
        });
    },

    async saveAgency(company_id, body) {
        const display_name = str(body.display_name, 160);
        if (!display_name) return fail("Agency name is required");
        const slug = slugify(body.slug || display_name, 60);
        if (slug.length < 3) return fail("Public handle must be at least 3 letters or numbers");
        if (await AgencyModel.slugTaken(slug, company_id)) return fail("That public handle is taken — try another");

        const contact_email = str(body.contact_email, 255);
        if (contact_email && !EMAIL_RE.test(contact_email)) return fail("Contact email is not valid");

        const agency = await AgencyModel.upsert(company_id, {
            display_name,
            slug,
            website: str(body.website, 255),
            contact_email,
            contact_phone: str(body.contact_phone, 50),
            about: str(body.about, 4000),
        });
        return ok(agency, "Agency profile saved");
    },

    async uploadLogo(company_id, file) {
        if (!file) return fail("Choose an image");
        if (!/^image\/(png|jpe?g|webp|svg\+xml)$/.test(file.mimetype)) return fail("Logo must be a PNG, JPG, WEBP or SVG");
        const agency = await AgencyModel.findByCompany(company_id);
        if (!agency) return fail("Set up the agency profile first");

        const upload = await uploadToCloudinary(file.buffer, {
            folder: `recruitment/agency/${company_id}`,
            resourceType: "image",
            transformation: { width: 400, height: 400, crop: "limit", quality: "auto", fetch_format: "auto" },
        });
        const saved = await AgencyModel.upsert(company_id, { logo_url: upload.secureUrl, logo_public_id: upload.publicId });
        return ok(saved, "Logo updated");
    },

    async removeLogo(company_id) {
        const saved = await AgencyModel.upsert(company_id, { logo_url: null, logo_public_id: null });
        return ok(saved, "Logo removed");
    },

    async overview(company_id) {
        const [stats, recent] = await Promise.all([
            JobModel.overview(company_id),
            ApplicationModel.recentForAgency(company_id),
        ]);
        return ok({ stats, recent });
    },

    // ── Clients ─────────────────────────────────────────────────────────────
    async listClients(company_id) {
        return ok(await AgencyModel.listClients(company_id));
    },

    async getClient(company_id, id) {
        const client = await AgencyModel.findClient(id, company_id);
        if (!client) return fail("Client not found", 404);
        const [users, jobs] = await Promise.all([
            AgencyModel.listClientUsers(id, company_id),
            JobModel.listForAgency(company_id, { client_id: id }),
        ]);
        return ok({ client, users, jobs });
    },

    cleanClient(body, { partial }) {
        const data = {
            name: str(body.name, 200),
            industry: str(body.industry, 120),
            website: str(body.website, 255),
            logo_url: str(body.logo_url, 1000),
            location: str(body.location, 200),
            contact_name: str(body.contact_name, 160),
            contact_email: str(body.contact_email, 255),
            contact_phone: str(body.contact_phone, 50),
            about: str(body.about, 4000),
            is_active: body.is_active === undefined ? undefined : Boolean(body.is_active),
        };
        if ((!partial || body.name !== undefined) && !data.name) return { error: "Client company name is required" };
        if (data.contact_email && !EMAIL_RE.test(data.contact_email)) return { error: "Contact email is not valid" };
        return { data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) };
    },

    async createClient(company_id, body) {
        const { data, error } = this.cleanClient(body, { partial: false });
        if (error) return fail(error);
        try {
            return ok(await AgencyModel.createClient(company_id, data), "Client added", 201);
        } catch (e) {
            if (e.code === "23505") return fail("You already have a client with this name");
            throw e;
        }
    },

    async updateClient(company_id, id, body) {
        const { data, error } = this.cleanClient(body, { partial: true });
        if (error) return fail(error);
        try {
            const client = await AgencyModel.updateClient(id, company_id, data);
            return client ? ok(client, "Client updated") : fail("Client not found", 404);
        } catch (e) {
            if (e.code === "23505") return fail("You already have a client with this name");
            throw e;
        }
    },

    // ── Client logins ───────────────────────────────────────────────────────
    /**
     * Creates a login for someone at the client. The password is returned
     * once, in this response, so the agency can pass it on; it is also
     * e-mailed when `send_email` is set.
     */
    async createClientUser(company_id, client_id, body) {
        const client = await AgencyModel.findClient(client_id, company_id);
        if (!client) return fail("Client not found", 404);

        const full_name = str(body.full_name, 160);
        const email = str(body.email, 255)?.toLowerCase();
        if (!full_name) return fail("Name is required");
        if (!email || !EMAIL_RE.test(email)) return fail("A valid email is required — it is their login");
        if (await AgencyModel.emailTaken(email)) return fail("This email already has a client login");

        const password = body.password ? String(body.password) : generatePassword();
        if (password.length < 8) return fail("Password must be at least 8 characters");

        const user = await AgencyModel.createClientUser({
            client_id, agency_company_id: company_id, full_name, email,
            password_hash: await hashPassword(password),
        });

        let emailed = false;
        if (body.send_email !== false) emailed = await this.sendCredentials(company_id, client, user, password);

        return ok({ user, password, emailed, login_url: `${PORTAL_URL()}/client/login` }, "Client login created", 201);
    },

    async updateClientUser(company_id, user_id, body) {
        const data = {};
        if (body.full_name !== undefined) data.full_name = str(body.full_name, 160);
        if (body.is_active !== undefined) data.is_active = Boolean(body.is_active);

        let password;
        if (body.reset_password) {
            password = body.password ? String(body.password) : generatePassword();
            if (password.length < 8) return fail("Password must be at least 8 characters");
            data.password_hash = await hashPassword(password);
            data.failed_login_attempts = 0;
        }
        const user = await AgencyModel.updateClientUser(user_id, company_id, data);
        if (!user) return fail("Login not found", 404);
        return ok({ user, ...(password ? { password } : {}) }, password ? "Password reset" : "Login updated");
    },

    /** Best effort — a mail failure never fails the request. */
    async sendCredentials(company_id, client, user, password) {
        try {
            const agency = await AgencyModel.findByCompany(company_id);
            const from = esc(agency?.display_name || "Your recruitment partner");
            await sendEmail({
                to: user.email,
                subject: `${agency?.display_name || "Your recruitment partner"} — your hiring portal login`,
                html: `<p>Hi ${esc(user.full_name)},</p>
                       <p>${from} has set up a hiring portal for <b>${esc(client.name)}</b>. Track your job requests and review candidates here:</p>
                       <p><a href="${PORTAL_URL()}/client/login">${PORTAL_URL()}/client/login</a></p>
                       <p>Email: <b>${esc(user.email)}</b><br/>Password: <b>${esc(password)}</b></p>
                       <p>Please change the password after your first sign-in.</p>`,
            });
            return true;
        } catch (error) {
            console.warn("Client credentials email failed", error.message);
            return false;
        }
    },

    // ── Jobs ────────────────────────────────────────────────────────────────
    /** The apply-form catalog the job editor renders its switches from. */
    formCatalog() {
        return ok({
            fields: FIELD_CATALOG.map(({ key, label, type, locked, enabled, required }) => ({
                key, label, type, locked: Boolean(locked), enabled, required,
            })),
            question_types: QUESTION_TYPES,
            defaults: normalizeFormConfig({}),
        });
    },

    async listJobs(company_id, query) {
        const jobs = await JobModel.listForAgency(company_id, {
            status: query.status || undefined,
            client_id: query.client_id || undefined,
            q: str(query.q, 100) || undefined,
        });
        return ok(jobs.map((j) => ({ ...j, ...jobLinks(j.slug) })));
    },

    async getJob(company_id, id) {
        const job = await JobModel.findForAgency(id, company_id);
        if (!job) return fail("Job not found", 404);
        return ok({ ...job, form_config: normalizeFormConfig(job.form_config), ...jobLinks(job.slug) });
    },

    async assertClient(company_id, client_id) {
        if (!client_id) return true;
        return Boolean(await AgencyModel.findClient(client_id, company_id));
    },

    /** published_at / closed_at follow the status, set once and kept. */
    statusStamps(status, existing = {}) {
        const stamps = {};
        if (status === "open" && !existing.published_at) stamps.published_at = new Date();
        if (["closed", "filled"].includes(status)) stamps.closed_at = new Date();
        if (status === "open") stamps.closed_at = null;
        return stamps;
    },

    async createJob(company_id, user_id, body) {
        const { data, error } = sanitizeJob(body);
        if (error) return fail(error);

        const client_id = body.client_id || null;
        if (!(await this.assertClient(company_id, client_id))) return fail("Client not found");

        const status = AGENCY_JOB_STATUSES.includes(body.status) ? body.status : "draft";

        // Slug is fixed at creation so shared links and search results never break.
        let slug;
        const base = slugify(`${data.title} ${data.location_city || ""}`) || "job";
        do slug = `${base}-${shortId()}`; while (await JobModel.slugExists(slug));

        const job = await JobModel.create({
            ...data,
            form_config: data.form_config || normalizeFormConfig({}),
            agency_company_id: company_id,
            client_id,
            slug,
            status,
            source: "agency",
            created_by: user_id || null,
            ...this.statusStamps(status),
        });
        return ok({ ...job, ...jobLinks(job.slug) }, status === "open" ? "Job published" : "Job saved", 201);
    },

    async updateJob(company_id, id, body) {
        const existing = await JobModel.findForAgency(id, company_id);
        if (!existing) return fail("Job not found", 404);

        const { data, error } = sanitizeJob(body, { partial: true });
        if (error) return fail(error);

        if (body.client_id !== undefined) {
            if (!(await this.assertClient(company_id, body.client_id || null))) return fail("Client not found");
            data.client_id = body.client_id || null;
        }
        if (body.status !== undefined) {
            if (!AGENCY_JOB_STATUSES.includes(body.status)) return fail("Unknown status");
            data.status = body.status;
            Object.assign(data, this.statusStamps(body.status, existing));
        }
        // A bound job that loses its point would fail the DB check; say so plainly.
        const merged = { ...existing, ...data };
        if (merged.location_bound && (merged.bound_latitude == null || merged.bound_longitude == null || !Number(merged.bound_radius_km))) {
            return fail("A location-bound job needs a centre point and a radius");
        }

        const job = await JobModel.update(id, company_id, data);
        return ok({ ...job, ...jobLinks(job.slug) }, "Job updated");
    },

    // ── Pipeline ────────────────────────────────────────────────────────────
    async listApplications(company_id, job_id, query) {
        const job = await JobModel.findForAgency(job_id, company_id);
        if (!job) return fail("Job not found", 404);
        const rows = await ApplicationModel.listForJob(company_id, job_id, {
            stage: STAGES.includes(query.stage) ? query.stage : undefined,
            decision: query.decision || undefined,
        });
        return ok(rows);
    },

    async updateApplication(company_id, id, body) {
        const data = {};
        if (body.stage !== undefined) {
            if (!STAGES.includes(body.stage)) return fail("Unknown stage");
            data.stage = body.stage;
        }
        if (body.agency_notes !== undefined) data.agency_notes = str(body.agency_notes, 4000);
        if (body.shared_with_client !== undefined) {
            data.shared_with_client = Boolean(body.shared_with_client);
            if (data.shared_with_client) data.shared_at = new Date();
        }
        const row = await ApplicationModel.updateForAgency(id, company_id, data);
        return row ? ok(row, "Candidate updated") : fail("Application not found", 404);
    },

    async shareApplications(company_id, body) {
        const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === "string").slice(0, 200) : [];
        if (!ids.length) return fail("Select at least one candidate");
        const shared = body.shared !== false;
        const count = await ApplicationModel.setShared(company_id, ids, shared);
        return ok({ count }, shared ? `${count} candidate(s) sent to the client` : `${count} candidate(s) hidden from the client`);
    },

    async getCvFile(company_id, id) {
        const app = await ApplicationModel.findForAgency(id, company_id);
        if (!app?.cv_public_id) return fail("No CV on this application", 404);
        return ok({ public_id: app.cv_public_id, file_name: app.cv_file_name });
    },
};

module.exports = RecruitmentService;
