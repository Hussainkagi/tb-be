const db = require("../config/database");
const { verifyAccessToken } = require("../utils/jwt");

/**
 * Records every state-changing API call into `activity_logs`.
 *
 * Mounted once on /api, so every module is covered without touching a single
 * controller. Writes happen AFTER the response is flushed (`res.on("finish")`)
 * and never block or fail the request — a logging problem must not break the API.
 *
 * GETs are ignored: high volume, no state change.
 */

const SKIP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Any key matching these has its value replaced with "[REDACTED]" before storage.
const SECRET_KEYS = [
    "password", "new_password", "old_password", "confirm_password",
    "password_hash", "token", "access_token", "refresh_token",
    "otp", "secret", "authorization", "expo_push_token", "fcm_token",
];

/** Auth routes get readable names instead of the generic resource.verb rule. */
const SPECIAL_ACTIONS = {
    "auth/login": "auth.login",
    "auth/logout": "auth.logout",
    "auth/register": "company.register",
    "auth/verify-otp": "auth.verify-otp",
    "auth/forgot-password": "auth.forgot-password",
    "auth/reset-password": "auth.reset-password",
    "auth/set-password": "auth.set-password",
    "auth/switch-company": "auth.switch-company",
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 4096;

// ── Redaction ────────────────────────────────────────────────────────────────

/** Deep-clones a value with secret fields masked and long strings clipped. */
function redact(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth > 6) return "[TRUNCATED]";

    if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));

    if (typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = SECRET_KEYS.some((s) => k.toLowerCase().includes(s))
                ? "[REDACTED]"
                : redact(v, depth + 1);
        }
        return out;
    }

    if (typeof value === "string" && value.length > 500) {
        return value.slice(0, 500) + "…[truncated]";
    }

    return value;
}

/** Redacted request body, capped so a bulk upload can't bloat the table. */
function buildBody(req) {
    if (!req.body || typeof req.body !== "object") return null;
    if (Object.keys(req.body).length === 0) return null;

    const safe = redact(req.body);
    const json = JSON.stringify(safe);

    if (json.length > MAX_BODY_BYTES) {
        return {
            _truncated: true,
            _original_size_bytes: json.length,
            _keys: Object.keys(req.body).slice(0, 40),
        };
    }
    return safe;
}

// ── Action naming ────────────────────────────────────────────────────────────

/** "branches" → "branch", "companies" → "company", "shifts" → "shift" */
function singularize(word) {
    if (/ies$/i.test(word)) return word.replace(/ies$/i, "y");
    if (/(ch|sh|ss|x)es$/i.test(word)) return word.replace(/es$/i, "");
    if (/s$/i.test(word) && !/ss$/i.test(word)) return word.replace(/s$/i, "");
    return word;
}

