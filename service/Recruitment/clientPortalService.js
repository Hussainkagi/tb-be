/**
 * The client portal: an agency's customer signs in, sees the jobs they asked
 * for, reviews the candidates the agency shared, and approves / rejects /
 * finalizes them. They can also raise a new job request.
 *
 * Everything is scoped by `ctx.client_id` from the client token.
 */
const AgencyModel = require("../../models/Recruitment/agencyModel");
const JobModel = require("../../models/Recruitment/jobModel");
const ApplicationModel = require("../../models/Recruitment/applicationModel");
const { hashPassword, comparePassword } = require("../../utils/password");
const { normalizeFormConfig } = require("../../utils/recruitmentForm");
const { signClientToken } = require("../../middleware/verifyClientToken");
const { CLIENT_DECISIONS, sanitizeJob, slugify, shortId, str } = require("./recruitmentShared");

const ok = (data, message = "Success", status = 200) => ({ success: true, status, message, data });
const fail = (message, status = 400) => ({ success: false, status, message });

const MAX_FAILED = 8;

// The client never sees the agency's private notes or the CV storage ids.
const forClient = (row) => {
    const { agency_notes, ...rest } = row; // eslint-disable-line no-unused-vars
    return rest;
};

const ClientPortalService = {
    async login(email, password) {
        if (!email || !password) return fail("Enter your email and password");
        const user = await AgencyModel.findClientUserForLogin(String(email).trim());
        // Same message for every failure, so emails cannot be probed.
        const denied = fail("Invalid email or password", 401);
        if (!user) return denied;
        if (!user.is_active || !user.client_is_active) return fail("This login has been disabled. Contact your recruitment agency.", 403);
        if (user.failed_login_attempts >= MAX_FAILED) return fail("Too many failed attempts. Ask your agency to reset your password.", 423);

        const match = await comparePassword(String(password), user.password_hash);
        await AgencyModel.recordLogin(user.id, match);
        if (!match) return denied;

        const token = signClientToken({
            client_user_id: user.id,
            client_id: user.client_id,
            agency_company_id: user.agency_company_id,
        });
        const branding = await AgencyModel.clientBranding(user.client_id);
        return ok({
            token,
            user: { id: user.id, full_name: user.full_name, email: user.email },
            branding,
        }, "Signed in");
    },

    /** Re-checks the login is still active on every page load. */
    async me(ctx) {
        const user = await AgencyModel.findClientUserById(ctx.client_user_id);
        if (!user || !user.is_active || !user.client_is_active) return fail("This login has been disabled.", 401);
        const branding = await AgencyModel.clientBranding(ctx.client_id);
        return ok({ user: { id: user.id, full_name: user.full_name, email: user.email }, branding });
    },

    async changePassword(ctx, body) {
        const user = await AgencyModel.findClientUserById(ctx.client_user_id);
        if (!user) return fail("Login not found", 404);
        if (!(await comparePassword(String(body.current_password || ""), user.password_hash))) return fail("Current password is wrong");
        const next = String(body.new_password || "");
        if (next.length < 8) return fail("New password must be at least 8 characters");
        await AgencyModel.updateClientUser(user.id, user.agency_company_id, { password_hash: await hashPassword(next) });
        return ok(null, "Password changed");
    },

    async listJobs(ctx) {
        return ok(await JobModel.listForClient(ctx.agency_company_id, ctx.client_id));
    },

    async getJob(ctx, id) {
        const job = await JobModel.findForClient(id, ctx.client_id);
        if (!job) return fail("Job not found", 404);
        const candidates = await ApplicationModel.listForClient(ctx.client_id, { job_id: id });
        const { form_config, created_by, bound_latitude, bound_longitude, ...rest } = job; // eslint-disable-line no-unused-vars
        return ok({ job: rest, candidates: candidates.map(forClient) });
    },

    /** A new hiring need from the client. The agency reviews and publishes it. */
    async requestJob(ctx, body) {
        const { data, error } = sanitizeJob({
            title: body.title,
            sector: body.sector,
            employment_type: body.employment_type || "full_time",
            work_mode: body.work_mode || "onsite",
            openings: body.openings || 1,
            description: body.description,
            requirements: body.requirements,
            experience_min: body.experience_min,
            experience_max: body.experience_max,
            education: body.education,
            location_city: body.location_city,
            location_country: body.location_country,
            salary_min: body.salary_min,
            salary_max: body.salary_max,
            salary_currency: body.salary_currency,
            deadline: body.deadline,
        });
        if (error) return fail(error);

        let slug;
        const base = slugify(`${data.title} ${data.location_city || ""}`) || "job";
        do slug = `${base}-${shortId()}`; while (await JobModel.slugExists(slug));

        const job = await JobModel.create({
            ...data,
            agency_company_id: ctx.agency_company_id,
            client_id: ctx.client_id,
            slug,
            status: "requested",
            source: "client",
            form_config: normalizeFormConfig({}),
        });
        return ok({ id: job.id, title: job.title, status: job.status }, "Request sent to your agency", 201);
    },

    async listCandidates(ctx, query) {
        const decision = CLIENT_DECISIONS.includes(query.decision) ? query.decision : undefined;
        const rows = await ApplicationModel.listForClient(ctx.client_id, { decision, job_id: query.job_id || undefined });
        return ok(rows.map(forClient));
    },

    async decide(ctx, id, body) {
        const decision = body.decision;
        if (!["approved", "rejected", "finalized", "pending"].includes(decision)) return fail("Choose approve, reject or finalize");
        const app = await ApplicationModel.findForClient(id, ctx.client_id);
        if (!app) return fail("Candidate not found", 404);
        const saved = await ApplicationModel.setClientDecision(id, decision, str(body.feedback, 2000) ?? null);
        const label = { approved: "Candidate approved", rejected: "Candidate rejected", finalized: "Candidate finalized", pending: "Decision cleared" }[decision];
        return ok(saved, label);
    },

    async getCvFile(ctx, id) {
        const app = await ApplicationModel.findForClient(id, ctx.client_id);
        if (!app?.cv_public_id) return fail("No CV on this candidate", 404);
        return ok({ public_id: app.cv_public_id, file_name: app.cv_file_name });
    },
};

module.exports = ClientPortalService;
