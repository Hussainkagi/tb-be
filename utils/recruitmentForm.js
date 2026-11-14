/**
 * The job application form — the one place its shape is defined.
 *
 * A job stores only switches (`form_config`):
 *
 *   {
 *     fields:    { linkedin_url: { enabled: false, required: false }, ... },
 *     questions: [{ id, label, type, required }]
 *   }
 *
 * Everything else (labels, input types, order, options) lives in FIELD_CATALOG
 * below, and both the agency's job editor and the public apply form are
 * rendered from what this module returns. Adding a field is one entry here.
 */

const FIELD_CATALOG = [
    // locked: always on and required — an application without them is useless.
    { key: "full_name",        label: "Full name",                 type: "text",     locked: true,  enabled: true,  required: true },
    { key: "email",            label: "Email",                     type: "email",    locked: true,  enabled: true,  required: true },
    { key: "phone",            label: "Phone / WhatsApp",          type: "tel",      enabled: true,  required: true },
    { key: "cv",               label: "CV / Resume",               type: "file",     enabled: true,  required: true },
    { key: "linkedin_url",     label: "LinkedIn profile URL",      type: "url",      enabled: true,  required: false },
    { key: "portfolio_url",    label: "Portfolio / website",       type: "url",      enabled: false, required: false },
    { key: "current_location", label: "Current location",          type: "text",     enabled: true,  required: false },
    { key: "nationality",      label: "Nationality",               type: "text",     enabled: false, required: false },
    {
        key: "visa_status", label: "Visa status", type: "select", enabled: false, required: false,
        options: ["Employment visa", "Residence / family visa", "Golden visa", "Visit visa", "Citizen", "Need sponsorship"],
    },
    { key: "total_experience", label: "Total experience (years)",  type: "number",   enabled: true,  required: false },
    { key: "highest_education",label: "Highest qualification",     type: "text",     enabled: false, required: false },
    { key: "current_salary",   label: "Current salary (monthly)",  type: "number",   enabled: false, required: false },
    { key: "expected_salary",  label: "Expected salary (monthly)", type: "number",   enabled: false, required: false },
    { key: "notice_period",    label: "Notice period",             type: "text",     enabled: false, required: false },
    { key: "cover_letter",     label: "Cover letter",              type: "textarea", enabled: false, required: false },
];

const QUESTION_TYPES = ["text", "textarea", "number", "yes_no"];
const MAX_QUESTIONS = 10;
const MAX_TEXT = 4000;

/** Fills in defaults and forces locked fields on. Safe on any input. */
function normalizeFormConfig(input) {
    const raw = input && typeof input === "object" ? input : {};
    const rawFields = raw.fields && typeof raw.fields === "object" ? raw.fields : {};

    const fields = {};
    for (const def of FIELD_CATALOG) {
        const given = rawFields[def.key] || {};
        const enabled = def.locked ? true : given.enabled ?? def.enabled;
        fields[def.key] = {
            enabled: Boolean(enabled),
            required: def.locked ? true : Boolean(enabled) && Boolean(given.required ?? def.required),
        };
    }

    const questions = (Array.isArray(raw.questions) ? raw.questions : [])
        .filter((q) => q && String(q.label || "").trim())
        .slice(0, MAX_QUESTIONS)
        .map((q, i) => ({
            id: /^[a-z0-9_-]{1,40}$/i.test(String(q.id || "")) ? String(q.id) : `q${i + 1}`,
            label: String(q.label).trim().slice(0, 200),
            type: QUESTION_TYPES.includes(q.type) ? q.type : "text",
            required: Boolean(q.required),
        }));

    return { fields, questions };
}

/** The form a candidate sees: ordered, enabled fields + custom questions. */
function resolveForm(config) {
    const { fields, questions } = normalizeFormConfig(config);
    return {
        fields: FIELD_CATALOG.filter((def) => fields[def.key].enabled).map((def) => ({
            key: def.key,
            label: def.label,
            type: def.type,
            required: fields[def.key].required,
            ...(def.options ? { options: def.options } : {}),
        })),
        questions,
    };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Checks a submission against the job's form.
 * `hasFile` says whether a CV arrived (the file itself is handled by multer).
 *
 * @returns {{ answers: object, errors: Record<string,string> }}
 *   `answers` holds only fields the form asked for, trimmed.
 */
function validateAnswers(config, body = {}, { hasFile = false } = {}) {
    const form = resolveForm(config);
    const answers = {};
    const errors = {};

    for (const field of form.fields) {
        if (field.type === "file") {
            if (field.required && !hasFile) errors.cv = "Please attach your CV";
            continue;
        }
        const value = String(body[field.key] ?? "").trim().slice(0, MAX_TEXT);
        if (!value) {
            if (field.required) errors[field.key] = `${field.label} is required`;
            continue;
        }
        if (field.type === "email" && !EMAIL_RE.test(value)) errors[field.key] = "Enter a valid email";
        else if (field.type === "url" && !/^https?:\/\/\S+\.\S+/i.test(value)) errors[field.key] = "Enter a full link starting with https://";
        else if (field.type === "number" && !Number.isFinite(Number(value))) errors[field.key] = "Enter a number";
        else if (field.type === "select" && !field.options.includes(value)) errors[field.key] = "Pick one of the options";
        answers[field.key] = value;
    }

    // Custom answers arrive as q_<id> so they can never collide with a field key.
    for (const q of form.questions) {
        const value = String(body[`q_${q.id}`] ?? "").trim().slice(0, MAX_TEXT);
        if (!value) {
            if (q.required) errors[`q_${q.id}`] = "This question is required";
            continue;
        }
        if (q.type === "number" && !Number.isFinite(Number(value))) errors[`q_${q.id}`] = "Enter a number";
        if (q.type === "yes_no" && !["yes", "no"].includes(value.toLowerCase())) errors[`q_${q.id}`] = "Answer yes or no";
        answers[`q_${q.id}`] = value;
    }

    return { answers, errors };
}

module.exports = { FIELD_CATALOG, QUESTION_TYPES, normalizeFormConfig, resolveForm, validateAnswers };
