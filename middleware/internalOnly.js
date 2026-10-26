// middleware/internalOnly.js
// Guards /internal routes, which other Ikration apps on the same server call
// (e.g. TrackyDesk checking a Teambook login). Requires the shared secret in
// x-internal-secret and, unless INTERNAL_API_ALLOW_REMOTE=true, a loopback caller.
const crypto = require("crypto");

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const sameSecret = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const internalOnly = (req, res, next) => {
    const secret = process.env.INTERNAL_API_SECRET;
    // Off unless configured: no secret means no internal API at all.
    if (!secret || secret.length < 32) {
        return res.status(404).json({ success: false, message: "Not found" });
    }
    if (process.env.INTERNAL_API_ALLOW_REMOTE !== "true" && !LOOPBACK.has(req.socket.remoteAddress)) {
        return res.status(403).json({ success: false, message: "Forbidden" });
    }
    if (!sameSecret(req.headers["x-internal-secret"] || "", secret)) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    next();
};

module.exports = internalOnly;
