/**
 * "Best matches" for an agency's job: job seekers on the board whose profile
 * fits, and inviting them to apply by email.
 *
 * Only finished profiles (onboarded, with a photo) whose owner left
 * "Let recruiters invite me" on are in the pool, and people who already
 * applied to the job are left out. Matching runs on each profile's meta
 * (job_seekers.profile_meta — see Seeker/profileMetaService):
 *
 *   skills 40 · title 20 · sector 15 · experience 15 · location 10   → score out of 10
 *
 * Rules only — instant and free, so the list can be opened as often as needed.
 * Contact details are never shown to the agency; the invite goes out by email
 * from teamBook and the person applies through the board like anyone else.
 */
const db = require("../../config/database");
const JobModel = require("../../models/Recruitment/jobModel");
const { sendEmail } = require("../../utils/mailer");
const { jobInviteTemplate } = require("../../utils/emailTemplates");
const { jobsUrl } = require("../../utils/portalUrls");

const ok = (data, message = "OK", status = 200) => ({ success: true, status, message, data });
const fail = (message, status = 400) => ({ success: false, status, message });

const POOL_LIMIT = 600; // candidates scored per request (pre-filtered in SQL)
const SHOW = 12; // matches returned
const MIN_SCORE = 3; // below this isn't a "match"

