/**
 * The "profile meta" of a job seeker: a compact, normalised summary of their
 * profile that agencies' job matching runs on (job_seekers.profile_meta).
 *
 *   sectors      1–3 of the job board's sectors (same list as the job editor)
 *   titles       job titles they hold / target, lower-case
 *   skills       normalised skills, lower-case
 *   seniority    entry | junior | mid | senior | lead | executive
 *   years        total experience
 *   city, country, languages, education_level
 *
 * Gemini classifies sectors / seniority and tidies skills and titles; without
 * it (or if it fails) simple keyword rules fill the same shape. Rebuilt in the
 * background whenever the profile changes — never blocks a request.
 */
const db = require("../../config/database");
const { generateJson, geminiConfigured } = require("../../utils/gemini");

// Keep in sync with SECTORS in the job editor (components/recruitment/JobEditor.tsx).
const SECTORS = [
    "Accounting & Finance", "Administration", "Banking", "Construction", "Customer Service", "Education",
    "Engineering", "Healthcare", "Hospitality", "Human Resources", "IT & Software", "Legal", "Logistics",
    "Manufacturing", "Marketing", "Oil & Gas", "Real Estate", "Retail", "Sales", "Security", "Transport",
];
const SENIORITY = ["entry", "junior", "mid", "senior", "lead", "executive"];

// Fallback sector detection — words in titles / skills / summary.
const SECTOR_WORDS = {
    "Accounting & Finance": ["account", "finance", "audit", "tax", "vat", "ifrs", "bookkeep", "payable", "receivable", "treasury", "cfo", "controller"],
    Administration: ["admin", "secretary", "office manager", "receptionist", "executive assistant", "data entry", "clerk"],
    Banking: ["bank", "credit", "loan", "teller", "relationship manager", "wealth", "aml", "kyc"],
    Construction: ["construction", "site engineer", "civil", "quantity surveyor", "foreman", "mep", "architect"],
    "Customer Service": ["customer service", "call center", "call centre", "customer support", "helpdesk", "customer care"],
    Education: ["teacher", "tutor", "lecturer", "school", "education", "curriculum", "teaching"],
    Engineering: ["engineer", "mechanical", "electrical", "maintenance", "autocad", "hvac"],
    Healthcare: ["nurse", "doctor", "physician", "pharmac", "medical", "clinic", "hospital", "dental", "healthcare"],
    Hospitality: ["hotel", "chef", "cook", "waiter", "barista", "restaurant", "hospitality", "housekeeping", "front desk"],
    "Human Resources": ["human resources", "hr ", "recruit", "talent acquisition", "payroll", "onboarding"],
    "IT & Software": ["developer", "software", "programmer", "devops", "react", "javascript", "python", "java", "sql", "it support", "network", "cloud", "data analyst"],
    Legal: ["legal", "lawyer", "paralegal", "attorney", "counsel", "compliance"],
    Logistics: ["logistic", "warehouse", "supply chain", "procurement", "inventory", "shipping", "freight", "storekeeper"],
    Manufacturing: ["manufactur", "production", "factory", "quality control", "machine operator", "plant"],
    Marketing: ["marketing", "seo", "social media", "brand", "content", "digital marketing", "campaign"],
    "Oil & Gas": ["oil", "gas", "petroleum", "drilling", "offshore", "refinery"],
    "Real Estate": ["real estate", "property", "leasing", "broker", "facility"],
    Retail: ["retail", "store", "cashier", "merchandis", "sales associate", "shop"],
    Sales: ["sales", "business development", "account executive", "account manager", "telesales"],
    Security: ["security", "guard", "cctv", "safety officer"],
    Transport: ["driver", "transport", "delivery", "fleet", "chauffeur", "bus"],
};

const SCHEMA = {
    type: "OBJECT",
    properties: {
        sectors: { type: "ARRAY", items: { type: "STRING", enum: SECTORS }, description: "1 to 3 sectors this person would be hired in, best first" },
        titles: { type: "ARRAY", items: { type: "STRING" }, description: "Up to 6 job titles they hold or are a fit for, short and standard (e.g. 'Senior Accountant')" },
        skills: { type: "ARRAY", items: { type: "STRING" }, description: "Up to 30 concrete skills/tools, standard short names, no soft-skill fluff" },
        seniority: { type: "STRING", enum: SENIORITY },
    },
    required: ["sectors", "titles", "skills", "seniority"],
};

const SYSTEM = `You prepare a job seeker's profile for matching against job openings in the UAE / GCC.
From the profile, return: the sectors they'd be hired in (only from the given list), the job titles they fit,
their concrete skills (normalised, e.g. "MS Excel" not "excellent excel skills"), and seniority.
Use only what the profile supports. Ignore age, gender, nationality and religion.`;

