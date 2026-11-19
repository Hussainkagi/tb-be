/**
 * Minimal Gemini client (REST, no SDK): one call that returns JSON matching a
 * schema. Used to read job descriptions.
 *
 * Env: GEMINI_API_KEY (required), GEMINI_MODEL (default below).
 */
// An alias Google keeps pointed at the current Flash model, so a retired version
// never breaks this. Set GEMINI_MODEL to pin a specific one.
const DEFAULT_MODEL = "gemini-flash-latest";
const TIMEOUT_MS = 60_000;

const geminiConfigured = () => Boolean(process.env.GEMINI_API_KEY);
const geminiModel = () => (process.env.GEMINI_MODEL || DEFAULT_MODEL).trim();

class GeminiError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

/**
 * @param {object} o
 * @param {string} o.system            system instruction
 * @param {Array}  o.parts             content parts: { text } or { inline_data: { mime_type, data } }
 * @param {object} o.schema            OpenAPI-style response schema
 * @param {number} [o.temperature=0.2]
 * @returns {Promise<object>} parsed JSON
 */
async function generateJson({ system, parts, schema, temperature = 0.2 }) {
    if (!geminiConfigured()) throw new GeminiError("Gemini is not configured", 503);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
        res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel())}:generateContent`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
                body: JSON.stringify({
                    system_instruction: { parts: [{ text: system }] },
                    contents: [{ role: "user", parts }],
                    generationConfig: {
                        temperature,
                        responseMimeType: "application/json",
                        responseSchema: schema,
                    },
                }),
                signal: controller.signal,
            },
        );
    } catch (error) {
        throw new GeminiError(error.name === "AbortError" ? "Reading the job description took too long — please try again" : "Couldn't read the job description right now — please try again", 504);
    } finally {
        clearTimeout(timer);
    }

    const json = await res.json().catch(() => null);
    if (!res.ok) {
        const msg = json?.error?.message || `AI request failed (${res.status})`;
        console.error("[gemini]", res.status, msg);
        throw new GeminiError(res.status === 429 ? "We're busy right now — try again in a minute" : "We couldn't read this document", res.status === 429 ? 429 : 502);
    }

    const candidate = json?.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => p.text || "").join("") || "";
    if (!text) {
        const reason = candidate?.finishReason || json?.promptFeedback?.blockReason || "empty answer";
        console.error("[gemini] no content:", reason);
        throw new GeminiError("We couldn't read this document", 502);
    }
    try {
        return JSON.parse(text);
    } catch {
        console.error("[gemini] invalid JSON:", text.slice(0, 300));
        throw new GeminiError("We couldn't read this document — please try again", 502);
    }
}

module.exports = { generateJson, geminiConfigured, geminiModel, GeminiError };
