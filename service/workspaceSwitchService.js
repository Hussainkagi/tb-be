/**
 * Move a signed-in person into another workspace they already belong to —
 * today: from their recruitment agency into their teamBook HRMS company.
 *
 *   1. list()        — the HRMS companies this person is an active member of
 *   2. createLink()  — a one-time link  /switch?token=…  (2 minutes, single use)
 *   3. redeem()      — the link becomes a normal session for that company
 *
 * The person proved who they are when they signed in to the agency (same
 * Teambook account, verified email), so no second password is asked — the
 * same trust the HRMS app's own company switcher relies on.
 */
const crypto = require("crypto");
const db = require("../config/database");
const UserCompanyModel = require("../models/userCompanyModel");
const UserCompanyService = require("./userCompanyService");
const { RoleLabel } = require("../enums/roles");

const LINK_TTL_SECONDS = 120;

const ok = (data, message = "OK", status = 200) => ({ success: true, status, message, data });
const fail = (message, status = 400) => ({ success: false, status, message });
const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

/** Active HRMS memberships of a user — safe fields only (never password hashes). */
async function hrmsMemberships(user_id) {
    const { rows } = await db.query(
        `SELECT uc.username, uc.role, c.id AS company_id, c.company_name, c.logo_url
           FROM user_companies uc
           JOIN companies c ON c.id = uc.company_id
          WHERE uc.user_id = $1
            AND uc.is_active = TRUE AND uc.deleted_at IS NULL
            AND c.deleted_at IS NULL AND c.account_type = 'hrms'
          ORDER BY uc.role ASC, uc.created_at ASC`,
        [user_id],
    );
    return rows;
}

const WorkspaceSwitchService = {
    async list(user_id) {
        const rows = await hrmsMemberships(user_id);
        return ok(
            rows.map((r) => ({
                company_id: r.company_id,
                company_name: r.company_name,
                logo_url: r.logo_url,
                role: RoleLabel[Number(r.role)] || "Member",
            })),
        );
    },

    async createLink(user_id, from_company_id, to_company_id) {
        const target = (await hrmsMemberships(user_id)).find((m) => m.company_id === to_company_id);
        if (!target) return fail("You're not a member of that teamBook workspace", 404);

        const token = crypto.randomBytes(32).toString("base64url");
        await db.query(
            `INSERT INTO workspace_switch_tokens (token_hash, user_id, from_company_id, to_company_id, expires_at)
             VALUES ($1, $2, $3, $4, NOW() + ($5 || ' seconds')::interval)`,
            [sha(token), user_id, from_company_id || null, to_company_id, String(LINK_TTL_SECONDS)],
        );
        // Housekeeping: links are useless a minute after they expire.
        db.query(`DELETE FROM workspace_switch_tokens WHERE expires_at < NOW() - INTERVAL '1 day'`).catch(() => {});

        return ok({ url: `/switch?token=${token}`, expires_in: LINK_TTL_SECONDS }, "Link ready");
    },

    /** Turn a link into a session. Works once; a used or old link is refused. */
    async redeem(token) {
        if (!token || typeof token !== "string" || token.length > 200) return fail("This link isn't valid", 400);

        // Claim it atomically so two tabs can't both use it.
        const { rows } = await db.query(
            `UPDATE workspace_switch_tokens
                SET used_at = NOW()
              WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
              RETURNING user_id, to_company_id`,
            [sha(token)],
        );
        const claim = rows[0];
        if (!claim) return fail("This link has expired or was already used — open your workspace again from the agency", 410);

        const target = (await hrmsMemberships(claim.user_id)).find((m) => m.company_id === claim.to_company_id);
        if (!target) return fail("You no longer have access to that workspace", 403);

        const uc = await UserCompanyModel.findByUsername(target.username);
        if (!uc || !uc.user_is_active) return fail("This account is inactive", 403);

        const session = await UserCompanyService.issueSession(uc);
        if (!session.success) return session;
        return ok(session.data, `Welcome to ${target.company_name}`);
    },
};

module.exports = WorkspaceSwitchService;
