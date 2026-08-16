const { PolicyService } = require("../service/policyService");

/**
 * The client's IP, honouring the proxy header the app is deployed behind.
 * Recorded against every acceptance — an "I Agree" with no origin is weak
 * evidence, and the header is the only source once traffic passes through a
 * load balancer.
 */
const clientIp = (req) =>
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.ip ||
    req.connection?.remoteAddress ||
    null;

const fail = (res, result, fallbackStatus = 400) =>
    res.status(result.code === "POLICY_SUPERSEDED" ? 409 : fallbackStatus).json(result);

const PolicyController = {
    // ═════════════════════════════════════════════════════════════════════════
    // PUBLIC — the registration screen
    // ═════════════════════════════════════════════════════════════════════════

    /** GET /api/policies?country=AE[&policy_type=terms] */
    async getPublicPolicies(req, res) {
        try {
            const result = await PolicyService.getPolicyForCountry(req.query.country, {
                policy_type: req.query.policy_type || null,
            });
            return result.success ? res.status(200).json(result) : fail(res, result, 404);
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // ═════════════════════════════════════════════════════════════════════════
    // COMPANY — profile Legal tab
    // ═════════════════════════════════════════════════════════════════════════

    /** GET /api/companies/:company_id/policies */
    async getCompanyPolicies(req, res) {
        try {
            const result = await PolicyService.getCompanyPolicyStatus(req.params.company_id);
            return result.success ? res.status(200).json(result) : fail(res, result, 404);
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    /** GET /api/companies/:company_id/policies/:policy_type */
    async getCompanyPolicyDocument(req, res) {
        try {
            const result = await PolicyService.getCompanyPolicyDocument(
                req.params.company_id,
                req.params.policy_type
            );
            return result.success ? res.status(200).json(result) : fail(res, result, 404);
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    /** POST /api/companies/:company_id/policies/:policy_type/accept */
    async acceptCompanyPolicy(req, res) {
        try {
            const result = await PolicyService.acceptPolicy({
                company_id: req.params.company_id,
                policy_type: req.params.policy_type,
                policy_document_id: req.body?.policy_document_id || null,
                accepted_by_user_id: req.user?.user_id || null,
                accepted_by_name: req.body?.accepted_by_name || null,
                accepted_by_email: req.body?.accepted_by_email || req.user?.email || null,
                ip_address: clientIp(req),
                user_agent: req.headers["user-agent"] || null,
            });
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    /** GET /api/companies/:company_id/policies/acceptances[?policy_type=terms] */
    async getCompanyAcceptances(req, res) {
        try {
            const result = await PolicyService.getCompanyAcceptances(req.params.company_id, {
                policy_type: req.query.policy_type || null,
            });
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    // ═════════════════════════════════════════════════════════════════════════
    // SUPER ADMIN
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * POST /api/super-admin/policies  (multipart/form-data)
     *
     * Fields: file (.docx, required), policy_type, country, title,
     *         change_note, effective_from, requires_reacceptance, notify
     *
     * Multipart sends everything as strings, so the two booleans are parsed
     * here rather than in the service — "false" is truthy in JavaScript, and
     * letting it through would silently notify every admin on a publish the
     * Super Admin explicitly marked as quiet.
     */
    async publishPolicy(req, res) {
        try {
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: "A document file is required (field name: 'file')",
                });
            }

            const asBool = (value, fallback) =>
                value === undefined || value === null || value === ""
                    ? fallback
                    : !["false", "0", "no"].includes(String(value).toLowerCase());

            const result = await PolicyService.publish({
                file_buffer: req.file.buffer,
                file_name: req.file.originalname,
                file_mime: req.file.mimetype,
                file_size: req.file.size,
                policy_type: req.body.policy_type,
                country: req.body.country || req.body.country_code || null,
                title: req.body.title || null,
                change_note: req.body.change_note || null,
                effective_from: req.body.effective_from || null,
                requires_reacceptance: asBool(req.body.requires_reacceptance, true),
                notify: asBool(req.body.notify, true),
                actor_user_id: req.user?.user_id || null,
                ip_address: clientIp(req),
            });

            return result.success ? res.status(201).json(result) : fail(res, result);
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    /** GET /api/super-admin/policies — one row per (type, country) lane */
    async listLanes(_req, res) {
        try {
            const result = await PolicyService.listLanes();
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    /** GET /api/super-admin/policies/current[?policy_type&country] */
    async listCurrent(req, res) {
        try {
            const result = await PolicyService.listCurrent({
                policy_type: req.query.policy_type || null,
                country: req.query.country || null,
            });
            return result.success ? res.status(200).json(result) : fail(res, result);
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    /**
     * GET /api/super-admin/policies/versions?policy_type=terms&country=AE
     *
     * The archive. Paginated because a long-lived lane accumulates versions
     * indefinitely — nothing here is ever deleted.
     */
    async listVersions(req, res) {
        try {
            const page = Number(req.query.page) || 1;
            const limit = Number(req.query.limit) || 20;

            const result = await PolicyService.listVersions({
                policy_type: req.query.policy_type,
                country: req.query.country || null,
                page,
                limit,
            });

            if (!result.success) return fail(res, result);

            return res.status(200).json({
                success: true,
                message: "Success",
                data: result.data,
                pagination: {
                    page,
                    limit,
                    total: result.total,
                    totalPages: Math.ceil(result.total / limit),
                    hasNextPage: page * limit < result.total,
                    hasPrevPage: page > 1,
                },
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    /** GET /api/super-admin/policies/:id — full content of any version */
    async getDocument(req, res) {
        try {
            const result = await PolicyService.getDocument(req.params.id);
            return result.success ? res.status(200).json(result) : fail(res, result, 404);
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },

    /** GET /api/super-admin/policies/:id/acceptances */
    async listDocumentAcceptances(req, res) {
        try {
            const page = Number(req.query.page) || 1;
            const limit = Number(req.query.limit) || 50;

            const result = await PolicyService.listDocumentAcceptances(req.params.id, {
                page,
                limit,
            });

            if (!result.success) return fail(res, result, 404);

            return res.status(200).json({
                success: true,
                message: "Success",
                data: result.data,
                pagination: {
                    page,
                    limit,
                    total: result.total,
                    totalPages: Math.ceil(result.total / limit),
                    hasNextPage: page * limit < result.total,
                    hasPrevPage: page > 1,
                },
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: "Server error",
                error: error.message,
            });
        }
    },
};

module.exports = PolicyController;
