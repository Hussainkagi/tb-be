/**
 * Agency (B2B sourcing) onboarding and sign-in.
 *
 *   Form:    start ─► email OTP ─► verify ─► setup_token ─► setup ─► session
 *   Google:  google (ID token) ──────────────► setup_token ─► setup ─► session
 *
 * Rules (agreed product decisions):
 *   - One email is one Teambook person. An email already in Teambook is never
 *     duplicated: once ownership is proven (OTP or Google), the agency is
 *     added to that same person as a new workspace with its own password.
 *   - Nothing reveals whether an email exists before it is proven.
 *   - "You already have Teambook" is shown only to someone who ADMINISTERS an
 *     HRMS company. An employee/manager elsewhere is treated as brand new.
 *   - Someone who already owns an agency is simply signed in to it.
 *
 * The setup token is a 30-minute JWT with `typ: agency_setup`; verifyToken
 * rejects every typed token, so it can never open a staff route.
 */
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const db = require("../config/database");
const UserCompanyModel = require("../models/userCompanyModel");
const PlanModel = require("../models/planModel");
const UserCompanyService = require("./userCompanyService");
const { PolicyService } = require("./policyService");
const { hashPassword } = require("../utils/password");
const { sendEmail } = require("../utils/mailer");
const { agencySignupOtpTemplate } = require("../utils/emailTemplates");
const { resolveCountryCode } = require("../utils/countryCodes");
const { verifyGoogleIdToken } = require("../utils/googleIdToken");
const { slugify } = require("./Recruitment/recruitmentShared");
const { Role } = require("../enums/roles");

const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret_key";
const SETUP_TYP = "agency_setup";
const SETUP_TTL = "30m";
const OTP_MINUTES = 10;
const RESEND_AFTER_SECONDS = 30; // matches the resend countdown on the signup page
const MAX_OTP_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Sensible default currency per country; editable later in agency settings.
const CURRENCY_BY_CODE = {
    AE: "AED", IN: "INR", SA: "SAR", QA: "QAR", OM: "OMR", KW: "KWD", BH: "BHD",
    GB: "GBP", US: "USD", PK: "PKR", EG: "EGP", JO: "JOD",
};

const ok = (data, message = "OK", status = 200) => ({ success: true, status, message, data });
const fail = (message, status = 400, extra = {}) => ({ success: false, status, message, ...extra });
const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const newOtp = () => String(crypto.randomInt(100000, 1000000));
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const isAccepted = (v) => v === true || v === "true" || v === 1 || v === "1";

// ── Who is this email in Teambook? ───────────────────────────────────────────

