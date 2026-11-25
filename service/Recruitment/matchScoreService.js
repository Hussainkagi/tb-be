/**
 * Scores an application out of 10 against its job — once, when it's submitted.
 *
 *   job side:       the hidden match profile saved from the job description
 *                   (recruitment_job_profiles) plus the job's own fields
 *   candidate side: what was read from the CV they applied with (falls back
 *                   to their saved profile)
 *
 * Gemini does the judging; if it isn't configured or fails, a simple
 * rule-based score (skills, experience, location, education) is used so every
 * application still gets a number. Stored on the application, agency-only.
 */
const db = require("../../config/database");
const { generateJson, geminiConfigured, geminiModel } = require("../../utils/gemini");

const SCHEMA = {
    type: "OBJECT",
    properties: {
        score: { type: "NUMBER", description: "Overall fit for this job, 0 to 10, one decimal" },
        summary: { type: "STRING", description: "One sentence on why, for a recruiter" },
        strengths: { type: "ARRAY", items: { type: "STRING" }, description: "Up to 4 short points that match" },
        gaps: { type: "ARRAY", items: { type: "STRING" }, description: "Up to 4 short points that are missing or weak" },
    },
    required: ["score", "summary", "strengths", "gaps"],
};

const SYSTEM = `You screen job applications for a recruitment agency.
Compare the CANDIDATE with the JOB and rate how well they fit, from 0 to 10:
- 9–10: meets every must-have and most nice-to-haves, right seniority
- 7–8: meets the must-haves, minor gaps
- 5–6: partly fits; some must-haves missing or seniority off
- 3–4: weak fit
- 0–2: unrelated
Weigh must-have skills and relevant experience most, then seniority/years, domain, location/visa, education, languages.
Judge only on job-related facts. Never use age, gender, nationality, religion or marital status.
Be strict and consistent. Keep points short (max ~8 words each).`;

const lower = (a) => (Array.isArray(a) ? a : []).map((s) => String(s).toLowerCase().trim()).filter(Boolean);
const clamp = (n) => Math.max(0, Math.min(10, Math.round(Number(n) * 10) / 10));

/** Only job-relevant candidate facts go to the model (no age/gender/nationality). */
function candidateFacts(c = {}) {
    return {
        headline: c.headline || null,
        current_company: c.current_company || null,
        total_experience_years: c.total_experience_years ?? null,
        location: [c.city, c.country].filter(Boolean).join(", ") || null,
        skills: c.skills || [],
        languages: c.languages || [],
        certifications: c.certifications || [],
        experience: (c.experience || []).slice(0, 8),
        education: (c.education || []).slice(0, 4),
        summary: c.summary || null,
    };
}

function jobFacts(job, profile) {
    return {
        title: job.title,
        sector: job.sector,
        employment_type: job.employment_type,
        work_mode: job.work_mode,
        location: [job.location_city, job.location_country].filter(Boolean).join(", ") || null,
        experience_years: { min: job.experience_min, max: job.experience_max },
        education: job.education,
        skills: job.skills || [],
        requirements: (job.requirements || "").slice(0, 3000),
        responsibilities: (job.responsibilities || "").slice(0, 2000),
        match_profile: profile || null,
    };
}