const lowerList = (a, max) => [...new Set((Array.isArray(a) ? a : []).map((s) => String(s).toLowerCase().trim()).filter(Boolean))].slice(0, max);

function seniorityFromYears(y) {
    if (!Number.isFinite(y)) return null;
    if (y < 1) return "entry";
    if (y < 3) return "junior";
    if (y < 6) return "mid";
    if (y < 10) return "senior";
    return "lead";
}

const EDU_LEVELS = [
    ["doctorate", /\b(phd|doctor|doctorate)\b/i],
    ["masters", /\b(master|mba|msc|m\.sc|ma\b|m\.a\.)/i],
    ["bachelors", /\b(bachelor|b\.?sc|b\.?com|b\.?a\b|be\b|b\.?e\.|b\.?tech|degree|graduate)/i],
    ["diploma", /\b(diploma|associate)/i],
    ["school", /\b(high school|secondary|12th|10th|matric)/i],
];

function educationLevel(education = []) {
    const text = education.map((e) => `${e.degree || ""} ${e.field || ""}`).join(" ");
    for (const [level, re] of EDU_LEVELS) if (re.test(text)) return level;
    return education.length ? "other" : null;
}

/** What doesn't need a model: copied straight from the profile. */
function basics(s) {
    const years = s.total_experience_years == null ? null : Number(s.total_experience_years);
    const titles = [s.headline, ...(s.experience || []).map((e) => e.title)].filter(Boolean);
    return {
        years: Number.isFinite(years) ? years : null,
        city: s.city ? String(s.city).toLowerCase().trim() : null,
        country: s.country ? String(s.country).toLowerCase().trim() : null,
        languages: lowerList(s.languages, 10),
        education_level: educationLevel(s.education || []),
        titles: lowerList(titles, 6),
        skills: lowerList([...(s.skills || []), ...(s.certifications || [])], 30),
    };
}

/** Keyword fallback for the parts a model would classify. */
function ruleMeta(s, base) {
    const text = ` ${[s.headline, s.summary, ...(s.experience || []).map((e) => `${e.title} ${e.summary || ""}`), ...(s.skills || [])].join(" ").toLowerCase()} `;
    const scored = Object.entries(SECTOR_WORDS)
        .map(([sector, words]) => [sector, words.filter((w) => text.includes(w)).length])
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([sector]) => sector);
    return { sectors: scored, seniority: seniorityFromYears(base.years) || "mid", method: "rules" };
}

async function modelMeta(s) {
    const profile = {
        headline: s.headline,
        current_company: s.current_company,
        total_experience_years: s.total_experience_years,
        summary: (s.summary || "").slice(0, 1500),
        skills: s.skills || [],
        certifications: s.certifications || [],
        experience: (s.experience || []).slice(0, 8),
        education: (s.education || []).slice(0, 4),
    };
    const out = await generateJson({
        system: SYSTEM,
        parts: [{ text: `SECTORS: ${SECTORS.join(" | ")}\n\nPROFILE:\n${JSON.stringify(profile)}` }],
        schema: SCHEMA,
        temperature: 0,
    });
    if (!out) return null;
    return {
        sectors: (out.sectors || []).filter((x) => SECTORS.includes(x)).slice(0, 3),
        titles: lowerList(out.titles, 6),
        skills: lowerList(out.skills, 30),
        seniority: SENIORITY.includes(out.seniority) ? out.seniority : null,
        method: "model",
    };
}

const ProfileMetaService = {
    SECTORS,

    /** Build the meta for a seeker row (no DB writes). */
    async build(s) {
        const base = basics(s);
        let model = null;
        if (geminiConfigured()) {
            try {
                model = await modelMeta(s);
            } catch (error) {
                console.warn("Profile meta fell back to rules:", error.message);
            }
        }
        const rules = ruleMeta(s, base);
        return {
            ...base,
            sectors: model?.sectors?.length ? model.sectors : rules.sectors,
            // Model's tidy titles/skills plus the person's own words, so exact matches still hit.
            titles: lowerList([...(model?.titles || []), ...base.titles], 8),
            skills: lowerList([...(model?.skills || []), ...base.skills], 40),
            seniority: model?.seniority || rules.seniority,
            method: model ? "model" : "rules",
            version: 1,
        };
    },

    /** Rebuild and store. Fire-and-forget safe: never throws. */
    async refresh(seeker_id) {
        try {
            const { rows } = await db.query(`SELECT * FROM job_seekers WHERE id = $1`, [seeker_id]);
            if (!rows[0]) return null;
            const meta = await this.build(rows[0]);
            await db.query(`UPDATE job_seekers SET profile_meta = $2, profile_meta_at = NOW() WHERE id = $1`, [seeker_id, meta]);
            return meta;
        } catch (error) {
            console.warn("Profile meta refresh failed:", error.message);
            return null;
        }
    },
};

module.exports = ProfileMetaService;
