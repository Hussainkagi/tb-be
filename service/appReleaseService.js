/**
 * Mobile app releases (migrations 59 + 60).
 *
 *   app_release_settings → the store link per platform
 *   app_releases         → every announced store build, each one Live or Stopped
 *
 * The app is told: latest = highest live release ("Update available"),
 * minimum = highest live release marked required ("Update required").
 *
 * The public read is hit by every app launch, so it is cached in memory for a
 * minute; any Super Admin change clears the cache.
 */
const db = require("../config/database");
const SuperAdminModel = require("../models/superAdminModel");

const PLATFORMS = ["android", "ios"];
const VERSION_RE = /^\d+(\.\d+){0,3}$/;
const CACHE_MS = 60 * 1000;
const label = (p) => (p === "ios" ? "iOS" : "Android");

let cache = { at: 0, data: null };
const bust = () => {
    cache.at = 0;
};

const compareVersions = (a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d;
    }
    return 0;
};
const newestFirst = (a, b) => compareVersions(b.version, a.version);

async function loadAll() {
    if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
    const [settings, releases] = await Promise.all([
        db.query(`SELECT platform, store_url FROM app_release_settings`),
        db.query(
            `SELECT r.id, r.platform, r.version, r.notes, r.is_required, r.is_active,
                    r.created_at, r.updated_at,
                    NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), '') AS updated_by_name
               FROM app_releases r
               LEFT JOIN users u ON u.id = COALESCE(r.updated_by, r.created_by)`,
        ),
    ]);
    const data = PLATFORMS.map((platform) => ({
        platform,
        store_url: settings.rows.find((s) => s.platform === platform)?.store_url ?? null,
        releases: releases.rows.filter((r) => r.platform === platform).sort(newestFirst),
    }));
    cache = { at: Date.now(), data };
    return data;
}

/** latest / minimum as the app sees them, from one platform's releases. */
function effective(releases) {
    const live = releases.filter((r) => r.is_active); // already newest first
    const latest = live[0] || null;
    const required = live.find((r) => r.is_required) || null;
    return {
        latest_version: latest?.version ?? null,
        min_version: required?.version ?? null,
        notes: latest?.notes ?? null,
    };
}

const clean = (v, max) => {
    if (v === undefined) return undefined;
    const s = String(v ?? "").trim();
    return s ? s.slice(0, max) : null;
};

const audit = (actor, action, metadata, ip_address) =>
    SuperAdminModel.createAuditLog({ actor_user_id: actor.user_id, action, metadata, ip_address }).catch(() => undefined);

async function findRelease(id) {
    const { rows } = await db.query(`SELECT * FROM app_releases WHERE id = $1`, [Number(id) || 0]);
    return rows[0] || null;
}

const AppReleaseService = {
    PLATFORMS,

    /** What the app reads. Never throws on a missing table — no data, no prompt. */
    async publicInfo(platform) {
        let entry = null;
        try {
            entry = (await loadAll()).find((p) => p.platform === platform) || null;
        } catch {
            // Not migrated yet.
        }
        const store_url =
            entry?.store_url ??
            (platform === "ios" ? process.env.APP_IOS_STORE_URL || null : process.env.APP_ANDROID_STORE_URL || null);
        return { platform, ...effective(entry?.releases || []), store_url };
    },

    /** Super Admin screen: both platforms, their releases, and what is live right now. */
    async list() {
        bust();
        const data = (await loadAll()).map((p) => ({ ...p, live: effective(p.releases) }));
        return { success: true, data };
    },

    async setStoreUrl(platform, body, actor, ip) {
        if (!PLATFORMS.includes(platform)) return { success: false, status: 404, message: "Unknown platform" };
        const store_url = clean(body.store_url, 500);
        if (store_url && !/^https:\/\/\S+$/i.test(store_url)) {
            return { success: false, message: "Store link must start with https://" };
        }
        await db.query(
            `INSERT INTO app_release_settings (platform, store_url, updated_by, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (platform) DO UPDATE SET store_url = EXCLUDED.store_url,
                                                  updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
            [platform, store_url, actor.user_id],
        );
        bust();
        await audit(actor, "app_version.store_link", { platform, store_url }, ip);
        return { success: true, message: `${label(platform)} store link saved` };
    },

    async create(body, actor, ip) {
        const platform = body.platform;
        if (!PLATFORMS.includes(platform)) return { success: false, message: "Pick Android or iOS" };
        const version = clean(body.version, 20);
        if (!version || !VERSION_RE.test(version)) return { success: false, message: "Version must look like 1.4.2" };

        const { rows: link } = await db.query(`SELECT store_url FROM app_release_settings WHERE platform = $1`, [platform]);
        if (!link[0]?.store_url) {
            return { success: false, message: `Add the ${label(platform)} store link first — the Update button opens it` };
        }

        try {
            const { rows } = await db.query(
                `INSERT INTO app_releases (platform, version, notes, is_required, created_by, updated_by)
                 VALUES ($1, $2, $3, $4, $5, $5) RETURNING *`,
                [platform, version, clean(body.notes, 500), body.is_required === true, actor.user_id],
            );
            bust();
            await audit(actor, "app_version.create", { platform, version, is_required: rows[0].is_required }, ip);
            return { success: true, status: 201, message: `${label(platform)} ${version} is live`, data: rows[0] };
        } catch (error) {
            if (error.code === "23505") return { success: false, status: 409, message: `${version} is already in the ${label(platform)} list — edit it there` };
            throw error;
        }
    },

    /** Edit a release: fix its version, notes, required flag, or stop / resume it. */
    async update(id, body, actor, ip) {
        const before = await findRelease(id);
        if (!before) return { success: false, status: 404, message: "Release not found" };

        const version = body.version === undefined ? before.version : clean(body.version, 20);
        if (!version || !VERSION_RE.test(version)) return { success: false, message: "Version must look like 1.4.2" };
        const notes = body.notes === undefined ? before.notes : clean(body.notes, 500);
        const is_required = typeof body.is_required === "boolean" ? body.is_required : before.is_required;
        const is_active = typeof body.is_active === "boolean" ? body.is_active : before.is_active;

        try {
            const { rows } = await db.query(
                `UPDATE app_releases
                    SET version = $2, notes = $3, is_required = $4, is_active = $5, updated_by = $6, updated_at = NOW()
                  WHERE id = $1 RETURNING *`,
                [before.id, version, notes, is_required, is_active, actor.user_id],
            );
            bust();
            await audit(
                actor,
                "app_version.update",
                {
                    platform: before.platform,
                    before: { version: before.version, is_required: before.is_required, is_active: before.is_active },
                    after: { version, is_required, is_active },
                },
                ip,
            );
            const what =
                before.is_active !== is_active
                    ? is_active
                        ? "is live again"
                        : "stopped — users are no longer prompted for it"
                    : "saved";
            return { success: true, message: `${label(before.platform)} ${version} ${what}`, data: rows[0] };
        } catch (error) {
            if (error.code === "23505") return { success: false, status: 409, message: `${version} is already in the list` };
            throw error;
        }
    },

    async remove(id, actor, ip) {
        const before = await findRelease(id);
        if (!before) return { success: false, status: 404, message: "Release not found" };
        await db.query(`DELETE FROM app_releases WHERE id = $1`, [before.id]);
        bust();
        await audit(actor, "app_version.delete", { platform: before.platform, version: before.version }, ip);
        return { success: true, message: `${label(before.platform)} ${before.version} removed` };
    },
};

module.exports = AppReleaseService;