async function findUserByEmail(email) {
    const { rows } = await db.query(
        `SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
        [email],
    );
    return rows[0] || null;
}

async function findUserByGoogleSub(sub) {
    const { rows } = await db.query(`SELECT * FROM users WHERE google_sub = $1 AND deleted_at IS NULL`, [sub]);
    return rows[0] || null;
}

/**
 * The agency this person owns (if any) and the HRMS company they administer
 * (if any). Employee / manager memberships are deliberately ignored.
 */
async function standing(user_id) {
    if (!user_id) return { agencyUsername: null, hrmsAdminOf: null };
    const { rows } = await db.query(
        `SELECT uc.username, uc.role, c.account_type, c.company_name
           FROM user_companies uc
           JOIN companies c ON c.id = uc.company_id
          WHERE uc.user_id = $1
            AND uc.is_active = TRUE AND uc.deleted_at IS NULL
            AND c.deleted_at IS NULL
          ORDER BY uc.created_at`,
        [user_id],
    );
    const admin = String(Role.ADMIN);
    return {
        agencyUsername: rows.find((r) => r.account_type === "agency" && String(r.role) === admin)?.username || null,
        hrmsAdminOf: rows.find((r) => r.account_type === "hrms" && String(r.role) === admin)?.company_name || null,
    };
}

/** What the "already have Teambook" note says — null for everyone but HRMS admins. */
const existingNote = (s) => (s.hrmsAdminOf ? { company_name: s.hrmsAdminOf } : null);

async function signInAs(username, extra = {}) {
    const uc = await UserCompanyModel.findByUsername(username);
    if (!uc) return fail("This agency account is not active", 403);
    const session = await UserCompanyService.issueSession(uc);
    if (!session.success) return session;
    return ok({ next: "signed_in", ...session.data, ...extra }, "Signed in");
}

const setupToken = (claims) => jwt.sign({ typ: SETUP_TYP, ...claims }, JWT_SECRET, { expiresIn: SETUP_TTL });

function readSetupToken(token) {
    try {
        const c = jwt.verify(String(token || ""), JWT_SECRET);
        return c?.typ === SETUP_TYP && c.email ? c : null;
    } catch {
        return null;
    }
}

async function sendOtp(email, first_name, code) {
    await sendEmail({
        to: email,
        subject: `${code} is your teamBook verification code`,
        html: agencySignupOtpTemplate({ first_name, otp: code, expires_minutes: OTP_MINUTES }),
    });
}

async function uniqueSlug(name, client) {
    const base = slugify(name, 60) || "agency";
    for (let i = 0; i < 50; i++) {
        const slug = i === 0 ? base : `${base.slice(0, 56)}-${i + 1}`;
        const { rows } = await client.query(`SELECT 1 FROM recruitment_agencies WHERE slug = $1`, [slug]);
        if (!rows.length) return slug;
    }
    return `${base.slice(0, 50)}-${crypto.randomBytes(3).toString("hex")}`;
}

async function uniqueCompanyCode(client) {
    for (let i = 0; i < 10; i++) {
        const code = `AG${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
        const { rows } = await client.query(`SELECT 1 FROM companies WHERE company_code = $1`, [code]);
        if (!rows.length) return code;
    }
    throw new Error("Could not allocate a company code");
}

// ── Service ──────────────────────────────────────────────────────────────────

const AgencyOnboardingService = {
    /** Step 1 (form): hold the details, email a code. Never says if the email exists. */
    async signupStart(body) {
        const first_name = str(body.first_name, 100);
        const last_name = str(body.last_name, 100);
        const email = str(body.email, 255).toLowerCase();
        const password = String(body.password || "");

        if (!first_name) return fail("Enter your first name");
        if (!EMAIL_RE.test(email)) return fail("Enter a valid email address");
        if (password.length < 8) return fail("Password must be at least 8 characters");

        const { rows: recent } = await db.query(
            `SELECT id FROM agency_signups
              WHERE LOWER(email) = $1 AND completed_at IS NULL
                AND otp_sent_at > NOW() - ($2 || ' seconds')::interval
              LIMIT 1`,
            [email, String(RESEND_AFTER_SECONDS)],
        );
        if (recent.length) return fail("A code was just sent to this email — wait 30 seconds before asking again", 429);

        const code = newOtp();
        // Only one live signup per email; older unfinished ones are dropped.
        await db.query(`DELETE FROM agency_signups WHERE LOWER(email) = $1 AND completed_at IS NULL`, [email]);
        const { rows } = await db.query(
            `INSERT INTO agency_signups (email, first_name, last_name, password_hash, otp_hash, otp_expires_at)
             VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' minutes')::interval)
             RETURNING id`,
            [email, first_name, last_name, await hashPassword(password), sha(code), String(OTP_MINUTES)],
        );
        await sendOtp(email, first_name, code);
        return ok({ signup_id: rows[0].id, email, expires_minutes: OTP_MINUTES }, "We've emailed you a 6-digit code", 201);
    },

    async signupResend(body) {
        const { rows } = await db.query(
            `SELECT * FROM agency_signups WHERE id = $1 AND completed_at IS NULL`,
            [str(body.signup_id, 40) || null],
        );
        const row = rows[0];
        if (!row) return fail("This signup has expired — start again", 404);
        if (row.verified_at) return fail("This email is already verified");
        if (Date.now() - new Date(row.otp_sent_at).getTime() < RESEND_AFTER_SECONDS * 1000) {
            return fail("Wait 30 seconds before asking for another code", 429);
        }
        const code = newOtp();
        await db.query(
            `UPDATE agency_signups
                SET otp_hash = $2, otp_expires_at = NOW() + ($3 || ' minutes')::interval,
                    otp_sent_at = NOW(), attempts = 0
              WHERE id = $1`,
            [row.id, sha(code), String(OTP_MINUTES)],
        );
        await sendOtp(row.email, row.first_name, code);
        return ok({ signup_id: row.id, email: row.email }, "New code sent");
    },

    /** Step 2 (form): check the code. Proven email → setup token (or straight in). */
    async signupVerify(body) {
        const { rows } = await db.query(
            `SELECT * FROM agency_signups WHERE id = $1 AND completed_at IS NULL`,
            [str(body.signup_id, 40) || null],
        );
        const row = rows[0];
        if (!row) return fail("This signup has expired — start again", 404);

        if (!row.verified_at) {
            if (row.attempts >= MAX_OTP_ATTEMPTS) return fail("Too many wrong codes — send a new one", 429);
            if (new Date(row.otp_expires_at).getTime() < Date.now()) return fail("This code has expired — send a new one");
            const code = String(body.otp || "").replace(/\D/g, "");
            if (sha(code) !== row.otp_hash) {
                await db.query(`UPDATE agency_signups SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
                const left = MAX_OTP_ATTEMPTS - row.attempts - 1;
                return fail(left > 0 ? `That code isn't right — ${left} ${left === 1 ? "try" : "tries"} left` : "Too many wrong codes — send a new one");
            }
            await db.query(`UPDATE agency_signups SET verified_at = NOW() WHERE id = $1`, [row.id]);
        }

        const user = await findUserByEmail(row.email);
        const s = await standing(user?.id);
        if (s.agencyUsername) {
            await db.query(`UPDATE agency_signups SET completed_at = NOW() WHERE id = $1`, [row.id]);
            return signInAs(s.agencyUsername, { already_had_agency: true });
        }

        return ok(
            {
                next: "setup",
                setup_token: setupToken({ via: "form", signup_id: row.id, email: row.email, first_name: row.first_name, last_name: row.last_name }),
                profile: { first_name: row.first_name, last_name: row.last_name, email: row.email },
                existing_account: existingNote(s),
            },
            "Email verified",
        );
    },

    /** Continue with Google — signs an agency owner in, or starts setup. */
    async google(body) {
        let g;
        try {
            g = await verifyGoogleIdToken(String(body.credential || ""));
        } catch (error) {
            return fail(error.message === "Google sign-in is not configured" ? error.message : "Google sign-in failed — try again", 401);
        }

        const user = (await findUserByGoogleSub(g.sub)) || (await findUserByEmail(g.email));
        const s = await standing(user?.id);

        if (s.agencyUsername) {
            if (user && !user.google_sub) {
                await db.query(`UPDATE users SET google_sub = $2 WHERE id = $1 AND google_sub IS NULL`, [user.id, g.sub]);
            }
            return signInAs(s.agencyUsername);
        }

        // Google-only path for an email Teambook has never seen, or one that
        // is only an employee somewhere: both go on to set up an agency.
        const profile = {
            first_name: user?.first_name || g.first_name,
            last_name: user?.last_name || g.last_name,
            email: user?.email || g.email,
        };
        return ok(
            {
                next: "setup",
                setup_token: setupToken({ via: "google", google_sub: g.sub, ...profile }),
                profile,
                existing_account: existingNote(s),
            },
            "Google account verified",
        );
    },

    /** Step 3: create the agency workspace for a proven email, then sign in. */
    async setup(body, { ip_address = null, user_agent = null } = {}) {
        const claims = readSetupToken(body.setup_token);
        if (!claims) return fail("Your session expired — please start again", 401);

        const agency_name = str(body.agency_name, 160);
        const country = str(body.country, 100) || null;
        const phone = str(body.phone, 50) || null;
        const timezone = str(body.timezone, 100) || "UTC";
        if (agency_name.length < 2) return fail("Enter your agency's name");
        if (!isAccepted(body.accepted_terms) || !isAccepted(body.accepted_privacy)) {
            return fail("Please accept the Terms and the Privacy Policy", 400, { code: "POLICY_NOT_ACCEPTED" });
        }

        let password_hash = null;
        if (claims.via === "form") {
            const { rows } = await db.query(
                `SELECT * FROM agency_signups WHERE id = $1 AND verified_at IS NOT NULL AND completed_at IS NULL`,
                [claims.signup_id],
            );
            if (!rows[0] || rows[0].email.toLowerCase() !== claims.email.toLowerCase()) {
                return fail("Your session expired — please start again", 401);
            }
            password_hash = rows[0].password_hash;
        }

        const existing = await findUserByEmail(claims.email);
        const before = await standing(existing?.id);
        // Double submit, or a second tab: they already have it — just sign in.
        if (before.agencyUsername) return signInAs(before.agencyUsername, { already_had_agency: true });

        const plan = await PlanModel.findSignupPlan();
        const planExpiresAt = plan?.duration_days ? new Date(Date.now() + plan.duration_days * 86400000) : null;
        const country_code = resolveCountryCode(country);
        const currency = CURRENCY_BY_CODE[country_code] || "USD";

        const client = await db.getClient();
        let user_id;
        let username;
        let company_id;
        try {
            await client.query("BEGIN");

            if (existing) {
                user_id = existing.id;
                if (claims.google_sub && !existing.google_sub) {
                    await client.query(`UPDATE users SET google_sub = $2 WHERE id = $1 AND google_sub IS NULL`, [user_id, claims.google_sub]);
                }
            } else {
                const { rows } = await client.query(
                    `INSERT INTO users (first_name, last_name, email, phone, google_sub)
                     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
                    [claims.first_name || "Agency", claims.last_name || "", claims.email, phone, claims.google_sub || null],
                );
                user_id = rows[0].id;
            }

            const { rows: company } = await client.query(
                `INSERT INTO companies (company_name, company_code, email, phone, country, country_code,
                                        timezone, currency, plan, plan_id, plan_expires_at, account_type)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'agency') RETURNING id`,
                [
                    agency_name, await uniqueCompanyCode(client), claims.email, phone, country, country_code,
                    timezone, currency, plan?.code || "trial", plan?.id || null, planExpiresAt,
                ],
            );
            company_id = company[0].id;

            username = await UserCompanyService.nextUsername();
            await client.query(
                `INSERT INTO user_companies (user_id, company_id, username, password_hash, role, is_invited)
                 VALUES ($1, $2, $3, $4, $5, FALSE)`,
                [user_id, company_id, username, password_hash, String(Role.ADMIN)],
            );

            await client.query(
                `INSERT INTO recruitment_agencies (company_id, display_name, slug, contact_email, contact_phone)
                 VALUES ($1, $2, $3, $4, $5)`,
                [company_id, agency_name, await uniqueSlug(agency_name, client), claims.email, phone],
            );

            if (claims.via === "form") {
                await client.query(`UPDATE agency_signups SET completed_at = NOW() WHERE id = $1`, [claims.signup_id]);
            }

            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK").catch(() => undefined);
            throw error;
        } finally {
            client.release();
        }

        // Same as HRMS registration: consent is recorded, but a country with no
        // published policy must not block a signup.
        try {
            await PolicyService.recordRegistrationAcceptance({
                company_id,
                country,
                accepted_by_user_id: user_id,
                accepted_by_name: `${claims.first_name || ""} ${claims.last_name || ""}`.trim(),
                accepted_by_email: claims.email,
                ip_address,
                user_agent,
                acceptance_context: "registration",
            });
        } catch (error) {
            console.error(`[AgencySignup] Policy acceptance not recorded for ${company_id}:`, error.message);
        }

        const session = await signInAs(username, { existing_account: existingNote(before) });
        if (session.success) {
            session.status = 201;
            session.message = "Your agency is ready";
        }
        return session;
    },

    /** Agency sign-in with email + password (Google has its own endpoint). */
    async login(body) {
        const email = str(body.email, 255).toLowerCase();
        const password = String(body.password || "");
        const invalid = fail("Wrong email or password. Signed up with Google? Use Continue with Google.", 401);
        if (!EMAIL_RE.test(email) || !password) return invalid;

        const user = await findUserByEmail(email);
        const s = await standing(user?.id);
        if (!s.agencyUsername) return invalid;

        const check = await UserCompanyService.checkCredentials(s.agencyUsername, password);
        if (!check.success) {
            if (check.code === "PASSWORD_NOT_SET") return invalid;
            return fail(check.code === "INVALID" ? invalid.message : check.message, 401);
        }
        return signInAs(s.agencyUsername);
    },
};

module.exports = AgencyOnboardingService;