const VERB_BY_METHOD = { POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" };

/**
 * Trailing URL segments that name an ACTION rather than a resource collection.
 * Without this list `/companies/:id/branches` (a collection create) is
 * indistinguishable from `/leave-requests/:id/approve` (an action on a record).
 * Anything not listed here is treated as a resource, which degrades gracefully.
 */
const ACTION_VERBS = new Set([
    "approve", "reject", "cancel", "submit",
    "activate", "deactivate", "disable", "enable",
    "invite", "bulk-invite", "bulk-upload", "upload", "import", "export", "template",
    "check-in", "check-out",
    "read", "read-all", "resend", "retry",
    "role", "plan", "grant", "revoke",
    "generate", "finalize", "lock", "unlock", "recalculate", "mark-paid", "download",
]);

/**
 * Turns a URL into a readable action name plus the entity it touched.
 *
 *   POST   /api/companies/:cid/branches                       → branch.create
 *   PATCH  /api/companies/:cid/branches/:id                   → branch.update    (entity_id = :id)
 *   DELETE /api/companies/:cid/employees/:id                  → employee.delete
 *   POST   /api/companies/:cid/attendance/check-in            → attendance.check-in
 *   PATCH  /api/companies/:cid/leave-requests/:id/approve     → leave-request.approve
 *   PATCH  /api/super-admin/companies/:id/disable             → company.disable
 *   POST   /api/user-companies/auth/login                     → auth.login
 */
function describeAction(method, path) {
    for (const [suffix, action] of Object.entries(SPECIAL_ACTIONS)) {
        if (path.endsWith(suffix)) {
            return { action, entity_type: "auth", entity_id: null };
        }
    }

    const segments = path.split("/").filter(Boolean).filter((s) => s !== "api");
    if (!segments.length) return { action: "unknown", entity_type: null, entity_id: null };

    const last = segments[segments.length - 1];
    const secondLast = segments[segments.length - 2];
    const thirdLast = segments[segments.length - 3];
    const verb = VERB_BY_METHOD[method] || method.toLowerCase();

    // .../<resource>/<uuid> → verb on that specific record
    if (UUID_RE.test(last)) {
        const resource = singularize(secondLast || "resource");
        return { action: `${resource}.${verb}`, entity_type: resource, entity_id: last };
    }

    // .../<named-action> → an action, not a collection
    if (ACTION_VERBS.has(last)) {
        // .../<resource>/<uuid>/<action> → acts on that record
        if (UUID_RE.test(secondLast)) {
            const resource = singularize(thirdLast || "resource");
            return { action: `${resource}.${last}`, entity_type: resource, entity_id: secondLast };
        }
        // .../<resource>/<action> → acts on the collection
        const resource = singularize(
            secondLast && !UUID_RE.test(secondLast) ? secondLast : last
        );
        return { action: `${resource}.${last}`, entity_type: resource, entity_id: null };
    }

    // .../<resource> → verb on the collection (entity_id comes from the response)
    const resource = singularize(last);
    return { action: `${resource}.${verb}`, entity_type: resource, entity_id: null };
}

// ── Context resolution ───────────────────────────────────────────────────────

/** company_id from the JWT, the login response, or the /companies/:id URL segment. */
function resolveCompanyId(decoded, captured, path) {
    if (decoded?.company_id) return decoded.company_id;

    const d = captured?.data;
    if (d?.company?.id) return d.company.id;
    if (d?.user?.company_id) return d.user.company_id;
    if (d?.company_id) return d.company_id;

    const segments = path.split("/").filter(Boolean);
    const idx = segments.indexOf("companies");
    if (idx !== -1 && UUID_RE.test(segments[idx + 1] || "")) return segments[idx + 1];

    return null;
}

/** The id of the row a create/update just produced, when the response carries it. */
function resolveEntityId(captured) {
    const d = captured?.data;
    if (!d || typeof d !== "object") return null;
    for (const candidate of [d.id, d.data?.id, d.employee_id, d.user_id]) {
        if (typeof candidate === "string" && UUID_RE.test(candidate)) return candidate;
    }
    return null;
}

const ipOf = (req) =>
    (req.headers["x-forwarded-for"]?.split(",")[0] || req.ip || "").trim() || null;

// ── Middleware ───────────────────────────────────────────────────────────────

const activityLogger = (req, res, next) => {
    if (SKIP_METHODS.has(req.method)) return next();

    const startedAt = Date.now();

    // Express rewrites req.url as it descends into nested routers, so by the time
    // "finish" fires req.path is only the tail (often "/"). Snapshot the real path
    // now — originalUrl is the one field Express leaves alone.
    const fullPath = req.originalUrl.split("?")[0];

    // Capture a tiny slice of the response: needed for the login company context,
    // for created-entity ids, and for the failure message.
    const originalJson = res.json.bind(res);
    res.json = (payload) => {
        try {
            if (payload && typeof payload === "object") {
                res.locals._activity = {
                    success: payload.success,
                    message: payload.message,
                    data: payload.data,
                };
            }
        } catch {
            /* never let capture break the response */
        }
        return originalJson(payload);
    };

    res.on("finish", () => {
        setImmediate(() => {
            record(req, res, startedAt, fullPath).catch((err) =>
                console.error("[ActivityLog] failed to record:", err.message)
            );
        });
    });

    next();
};

async function record(req, res, startedAt, fullPath) {
    let decoded = null;
    const authHeader = req.headers["authorization"];
    if (authHeader?.startsWith("Bearer ")) {
        try {
            decoded = verifyAccessToken(authHeader.split(" ")[1]);
        } catch {
            decoded = null; // expired/invalid — the attempt is still worth recording
        }
    }

    const status_code = res.statusCode;
    const isAuthPath = fullPath.includes("/auth/");

    // Unauthenticated 401s would let anyone flood the table — but failed LOGINS
    // are exactly what an audit trail is for, so those are kept.
    if (!decoded && status_code === 401 && !isAuthPath) return;

    const captured = res.locals?._activity || null;
    const company_id = resolveCompanyId(decoded, captured, fullPath);
    const { action, entity_type, entity_id } = describeAction(req.method, fullPath);

    // The API returns 200 with { success: false } in places, so trust the body first.
    const is_success =
        captured?.success !== undefined
            ? captured.success === true
            : status_code >= 200 && status_code < 400;

    const body = buildBody(req);
    const user = captured?.data?.user;

    await db.query(
        `INSERT INTO activity_logs (
            company_id, user_id, user_company_id, username, actor_name, role,
            action, entity_type, entity_id,
            method, path, status_code, is_success,
            request_body, error_message,
            ip_address, user_agent, duration_ms
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
            company_id,
            decoded?.user_id || user?.user_id || null,
            decoded?.uc_id || null,
            decoded?.username || user?.username || null,
            user ? `${user.first_name} ${user.last_name}` : null,
            decoded?.role != null ? String(decoded.role) : user?.role ?? null,
            action,
            entity_type,
            entity_id || resolveEntityId(captured),
            req.method,
            fullPath,
            status_code,
            is_success,
            body ? JSON.stringify(body) : null,
            is_success ? null : captured?.message || null,
            ipOf(req),
            req.headers["user-agent"] || null,
            Date.now() - startedAt,
        ]
    );
}

module.exports = { activityLogger, describeAction, redact, singularize };
