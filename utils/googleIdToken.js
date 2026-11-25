/**
 * Verifies a Google Sign-In ID token (the `credential` the "Continue with
 * Google" button hands the browser) without any extra package: Google
 * publishes its signing certificates as PEM, which jsonwebtoken checks.
 *
 * Env: GOOGLE_CLIENT_ID — the OAuth Web client id. Comma-separate several if
 * more than one client (web, mobile) may sign people in.
 */
const jwt = require("jsonwebtoken");

const CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs";
const ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

let certs = { at: 0, ttl: 0, keys: null };

async function signingKeys(forceRefresh = false) {
    if (!forceRefresh && certs.keys && Date.now() - certs.at < certs.ttl) return certs.keys;
    const res = await fetch(CERTS_URL);
    if (!res.ok) throw new Error(`Google certificates unavailable (${res.status})`);
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("cache-control") || "")?.[1] || 3600);
    certs = { at: Date.now(), ttl: maxAge * 1000, keys: await res.json() };
    return certs.keys;
}

const clientIds = () =>
    String(process.env.GOOGLE_CLIENT_ID || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

const isGoogleConfigured = () => clientIds().length > 0;

/**
 * @returns {Promise<{ sub, email, first_name, last_name, picture }>}
 * @throws when the token is forged, expired, for another app, or the email
 *         is not verified by Google.
 */
async function verifyGoogleIdToken(credential) {
    const audience = clientIds();
    if (!audience.length) throw new Error("Google sign-in is not configured");

    const header = jwt.decode(credential, { complete: true })?.header;
    if (!header?.kid) throw new Error("Malformed Google token");

    let keys = await signingKeys();
    // Google rotates keys; an unknown kid means our copy is stale.
    if (!keys[header.kid]) keys = await signingKeys(true);
    const pem = keys[header.kid];
    if (!pem) throw new Error("Unknown Google signing key");

    const claims = jwt.verify(credential, pem, {
        algorithms: ["RS256"],
        audience,
        issuer: ISSUERS,
    });

    if (!claims.email || claims.email_verified !== true) {
        throw new Error("Google hasn't verified this email address");
    }

    const [first, ...rest] = String(claims.name || "").trim().split(/\s+/);
    return {
        sub: String(claims.sub),
        email: String(claims.email).toLowerCase(),
        first_name: (claims.given_name || first || claims.email.split("@")[0]).slice(0, 100),
        last_name: (claims.family_name || rest.join(" ") || "").slice(0, 100),
        picture: claims.picture || null,
    };
}

module.exports = { verifyGoogleIdToken, isGoogleConfigured };
