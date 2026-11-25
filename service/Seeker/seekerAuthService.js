/**
 * Job seeker sign-up / sign-in for the public job board.
 *
 *   Sign up:  first name, last name, email → 6-digit email code → account
 *   Sign in:  email → 6-digit email code
 *   Google:   one tap; creates the account the first time
 *
 * No passwords. The session is a JWT with typ "job_seeker" — verifyToken
 * refuses any typed token, so it can never reach a staff route.
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const db = require("../../config/database");
const { sendEmail } = require("../../utils/mailer");
const { jobSeekerCodeTemplate } = require("../../utils/emailTemplates");
const { verifyGoogleIdToken } = require("../../utils/googleIdToken");

const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret_key";
const TOKEN_TYPE = "job_seeker";
const SESSION_TTL = "30d";
const CODE_MINUTES = 10;
const RESEND_SECONDS = 30;
const MAX_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const ok = (data, message = "OK", status = 200) => ({ success: true, status, message, data });
const fail = (message, status = 400) => ({ success: false, status, message });
const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const str = (v, max) => String(v ?? "").trim().slice(0, max);

/** The shape every screen reads; never includes google_sub. */
function publicSeeker(row) {
    if (!row) return null;
    return {
        id: row.id,
        email: row.email,
        first_name: row.first_name,
        last_name: row.last_name,
        has_profile: Boolean(row.profile_filled_at),
    };
}

function session(row) {
    const token = jwt.sign({ typ: TOKEN_TYPE, seeker_id: row.id }, JWT_SECRET, { expiresIn: SESSION_TTL });
    return { token, seeker: publicSeeker(row) };
}

async function findByEmail(email) {
    const { rows } = await db.query(`SELECT * FROM job_seekers WHERE LOWER(email) = LOWER($1)`, [email]);
    return rows[0] || null;
}

async function touchLogin(id) {
    const { rows } = await db.query(`UPDATE job_seekers SET last_login_at = NOW() WHERE id = $1 RETURNING *`, [id]);
    return rows[0];
}

const SeekerAuthService = {
    TOKEN_TYPE,

    /** Verify a session token → seeker id, or null. */
    readToken(token) {
        try {
            const c = jwt.verify(String(token || ""), JWT_SECRET);
            return c?.typ === TOKEN_TYPE && c.seeker_id ? c.seeker_id : null;
        } catch {
            return null;
        }
    },

    /** Send a code. purpose = "signup" (needs names) or "login". */
    async start(body = {}) {
        const purpose = body.purpose === "signup" ? "signup" : "login";
        const email = str(body.email, 255).toLowerCase();
        if (!EMAIL_RE.test(email)) return fail("Enter a valid email address");

        let first_name = str(body.first_name, 100);
        let last_name = str(body.last_name, 100);
        const existing = await findByEmail(email);

        if (purpose === "signup") {
            if (!first_name) return fail("Enter your first name");
        } else if (!existing) {
            return fail("No account uses this email yet — create one instead", 404);
        } else {
            first_name = existing.first_name;
        }

        const { rows: recent } = await db.query(
            `SELECT 1 FROM job_seeker_codes
              WHERE LOWER(email) = $1 AND used_at IS NULL AND sent_at > NOW() - ($2 || ' seconds')::interval LIMIT 1`,
            [email, String(RESEND_SECONDS)],
        );
        if (recent.length) return fail(`A code was just sent — wait ${RESEND_SECONDS} seconds before asking again`, 429);

        const code = String(crypto.randomInt(100000, 1000000));
        const { rows } = await db.query(
            `INSERT INTO job_seeker_codes (email, purpose, first_name, last_name, code_hash, expires_at)
             VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' minutes')::interval) RETURNING id`,
            [email, purpose, first_name || null, last_name || null, sha(code), String(CODE_MINUTES)],
        );
        await sendEmail({
            to: email,
            subject: `${code} is your teamBook Jobs code`,
            html: jobSeekerCodeTemplate({ first_name, otp: code, purpose, expires_minutes: CODE_MINUTES }),
        });
        return ok({ request_id: rows[0].id, email, expires_minutes: CODE_MINUTES }, "We've emailed you a 6-digit code", 201);
    },

    /** Check the code → signed in (creating the account on sign-up). */
    async verify(body = {}) {
        const { rows } = await db.query(`SELECT * FROM job_seeker_codes WHERE id = $1 AND used_at IS NULL`, [str(body.request_id, 40) || null]);
        const req = rows[0];
        if (!req) return fail("This code has expired — ask for a new one", 404);
        if (req.attempts >= MAX_ATTEMPTS) return fail("Too many wrong codes — ask for a new one", 429);
        if (new Date(req.expires_at) < new Date()) return fail("This code has expired — ask for a new one");

        if (sha(String(body.code || "").replace(/\D/g, "")) !== req.code_hash) {
            await db.query(`UPDATE job_seeker_codes SET attempts = attempts + 1 WHERE id = $1`, [req.id]);
            const left = MAX_ATTEMPTS - req.attempts - 1;
            return fail(left > 0 ? `That code isn't right — ${left} ${left === 1 ? "try" : "tries"} left` : "Too many wrong codes — ask for a new one");
        }
        await db.query(`UPDATE job_seeker_codes SET used_at = NOW() WHERE id = $1`, [req.id]);

        let seeker = await findByEmail(req.email);
        if (!seeker) {
            // Signing up (or a sign-in that raced a delete): create the account now.
            const ins = await db.query(
                `INSERT INTO job_seekers (email, first_name, last_name) VALUES ($1, $2, $3)
                 ON CONFLICT (LOWER(email)) DO UPDATE SET email = EXCLUDED.email RETURNING *`,
                [req.email, req.first_name || req.email.split("@")[0], req.last_name || ""],
            );
            seeker = ins.rows[0];
        }
        seeker = await touchLogin(seeker.id);
        return ok(session(seeker), seeker.created_at > new Date(Date.now() - 60_000) ? "Account created" : "Signed in");
    },

    async google(body = {}) {
        let g;
        try {
            g = await verifyGoogleIdToken(String(body.credential || ""));
        } catch (error) {
            return fail(error.message === "Google sign-in is not configured" ? error.message : "Google sign-in failed — try again", 401);
        }
        const bySub = (await db.query(`SELECT * FROM job_seekers WHERE google_sub = $1`, [g.sub])).rows[0];
        let seeker = bySub || (await findByEmail(g.email));
        if (!seeker) {
            const ins = await db.query(
                `INSERT INTO job_seekers (email, first_name, last_name, google_sub) VALUES ($1, $2, $3, $4) RETURNING *`,
                [g.email, g.first_name, g.last_name, g.sub],
            );
            seeker = ins.rows[0];
        } else if (!seeker.google_sub) {
            await db.query(`UPDATE job_seekers SET google_sub = $2 WHERE id = $1 AND google_sub IS NULL`, [seeker.id, g.sub]);
        }
        seeker = await touchLogin(seeker.id);
        return ok(session(seeker), "Signed in");
    },

    publicSeeker,
};

module.exports = SeekerAuthService;
