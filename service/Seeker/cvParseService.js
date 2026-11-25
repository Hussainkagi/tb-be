/**
 * Read a CV (PDF / Word) into a structured profile with Gemini.
 * Returns only what the CV states — missing things come back null / empty.
 */
const { parseDocx } = require("../../utils/docxParser");
const { generateJson, geminiConfigured } = require("../../utils/gemini");

const S = (description, extra = {}) => ({ type: "STRING", description, nullable: true, ...extra });
const N = (description) => ({ type: "NUMBER", description, nullable: true });
const LIST = (description) => ({ type: "ARRAY", items: { type: "STRING" }, description });

const SCHEMA = {
    type: "OBJECT",
    properties: {
        is_cv: { type: "BOOLEAN", description: "false if the document is not a CV / resume" },
        first_name: S("First name"),
        last_name: S("Last name"),
        email: S("Email address"),
        phone: S("Phone number with country code if shown"),
        gender: S("Only if the CV states it", { enum: ["male", "female"] }),
        date_of_birth: S("YYYY-MM-DD, only if the CV states a full date of birth"),
        age_years: N("Age in years, only if the CV states it or a birth year"),
        nationality: S("Nationality, only if stated"),
        country: S("Country the person currently lives in"),
        city: S("City the person currently lives in"),
        headline: S("Current or most recent job title"),
        current_company: S("Current or most recent employer"),
        total_experience_years: N("Total professional experience in years, from the work history"),
        linkedin_url: S("LinkedIn profile URL"),
        portfolio_url: S("Personal website / portfolio / GitHub URL"),
        summary: S("2–4 sentence professional summary in third person, plain text"),
        skills: LIST("Up to 25 concrete skills, each 1–4 words"),
        languages: LIST("Spoken languages"),
        certifications: LIST("Certifications and licences"),
        experience: {
            type: "ARRAY",
            description: "Work history, most recent first",
            items: {
                type: "OBJECT",
                properties: {
                    title: S("Job title"),
                    company: S("Employer"),
                    location: S("City / country"),
                    start: S("Start as YYYY-MM or YYYY"),
                    end: S("End as YYYY-MM or YYYY; null if current"),
                    current: { type: "BOOLEAN", description: "true if this is their current job" },
                    summary: S("One or two lines on what they did"),
                },
            },
        },
        education: {
            type: "ARRAY",
            description: "Education, most recent first",
            items: {
                type: "OBJECT",
                properties: {
                    degree: S("Degree / qualification"),
                    field: S("Field of study"),
                    institution: S("School / university"),
                    start: S("YYYY"),
                    end: S("YYYY"),
                },
            },
        },
    },
    required: ["is_cv"],
};

const SYSTEM = `You read CVs / resumes and return the candidate's profile.
Rules:
- Use only what the CV says. Never guess gender, age, nationality or date of birth — null when not stated.
- Write in clear English even if the CV is in another language.
- Plain text only, no markdown.
- Experience in years is a number computed from the work history dates when not stated.`;

const CvParseService = {
    canRead(mime, name = "") {
        const lower = String(name).toLowerCase();
        return mime === "application/pdf" || lower.endsWith(".pdf") ||
            mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || lower.endsWith(".docx");
    },

    /** @returns {Promise<object|null>} parsed profile, or null when it can't be read */
    async read(buffer, mime, name = "") {
        if (!geminiConfigured() || !this.canRead(mime, name)) return null;
        const isPdf = mime === "application/pdf" || String(name).toLowerCase().endsWith(".pdf");
        let parts;
        if (isPdf) {
            parts = [{ inline_data: { mime_type: "application/pdf", data: buffer.toString("base64") } }];
        } else {
            let text = "";
            try {
                text = parseDocx(buffer).text;
            } catch {
                return null;
            }
            if (text.trim().length < 40) return null;
            parts = [{ text: `CV:\n\n${text.slice(0, 40000)}` }];
        }
        parts.push({ text: `Today's date is ${new Date().toISOString().slice(0, 10)}. Return the profile.` });
        try {
            const out = await generateJson({ system: SYSTEM, parts, schema: SCHEMA });
            return out?.is_cv === false ? null : out;
        } catch (error) {
            console.error("[cv-parse]", error.message);
            return null;
        }
    },
};

module.exports = CvParseService;
