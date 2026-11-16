/**
 * Mobile app release settings (see migration 59).
 *
 * The public read is hit by every app launch, so it is cached in memory for a
 * minute; a Super Admin save clears the cache, so the change is live on the
 * next request from this process (and within a minute on any other replica).
 */
const db = require("../config/database");
const SuperAdminModel = require("../models/superAdminModel");

const PLATFORMS = ["android", "ios"];
const VERSION_RE = /^\d+(\.\d+){0,3}$/;
const CACHE_MS = 60 * 1000;

let cache = { at: 0, rows: null };

const compareVersions = (a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d;
    }
    return 0;
};

async function loadAll() {
    if (cache.rows && Date.now() - cache.at < CACHE_MS) return cache.rows;
    const { rows } = await db.query(
        `SELECT s.platform, s.latest_version, s.min_version, s.notes, s.store_url, s.updated_at,
                TRIM(CONCAT(u.first_name, ' ', u.last_name)) AS updated_by_name
           FROM app_release_settings s
           LEFT JOIN users u ON u.id = s.updated_by
          ORDER BY s.platform`,
    );
    cache = { at: Date.now(), rows };
    return rows;
}

const clean = (v, max) => {
    if (v === undefined) return undefined;
    const s = String(v ?? "").trim();
    return s ? s.slice(0, max) : null;
};

const AppReleaseService = {
    PLATFORMS,

    /** What the app reads. Falls back to env if the table is missing or empty. */
    async publicInfo(platform) {
        let row = null;
        try {
            row = (await loadAll()).find((r) => r.platform === platform) || null;
        } catch {
            // Table not migrated yet — the env fallback below still works.
        }
        const env = (key) => (process.env[`${key}_${platform.toUpperCase()}`] || process.env[key] || "").trim() || null;
        return {
            platform,
            latest_version: row?.latest_version ?? env("APP_LATEST_VERSION"),
            min_version: row?.min_version ?? env("APP_MIN_VERSION"),
            notes: row?.notes ?? (process.env.APP_UPDATE_NOTES?.trim() || null),
            store_url:
                row?.store_url ??
                (platform === "ios" ? process.env.APP_IOS_STORE_URL || null : process.env.APP_ANDROID_STORE_URL || null),
        };
    },

    async list() {
        cache.at = 0; // the Super Admin screen always sees the stored truth
        return { success: true, data: await loadAll() };
    },

    async update(platform, body, actor, ip_address) {
        if (!PLATFORMS.includes(platform)) return { success: false, status: 404, message: "Unknown platform" };

        const latest_version = clean(body.latest_version, 20);
        const min_version = clean(body.min_version, 20);
        const notes = clean(body.notes, 500);
        const store_url = clean(body.store_url, 500);

        for (const [label, v] of [["Latest version", latest_version], ["Minimum version", min_version]]) {
            if (v && !VERSION_RE.test(v)) return { success: false, message: `${label} must look like 1.4.0` };
        }
        if (latest_version && min_version && compareVersions(min_version, latest_version) > 0) {
            return { success: false, message: "Minimum version can't be newer than the latest version" };
        }
        if (store_url && !/^https:\/\/\S+$/i.test(store_url)) {
            return { success: false, message: "Store link must start with https://" };
        }
        if ((latest_version || min_version) && !store_url) {
            return { success: false, message: "Add the store link — the Update button opens it" };
        }

        const { rows: before } = await db.query(`SELECT * FROM app_release_settings WHERE platform = $1`, [platform]);
        const { rows } = await db.query(
            `INSERT INTO app_release_settings (platform, latest_version, min_version, notes, store_url, updated_by, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())
             ON CONFLICT (platform) DO UPDATE SET
                latest_version = EXCLUDED.latest_version,
                min_version    = EXCLUDED.min_version,
                notes          = EXCLUDED.notes,
                store_url      = EXCLUDED.store_url,
                updated_by     = EXCLUDED.updated_by,
                updated_at     = NOW()
             RETURNING *`,
            [platform, latest_version, min_version, notes, store_url, actor.user_id],
        );
        cache.at = 0;

        await SuperAdminModel.createAuditLog({
            actor_user_id: actor.user_id,
            action: "app_version.update",
            metadata: {
                platform,
                before: before[0]
                    ? { latest_version: before[0].latest_version, min_version: before[0].min_version }
                    : null,
                after: { latest_version, min_version },
            },
            ip_address,
        }).catch(() => undefined);

        return { success: true, message: `${platform === "ios" ? "iOS" : "Android"} settings saved — live now`, data: rows[0] };
    },
};

module.exports = AppReleaseService;
