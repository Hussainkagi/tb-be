const ActivityLogModel = require("../models/activityLogModel");
const CompanyModel = require("../models/companyModel");

/**
 * Activity log reads.
 *
 * Two audiences:
 *   - Company Admins → their own company's timeline only (company_id forced).
 *   - Super Admins   → any company, or the whole platform (company_id = null).
 */

const DEFAULT_WINDOW_DAYS = 30;
const MAX_PAGE_SIZE = 200;

const toDateString = (d) => d.toISOString().slice(0, 10);

function resolveDateRange(from, to, days = DEFAULT_WINDOW_DAYS) {
    const isValid = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

    const end = isValid(to) ? to : toDateString(new Date());
    let start;

    if (isValid(from)) {
        start = from;
    } else {
        const d = new Date(`${end}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - (days - 1));
        start = toDateString(d);
    }
    if (start > end) start = end;

    return { from: start, to: end };
}

function resolvePaging(query) {
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const rawLimit = parseInt(query.limit, 10) || 50;
    return { page, limit: Math.min(Math.max(rawLimit, 1), MAX_PAGE_SIZE) };
}

const toNum = (v) => (v === null || v === undefined ? v : Number(v));

/** Human-readable sentence for the UI, so the frontend doesn't hand-roll one. */
function describe(row) {
    const who = row.actor_name || row.username || "Someone";
    const [entity, verb] = (row.action || "").split(".");

    const VERB_TEXT = {
        create: "created a",
        update: "updated a",
        delete: "deleted a",
        deactivate: "deactivated a",
        disable: "disabled a",
        enable: "enabled a",
        login: "logged in",
        logout: "logged out",
    };

    let sentence;
    if (entity === "auth") {
        sentence = `${who} ${VERB_TEXT[verb] || verb}`;
    } else {
        const readableEntity = (entity || "record").replace(/-/g, " ");
        const phrase = VERB_TEXT[verb] || `performed "${verb}" on a`;
        sentence = `${who} ${phrase} ${readableEntity}`;
    }

    sentence = sentence.replace(/\s+/g, " ").trim();
    return row.is_success ? sentence : `${sentence} — failed`;
}

const decorate = (row) => ({
    ...row,
    duration_ms: toNum(row.duration_ms),
    status_code: toNum(row.status_code),
    description: describe(row),
});

const ActivityLogService = {
    /**
     * Paginated feed.
     * @param {String|null} company_id  null = platform-wide (super admin only)
     */
    async list(company_id, query = {}) {
        try {
            const { page, limit } = resolvePaging(query);

            const { rows, total } = await ActivityLogModel.list({
                page,
                limit,
                company_id,
                user_id: query.user_id || null,
                action: query.action || null,
                entity_type: query.entity_type || null,
                entity_id: query.entity_id || null,
                method: query.method || null,
                status: query.status || null,
                search: query.search || null,
                from: query.from || null,
                to: query.to || null,
            });

            return {
                success: true,
                data: rows.map(decorate),
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasNextPage: page * limit < total,
                    hasPrevPage: page > 1,
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Timeline of a single record (e.g. everything done to one employee). */
    async getEntityHistory(entity_type, entity_id, company_id = null) {
        try {
            const rows = await ActivityLogModel.listForEntity(entity_type, entity_id);

            // A company admin must not see another tenant's rows.
            const scoped = company_id
                ? rows.filter((r) => String(r.company_id) === String(company_id))
                : rows;

            return { success: true, data: scoped.map(decorate) };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Dashboard-style rollup. company_id = null → platform-wide. */
    async getStats(company_id, query = {}) {
        try {
            if (company_id) {
                const company = await CompanyModel.findById(company_id);
                if (!company) return { success: false, message: "Company not found" };
            }

            const { from, to } = resolveDateRange(query.from, query.to);

            const [summary, topActions, topActors, daily] = await Promise.all([
                ActivityLogModel.summary(company_id, from, to),
                ActivityLogModel.topActions(company_id, from, to, 15),
                ActivityLogModel.topActors(company_id, from, to, 10),
                ActivityLogModel.dailyVolume(company_id, from, to),
            ]);

            // Only the platform view needs the per-company breakdown.
            const byCompany = company_id
                ? null
                : await ActivityLogModel.volumeByCompany(from, to, 50);

            return {
                success: true,
                data: {
                    date_range: { from, to },
                    summary: {
                        total_actions: toNum(summary.total_actions),
                        success_count: toNum(summary.success_count),
                        failure_count: toNum(summary.failure_count),
                        active_users: toNum(summary.active_users),
                        active_companies: toNum(summary.active_companies),
                        login_count: toNum(summary.login_count),
                        avg_duration_ms: toNum(summary.avg_duration_ms),
                        failure_rate: toNum(summary.total_actions)
                            ? Number(
                                  (
                                      (toNum(summary.failure_count) /
                                          toNum(summary.total_actions)) *
                                      100
                                  ).toFixed(2)
                              )
                            : 0,
                    },
                    top_actions: topActions.map((r) => ({
                        ...r,
                        count: toNum(r.count),
                        failure_count: toNum(r.failure_count),
                    })),
                    top_actors: topActors.map((r) => ({
                        ...r,
                        action_count: toNum(r.action_count),
                    })),
                    daily_volume: daily.map((r) => ({
                        ...r,
                        total: toNum(r.total),
                        failures: toNum(r.failures),
                    })),
                    ...(byCompany
                        ? {
                              by_company: byCompany.map((r) => ({
                                  ...r,
                                  action_count: toNum(r.action_count),
                                  failure_count: toNum(r.failure_count),
                                  active_users: toNum(r.active_users),
                              })),
                          }
                        : {}),
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Distinct action names, for populating the filter dropdown. */
    async getActionCatalog(company_id) {
        try {
            const rows = await ActivityLogModel.distinctActions(company_id);
            return { success: true, data: rows };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = ActivityLogService;
