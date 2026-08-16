/**
 * Country normalisation for policy matching.
 *
 * `companies.country` is free text — the same country arrives as "UAE",
 * "U.A.E.", "United Arab Emirates" or "AE" depending on who typed it. Terms &
 * Conditions are served per country, so matching on that text would quietly
 * hand a UAE company the global default. Everything that resolves a policy
 * goes through here first and compares ISO 3166-1 alpha-2 codes instead.
 *
 * The map is intentionally partial: it covers the alpha-2 codes plus the names
 * and aliases we actually see. An unrecognised name resolves to NULL, which
 * falls back to the global policy — the safe failure, since the company gets
 * the default terms rather than none.
 */

// Aliases and full names → alpha-2. Keys are compared uppercased and stripped
// of punctuation, so "U.A.E." and "uae" both land on the same entry.
const NAME_TO_CODE = Object.freeze({
    UAE: "AE",
    UNITEDARABEMIRATES: "AE",
    EMIRATES: "AE",
    DUBAI: "AE",
    ABUDHABI: "AE",

    INDIA: "IN",
    BHARAT: "IN",

    SAUDIARABIA: "SA",
    KSA: "SA",
    KINGDOMOFSAUDIARABIA: "SA",

    QATAR: "QA",
    KUWAIT: "KW",
    OMAN: "OM",
    BAHRAIN: "BH",

    UK: "GB",
    UNITEDKINGDOM: "GB",
    GREATBRITAIN: "GB",
    ENGLAND: "GB",

    USA: "US",
    UNITEDSTATES: "US",
    UNITEDSTATESOFAMERICA: "US",
    AMERICA: "US",

    PAKISTAN: "PK",
    BANGLADESH: "BD",
    SRILANKA: "LK",
    NEPAL: "NP",
    PHILIPPINES: "PH",
    INDONESIA: "ID",
    MALAYSIA: "MY",
    SINGAPORE: "SG",
    EGYPT: "EG",
    JORDAN: "JO",
    LEBANON: "LB",
    TURKEY: "TR",
    TURKIYE: "TR",
    NIGERIA: "NG",
    KENYA: "KE",
    SOUTHAFRICA: "ZA",
    CANADA: "CA",
    AUSTRALIA: "AU",
    NEWZEALAND: "NZ",
    GERMANY: "DE",
    FRANCE: "FR",
    SPAIN: "ES",
    ITALY: "IT",
    NETHERLANDS: "NL",
    IRELAND: "IE",
});

/**
 * Normalise any country input to an ISO alpha-2 code.
 *
 * @param {string|null|undefined} input - "AE", "uae", "United Arab Emirates"…
 * @returns {string|null} Uppercase alpha-2 code, or null when unrecognised.
 */
function resolveCountryCode(input) {
    if (!input || typeof input !== "string") return null;

    const trimmed = input.trim();
    if (!trimmed) return null;

    // Already a code.
    if (/^[A-Za-z]{2}$/.test(trimmed)) return trimmed.toUpperCase();

    const key = trimmed.toUpperCase().replace(/[^A-Z]/g, "");
    return NAME_TO_CODE[key] || null;
}

/**
 * Guard for values written straight into policy_documents.country_code, where
 * a CHECK constraint enforces the same shape. Rejecting here turns a 500 from
 * Postgres into a 400 with a message the Super Admin panel can display.
 *
 * @param {string|null|undefined} input
 * @returns {{ valid: boolean, code: string|null, message?: string }}
 *          A blank input is VALID and yields null — that is the global policy.
 */
function validateCountryCode(input) {
    if (input === null || input === undefined || String(input).trim() === "") {
        return { valid: true, code: null };
    }

    const code = resolveCountryCode(input);
    if (!code) {
        return {
            valid: false,
            code: null,
            message: `Unrecognised country "${input}". Provide an ISO 3166-1 alpha-2 code (e.g. "AE"), or leave it blank for the global policy.`,
        };
    }
    return { valid: true, code };
}

module.exports = { resolveCountryCode, validateCountryCode };