/** Rule-based fallback: skills 50%, experience 25%, location 15%, education 10%. */
function ruleScore(job, profile, c) {
    const want = new Set([...lower(profile?.must_have_skills), ...lower(job.skills)]);
    const nice = new Set(lower(profile?.nice_to_have_skills));
    const have = lower([...(c.skills || []), ...(c.certifications || [])]);
    const has = (s) => have.some((h) => h === s || h.includes(s) || s.includes(h));

    const wantHit = [...want].filter(has);
    const niceHit = [...nice].filter(has);
    const skills = want.size ? wantHit.length / want.size : niceHit.length ? 0.7 : 0.5;
    const bonus = nice.size ? (niceHit.length / nice.size) * 0.15 : 0;

    const min = Number(job.experience_min ?? profile?.min_years_experience ?? 0) || 0;
    const yrs = Number(c.total_experience_years);
    const exp = !Number.isFinite(yrs) ? 0.5 : min === 0 ? 1 : Math.min(1, yrs / min);

    const where = lower([job.location_city, job.location_country]);
    const cand = lower([c.city, c.country]).join(" ");
    const loc = !where.length || !cand ? 0.6 : where.some((w) => cand.includes(w)) ? 1 : 0.3;

    const edu = job.education ? ((c.education || []).length ? 0.8 : 0.3) : 1;

    const score = clamp(10 * Math.min(1, 0.5 * skills + bonus + 0.25 * exp + 0.15 * loc + 0.1 * edu));
    const missing = [...want].filter((s) => !has(s)).slice(0, 4);
    return {
        score,
        summary: `${wantHit.length} of ${want.size || 0} key skills, ${Number.isFinite(yrs) ? `${yrs} yrs` : "unknown"} experience.`,
        strengths: wantHit.slice(0, 4).map((s) => `Has ${s}`),
        gaps: missing.map((s) => `No ${s}`),
        method: "rules",
    };
}

const MatchScoreService = {
    /** Fire-and-forget from the apply flow — never throws. */
    async scoreApplication(application_id, candidate) {
        try {
            const { rows } = await db.query(
                `SELECT j.*, p.profile AS match_profile
                   FROM recruitment_applications a
                   JOIN recruitment_jobs j ON j.id = a.job_id
                   LEFT JOIN recruitment_job_profiles p ON p.job_id = j.id
                  WHERE a.id = $1`,
                [application_id],
            );
            const job = rows[0];
            if (!job || !candidate) return null;

            let result = null;
            if (geminiConfigured()) {
                try {
                    const out = await generateJson({
                        system: SYSTEM,
                        parts: [{ text: `JOB:\n${JSON.stringify(jobFacts(job, job.match_profile))}\n\nCANDIDATE:\n${JSON.stringify(candidateFacts(candidate))}` }],
                        schema: SCHEMA,
                        temperature: 0,
                    });
                    if (out && Number.isFinite(Number(out.score))) {
                        result = {
                            score: clamp(out.score),
                            summary: String(out.summary || "").slice(0, 400),
                            strengths: (out.strengths || []).slice(0, 4).map((s) => String(s).slice(0, 120)),
                            gaps: (out.gaps || []).slice(0, 4).map((s) => String(s).slice(0, 120)),
                            method: geminiModel(),
                        };
                    }
                } catch (error) {
                    console.warn("Match scoring fell back to rules:", error.message);
                }
            }
            if (!result) result = ruleScore(job, job.match_profile, candidate);

            await db.query(
                `UPDATE recruitment_applications
                    SET match_score = $2, match_summary = $3, match_details = $4, match_scored_at = NOW()
                  WHERE id = $1`,
                [application_id, result.score, result.summary, { strengths: result.strengths, gaps: result.gaps, method: result.method }],
            );
            return result;
        } catch (error) {
            console.warn("Match scoring failed:", error.message);
            return null;
        }
    },

    /** Top N scored applications for a job (agency view). */
    async topForJob(agency_company_id, job_id, limit = 3) {
        const { rows } = await db.query(
            `SELECT a.id, a.stage, a.created_at, a.match_score, a.match_summary, a.match_details,
                    cd.full_name, cd.email, cd.current_location
               FROM recruitment_applications a
               JOIN recruitment_candidates cd ON cd.id = a.candidate_id
              WHERE a.agency_company_id = $1 AND a.job_id = $2 AND a.match_score IS NOT NULL
              ORDER BY a.match_score DESC, a.created_at ASC
              LIMIT $3`,
            [agency_company_id, job_id, limit],
        );
        return rows;
    },
};

module.exports = MatchScoreService;