const lower = (a) => [...new Set((Array.isArray(a) ? a : []).map((s) => String(s).toLowerCase().trim()).filter(Boolean))];
const words = (s) => String(s || "").toLowerCase().split(/[^a-z0-9+#.]+/).filter((w) => w.length > 2 && !STOP.has(w));
const STOP = new Set(["and", "the", "for", "with", "senior", "junior", "lead", "head", "manager", "assistant", "officer", "executive", "specialist"]);
const round1 = (n) => Math.round(n * 10) / 10;

/** The job's side of the comparison. */
function jobWants(job, profile) {
    const must = lower([...(profile?.must_have_skills || []), ...(job.skills || [])]);
    const nice = lower([...(profile?.nice_to_have_skills || []), ...(profile?.keywords || [])]).filter((s) => !must.includes(s));
    return {
        must,
        nice,
        titleWords: new Set(words(job.title)),
        sector: job.sector || null,
        min: Number(job.experience_min ?? profile?.min_years_experience ?? 0) || 0,
        max: Number(job.experience_max ?? profile?.max_years_experience) || null,
        city: job.location_city ? String(job.location_city).toLowerCase() : null,
        country: job.location_country ? String(job.location_country).toLowerCase() : null,
        remote: job.work_mode === "remote",
    };
}

/** "Month-end closing" and "month-end close" are the same skill: compare word stems. */
const stem = (s) => String(s).toLowerCase().split(/\s+/).map((w) => (w.length > 4 ? w.replace(/(ings|ing|ed|es|s|e)$/, "") : w)).join(" ");
const skillHit = (have, s) => {
    const t = stem(s);
    return have.some((h) => {
        const g = stem(h);
        return g === t || (t.length > 3 && (g.includes(t) || t.includes(g)));
    });
};

/** Score one profile. Returns null when there's nothing to go on. */
function scoreOne(want, meta) {
    if (!meta) return null;
    const have = meta.skills || [];

    // Skills: must-haves count fully, nice-to-haves add a little.
    const mustHit = want.must.filter((s) => skillHit(have, s));
    const niceHit = want.nice.filter((s) => skillHit(have, s));
    const skills = want.must.length
        ? Math.min(1, mustHit.length / want.must.length + (want.nice.length ? (niceHit.length / want.nice.length) * 0.2 : 0))
        : want.nice.length
          ? niceHit.length / want.nice.length
          : 0.5;

    // Title: share of the job title's words found in their titles.
    const theirWords = new Set((meta.titles || []).flatMap(words));
    const tw = [...want.titleWords];
    const title = tw.length ? tw.filter((w) => theirWords.has(w)).length / tw.length : 0.5;

    const sector = !want.sector ? 0.5 : (meta.sectors || []).includes(want.sector) ? 1 : 0;

    // Experience: full marks inside the range, tapering outside it.
    const yrs = Number(meta.years);
    let exp = 0.5;
    if (Number.isFinite(yrs)) {
        if (yrs < want.min) exp = Math.max(0, 1 - (want.min - yrs) / Math.max(2, want.min));
        else if (want.max && yrs > want.max + 3) exp = 0.6; // likely over-qualified
        else exp = 1;
    }

    let loc = 0.5;
    if (want.remote) loc = 1;
    else if (want.city && meta.city && meta.city.includes(want.city)) loc = 1;
    else if (want.country && meta.country && (meta.country.includes(want.country) || want.country.includes(meta.country))) loc = 0.8;
    else if (meta.city || meta.country) loc = 0.2;

    const score = round1(10 * (0.4 * skills + 0.2 * title + 0.15 * sector + 0.15 * exp + 0.1 * loc));

    const reasons = [];
    if (mustHit.length) reasons.push(`${mustHit.length} of ${want.must.length} key skills`);
    if (title >= 0.5 && tw.length) reasons.push("Similar job title");
    if (sector === 1) reasons.push(`Works in ${want.sector}`);
    if (Number.isFinite(yrs) && exp === 1) reasons.push(`${yrs} yrs experience`);
    if (loc === 1 && !want.remote) reasons.push("Same city");

    const gaps = [];
    const missing = want.must.filter((s) => !mustHit.includes(s)).slice(0, 3);
    if (missing.length) gaps.push(`Missing ${missing.join(", ")}`);
    if (Number.isFinite(yrs) && yrs < want.min) gaps.push(`${yrs} of ${want.min}+ yrs`);
    if (loc <= 0.2) gaps.push("Different location");

    return { score, reasons: reasons.slice(0, 4), gaps: gaps.slice(0, 3), matched: [...mustHit, ...niceHit] };
}

const TalentMatchService = {
    /** Best-matching profiles for one of the agency's jobs. */
    async forJob(company_id, job_id) {
        const job = await JobModel.findForAgency(job_id, company_id);
        if (!job) return fail("Job not found", 404);
        const { rows: prof } = await db.query(`SELECT profile FROM recruitment_job_profiles WHERE job_id = $1`, [job_id]);
        const want = jobWants(job, prof[0]?.profile);

        // Pre-filter in SQL: same sector, or any wanted skill. With neither, the newest profiles.
        const terms = [...want.must, ...want.nice].slice(0, 60);
        const params = [job_id, POOL_LIMIT];
        let where = "";
        if (want.sector || terms.length) {
            const ors = [];
            if (want.sector) {
                params.push(JSON.stringify([want.sector]));
                ors.push(`s.profile_meta -> 'sectors' @> $${params.length}::jsonb`);
            }
            if (terms.length) {
                params.push(terms);
                ors.push(`s.profile_meta -> 'skills' ?| $${params.length}::text[]`);
            }
            where = `AND (${ors.join(" OR ")})`;
        }
        const { rows } = await db.query(
            `SELECT s.id, s.first_name, s.last_name, s.photo_ref, s.headline, s.current_company,
                    s.total_experience_years, s.city, s.country, s.skills, s.profile_meta,
                    i.created_at AS invited_at
               FROM job_seekers s
               LEFT JOIN recruitment_job_invites i ON i.job_id = $1 AND i.seeker_id = s.id
              WHERE s.onboarded_at IS NOT NULL AND s.open_to_invites AND s.photo_ref IS NOT NULL
                AND s.profile_meta IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM recruitment_applications a WHERE a.job_id = $1 AND a.seeker_id = s.id)
                ${where}
              ORDER BY s.onboarded_at DESC
              LIMIT $2`,
            params,
        );

        const matches = rows
            .map((r) => ({ r, m: scoreOne(want, r.profile_meta) }))
            .filter(({ m }) => m && m.score >= MIN_SCORE)
            .sort((a, b) => b.m.score - a.m.score)
            .slice(0, SHOW)
            .map(({ r, m }) => {
                const matched = new Set(m.matched);
                const skills = (r.skills?.length ? r.skills : r.profile_meta.skills || []).slice(0, 12);
                return {
                    seeker_id: r.id,
                    name: `${r.first_name} ${r.last_name}`.trim(),
                    photo_url: r.photo_ref,
                    headline: r.headline,
                    current_company: r.current_company,
                    years: r.total_experience_years == null ? null : Number(r.total_experience_years),
                    location: [r.city, r.country].filter(Boolean).join(", ") || null,
                    skills: skills
                        .map((s) => ({ name: s, matched: [...matched].some((x) => skillHit([String(s).toLowerCase()], x)) }))
                        .sort((a, b) => Number(b.matched) - Number(a.matched))
                        .slice(0, 8),
                    score: m.score,
                    reasons: m.reasons,
                    gaps: m.gaps,
                    invited_at: r.invited_at,
                };
            });

        const { rows: pool } = await db.query(
            `SELECT COUNT(*)::int n FROM job_seekers WHERE onboarded_at IS NOT NULL AND open_to_invites AND photo_ref IS NOT NULL`,
        );
        return ok({ matches, pool_size: pool[0].n, job_open: job.status === "open" });
    },

    /** Email one profile an invitation to apply. Once per person per job. */
    async invite(company_id, user_id, job_id, body = {}) {
        const job = await JobModel.findForAgency(job_id, company_id);
        if (!job) return fail("Job not found", 404);
        if (job.status !== "open") return fail("Open the job first — people can only apply to open jobs", 422);

        const seeker_id = String(body.seeker_id || "");
        const { rows } = await db.query(
            `SELECT id, email, first_name, open_to_invites, onboarded_at FROM job_seekers WHERE id = $1`,
            [seeker_id],
        );
        const s = rows[0];
        if (!s || !s.onboarded_at || !s.open_to_invites) return fail("This person can't be invited", 404);
        const { rows: applied } = await db.query(`SELECT 1 FROM recruitment_applications WHERE job_id = $1 AND seeker_id = $2`, [job_id, seeker_id]);
        if (applied.length) return fail("They've already applied to this job", 409);

        const message = body.message ? String(body.message).trim().slice(0, 600) : null;
        const score = Number.isFinite(Number(body.score)) ? round1(Math.max(0, Math.min(10, Number(body.score)))) : null;
        const { rows: ins } = await db.query(
            `INSERT INTO recruitment_job_invites (job_id, seeker_id, agency_company_id, invited_by, message, match_score)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (job_id, seeker_id) DO NOTHING
             RETURNING id, created_at`,
            [job_id, seeker_id, company_id, user_id || null, message, score],
        );
        if (!ins.length) return fail("Already invited to this job", 409);

        const { rows: ag } = await db.query(`SELECT display_name, contact_email FROM recruitment_agencies WHERE company_id = $1`, [company_id]);
        const agency = ag[0] || {};
        const jobUrl = `${jobsUrl()}/jobs/${job.slug}?ref=invite`;
        sendEmail({
            to: s.email,
            subject: `${agency.display_name || "A recruiter"} invited you to apply — ${job.title}`,
            fromName: agency.display_name ? `${agency.display_name} via teamBook` : undefined,
            replyTo: agency.contact_email || undefined,
            html: jobInviteTemplate({
                first_name: s.first_name,
                agency_name: agency.display_name,
                job_title: job.title,
                hiring_name: job.show_company ? job.client_name : null,
                location: [job.location_city, job.location_country].filter(Boolean).join(", "),
                message,
                job_url: jobUrl,
            }),
        }).catch((error) => console.warn("Invite email failed:", error.message));

        return ok({ seeker_id, invited_at: ins[0].created_at }, "Invite sent");
    },
};

module.exports = TalentMatchService;
