/**
 * Thin HTTP layer for recruitment. Services return
 * { success, status, message, data }; `handle` turns that into a response,
 * so every endpoint here is one line.
 */
const { Readable } = require("stream");
const RecruitmentService = require("../../service/Recruitment/recruitmentService");
const PublicJobService = require("../../service/Recruitment/publicJobService");
const ClientPortalService = require("../../service/Recruitment/clientPortalService");
const { privateDownloadUrl } = require("../../utils/cloudinaryHelper");

const handle = (fn) => async (req, res) => {
    try {
        const { status, ...body } = await fn(req, res);
        return res.status(status || (body.success ? 200 : 400)).json(body);
    } catch (error) {
        console.error("[recruitment]", error);
        return res.status(500).json({ success: false, message: "Something went wrong. Please try again." });
    }
};

/**
 * Streams a CV through the server. Cloudinary free accounts refuse to deliver
 * PDFs publicly, so the signed API URL is fetched here and never exposed.
 */
const streamCv = (lookup) => async (req, res) => {
    try {
        const result = await lookup(req);
        if (!result.success) return res.status(result.status || 404).json({ success: false, message: result.message });
        const { public_id, file_name } = result.data;
        const upstream = await fetch(privateDownloadUrl(public_id, { resourceType: "raw" }));
        if (!upstream.ok || !upstream.body) return res.status(502).json({ success: false, message: "Could not fetch the CV. Please try again." });

        const name = String(file_name || public_id.split("/").pop()).replace(/[^\w.\- ]/g, "_");
        const ext = name.split(".").pop().toLowerCase();
        const mime = { pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }[ext] || "application/octet-stream";
        res.setHeader("Content-Type", mime);
        // PDFs open in the browser tab; Word files download.
        res.setHeader("Content-Disposition", `${ext === "pdf" ? "inline" : "attachment"}; filename="${name}"`);
        res.setHeader("Cache-Control", "private, no-store");
        Readable.fromWeb(upstream.body).pipe(res);
    } catch (error) {
        console.error("[recruitment] cv", error);
        if (!res.headersSent) res.status(500).json({ success: false, message: "Could not fetch the CV." });
    }
};

const cid = (req) => req.params.company_id;

// ── Agency (staff, /api/companies/:company_id/recruitment) ──────────────────
const AgencyController = {
    getAgency:        handle((req) => RecruitmentService.getAgency(cid(req))),
    saveAgency:       handle((req) => RecruitmentService.saveAgency(cid(req), req.body)),
    uploadLogo:       handle((req) => RecruitmentService.uploadLogo(cid(req), req.file)),
    removeLogo:       handle((req) => RecruitmentService.removeLogo(cid(req))),
    overview:         handle((req) => RecruitmentService.overview(cid(req))),
    formCatalog:      handle(() => RecruitmentService.formCatalog()),

    listClients:      handle((req) => RecruitmentService.listClients(cid(req))),
    getClient:        handle((req) => RecruitmentService.getClient(cid(req), req.params.id)),
    createClient:     handle((req) => RecruitmentService.createClient(cid(req), req.body)),
    updateClient:     handle((req) => RecruitmentService.updateClient(cid(req), req.params.id, req.body)),
    createClientUser: handle((req) => RecruitmentService.createClientUser(cid(req), req.params.id, req.body)),
    updateClientUser: handle((req) => RecruitmentService.updateClientUser(cid(req), req.params.userId, req.body)),

    listJobs:         handle((req) => RecruitmentService.listJobs(cid(req), req.query)),
    getJob:           handle((req) => RecruitmentService.getJob(cid(req), req.params.id)),
    createJob:        handle((req) => RecruitmentService.createJob(cid(req), req.user?.user_id, req.body)),
    updateJob:        handle((req) => RecruitmentService.updateJob(cid(req), req.params.id, req.body)),

    listApplications: handle((req) => RecruitmentService.listApplications(cid(req), req.params.id, req.query)),
    updateApplication:handle((req) => RecruitmentService.updateApplication(cid(req), req.params.appId, req.body)),
    shareApplications:handle((req) => RecruitmentService.shareApplications(cid(req), req.body)),
    downloadCv:       streamCv((req) => RecruitmentService.getCvFile(cid(req), req.params.appId)),
};

// ── Public portal (/api/public/jobs) ────────────────────────────────────────
const PublicController = {
    list:    handle((req) => PublicJobService.list(req.query)),
    facets:  handle(() => PublicJobService.facets()),
    sitemap: handle(() => PublicJobService.sitemap()),
    get:     handle((req) => PublicJobService.get(req.params.slug)),
    apply:   handle((req) => PublicJobService.apply(req.params.slug, req.body, req.file)),
};

// ── Client portal (/api/recruitment-client) ─────────────────────────────────
const ClientController = {
    login:          handle((req) => ClientPortalService.login(req.body?.email, req.body?.password)),
    me:             handle((req) => ClientPortalService.me(req.client)),
    changePassword: handle((req) => ClientPortalService.changePassword(req.client, req.body)),
    listJobs:       handle((req) => ClientPortalService.listJobs(req.client)),
    getJob:         handle((req) => ClientPortalService.getJob(req.client, req.params.id)),
    requestJob:     handle((req) => ClientPortalService.requestJob(req.client, req.body)),
    listCandidates: handle((req) => ClientPortalService.listCandidates(req.client, req.query)),
    decide:         handle((req) => ClientPortalService.decide(req.client, req.params.appId, req.body)),
    downloadCv:     streamCv((req) => ClientPortalService.getCvFile(req.client, req.params.appId)),
};

module.exports = { AgencyController, PublicController, ClientController };
