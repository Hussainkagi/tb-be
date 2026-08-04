const SuperAdminService = require("../service/superAdminService");
const ActivityLogService = require("../service/activityLogService");

/** Pulls the caller's identity + IP for auditing. */
const actorOf = (req) => ({
    user_id: req.user.user_id,
    company_id: req.user.company_id,
    role: req.user.role,
});

const ipOf = (req) =>
    (req.headers["x-forwarded-for"]?.split(",")[0] || req.ip || "").trim() || null;

const send = (res, result, okStatus = 200, failStatus = 400) =>
    res.status(result.success ? okStatus : failStatus).json(result);

const fail = (res, error) =>
    res.status(500).json({
        success: false,
        message: "Server error",
        error: error.message,
    });

const SuperAdminController = {
    // ── Bootstrap ────────────────────────────────────────────────────────────
    async me(req, res) {
        try {
            const result = await SuperAdminService.getMe(actorOf(req));
            return send(res, result, 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    // ── Dashboard ────────────────────────────────────────────────────────────
    async overview(req, res) {
        try {
            const result = await SuperAdminService.getOverview(req.query);
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    // ── Companies ────────────────────────────────────────────────────────────
    async listCompanies(req, res) {
        try {
            const result = await SuperAdminService.listCompanies(req.query);
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async listCompaniesLite(req, res) {
        try {
            const result = await SuperAdminService.listCompaniesLite();
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async getCompany(req, res) {
        try {
            const result = await SuperAdminService.getCompanyDetail(
                req.params.company_id,
                req.query
            );
            return send(res, result, 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    async listCompanyEmployees(req, res) {
        try {
            const result = await SuperAdminService.listCompanyEmployees(
                req.params.company_id,
                req.query
            );
            return send(res, result, 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    async listCompanyBranches(req, res) {
        try {
            const result = await SuperAdminService.listCompanyBranches(req.params.company_id);
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async listCompanyShifts(req, res) {
        try {
            const result = await SuperAdminService.listCompanyShifts(req.params.company_id);
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async listCompanyDepartments(req, res) {
        try {
            const result = await SuperAdminService.listCompanyDepartments(
                req.params.company_id
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async listCompanyAdmins(req, res) {
        try {
            const result = await SuperAdminService.listCompanyAdmins(req.params.company_id);
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    // ── Analytics ────────────────────────────────────────────────────────────
    async companyAttendanceStats(req, res) {
        try {
            const result = await SuperAdminService.getCompanyAttendanceStats(
                req.params.company_id,
                req.query
            );
            return send(res, result, 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    async companyLocations(req, res) {
        try {
            const result = await SuperAdminService.getCompanyLocations(
                req.params.company_id,
                req.query
            );
            return send(res, result, 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    async companyLeaveStats(req, res) {
        try {
            const result = await SuperAdminService.getCompanyLeaveStats(
                req.params.company_id,
                req.query
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    // ── Company controls ─────────────────────────────────────────────────────
    async disableCompany(req, res) {
        try {
            const result = await SuperAdminService.disableCompany(
                req.params.company_id,
                actorOf(req),
                { reason: req.body?.reason, ip_address: ipOf(req) }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async enableCompany(req, res) {
        try {
            const result = await SuperAdminService.enableCompany(
                req.params.company_id,
                actorOf(req),
                { ip_address: ipOf(req) }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async updateCompanyPlan(req, res) {
        try {
            const result = await SuperAdminService.updateCompanyPlan(
                req.params.company_id,
                { plan: req.body?.plan, plan_expires_at: req.body?.plan_expires_at },
                actorOf(req),
                { ip_address: ipOf(req) }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    // ── Super admin management ───────────────────────────────────────────────
    async listSuperAdmins(req, res) {
        try {
            const result = await SuperAdminService.listSuperAdmins();
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async grantSuperAdmin(req, res) {
        try {
            const result = await SuperAdminService.setSuperAdmin(
                req.params.user_id,
                true,
                actorOf(req),
                { ip_address: ipOf(req) }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async revokeSuperAdmin(req, res) {
        try {
            const result = await SuperAdminService.setSuperAdmin(
                req.params.user_id,
                false,
                actorOf(req),
                { ip_address: ipOf(req) }
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    // ── Activity log (every company's day-to-day actions) ────────────────────
    async listActivityLogs(req, res) {
        try {
            // ?company_id filters; omitted = platform-wide feed.
            const result = await ActivityLogService.list(
                req.query.company_id || null,
                req.query
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async companyActivityLogs(req, res) {
        try {
            const result = await ActivityLogService.list(req.params.company_id, req.query);
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async activityStats(req, res) {
        try {
            const result = await ActivityLogService.getStats(
                req.query.company_id || null,
                req.query
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async companyActivityStats(req, res) {
        try {
            const result = await ActivityLogService.getStats(
                req.params.company_id,
                req.query
            );
            return send(res, result, 200, 404);
        } catch (error) {
            return fail(res, error);
        }
    },

    async activityActionCatalog(req, res) {
        try {
            const result = await ActivityLogService.getActionCatalog(
                req.query.company_id || null
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    async entityHistory(req, res) {
        try {
            const result = await ActivityLogService.getEntityHistory(
                req.params.entity_type,
                req.params.entity_id,
                null // super admin sees the record's history across every tenant
            );
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },

    // ── Audit log (super admin's own platform actions) ───────────────────────
    async listAuditLogs(req, res) {
        try {
            const result = await SuperAdminService.listAuditLogs(req.query);
            return send(res, result);
        } catch (error) {
            return fail(res, error);
        }
    },
};

module.exports = SuperAdminController;
