/**
 * Country-specific bank account field specifications.
 *
 * Single source of truth for BOTH:
 *   - backend validation (which fields are required, what shape they take)
 *   - the frontend form (served via GET .../bank-field-specs, so the UI renders
 *     the right inputs per country instead of hardcoding them)
 *
 * Add a country here and it works end-to-end with no other code change.
 *
 * `key` must be either a real column on employee_bank_accounts (see
 * BANK_COLUMNS below) or it is stored inside the `extra` JSONB automatically.
 */

/** Columns that exist on employee_bank_accounts. Anything else goes to `extra`. */
const BANK_COLUMNS = Object.freeze([
    "account_holder_name",
    "bank_name",
    "branch_name",
    "bank_address",
    "account_number",
    "account_type",
    "iban",
    "swift_bic",
    "ifsc_code",
    "routing_number",
    "sort_code",
    "bank_code",
]);

// ── Reusable field definitions ───────────────────────────────────────────────

const holder = {
    key: "account_holder_name",
    label: "Account Holder Name",
    type: "text",
    required: true,
    max_length: 255,
    help: "Exactly as printed on the bank account.",
};

const bankName = {
    key: "bank_name",
    label: "Bank Name",
    type: "text",
    required: true,
    max_length: 255,
};

const branch = (required = false) => ({
    key: "branch_name",
    label: "Branch Name",
    type: "text",
    required,
    max_length: 255,
});

const swift = (required = false) => ({
    key: "swift_bic",
    label: "SWIFT / BIC Code",
    type: "text",
    required,
    transform: "uppercase",
    pattern: "^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$",
    placeholder: "EBILAEAD",
    help: "8 or 11 characters. Needed for international transfers.",
});

const accountNumber = (opts = {}) => ({
    key: "account_number",
    label: "Account Number",
    type: "text",
    required: true,
    pattern: "^[A-Za-z0-9]{6,34}$",
    ...opts,
});

const accountType = (required = false) => ({
    key: "account_type",
    label: "Account Type",
    type: "select",
    required,
    options: [
        { value: "savings", label: "Savings" },
        { value: "current", label: "Current" },
        { value: "checking", label: "Checking" },
    ],
});

// ── Country registry ─────────────────────────────────────────────────────────

const COUNTRY_SPECS = Object.freeze({
    AE: {
        country_code: "AE",
        country_name: "United Arab Emirates",
        default_currency: "AED",
        fields: [
            holder,
            bankName,
            {
                key: "iban",
                label: "IBAN",
                type: "text",
                required: true,
                transform: "uppercase_nospace",
                pattern: "^AE[0-9]{21}$",
                placeholder: "AE070331234567890123456",
                help: "23 characters starting with AE.",
            },
            swift(false),
            branch(false),
        ],
    },

    IN: {
        country_code: "IN",
        country_name: "India",
        default_currency: "INR",
        fields: [
            holder,
            bankName,
            accountNumber({
                pattern: "^[0-9]{9,18}$",
                placeholder: "123456789012",
                help: "9 to 18 digits.",
            }),
            {
                key: "ifsc_code",
                label: "IFSC Code",
                type: "text",
                required: true,
                transform: "uppercase",
                pattern: "^[A-Z]{4}0[A-Z0-9]{6}$",
                placeholder: "HDFC0001234",
                help: "11 characters, 5th character is always zero.",
            },
            branch(false),
            accountType(false),
        ],
    },

    PK: {
        country_code: "PK",
        country_name: "Pakistan",
        default_currency: "PKR",
        fields: [
            holder,
            bankName,
            {
                key: "iban",
                label: "IBAN",
                type: "text",
                required: true,
                transform: "uppercase_nospace",
                pattern: "^PK[0-9]{2}[A-Z]{4}[A-Z0-9]{16}$",
                placeholder: "PK36SCBL0000001123456702",
                help: "24 characters starting with PK.",
            },
            accountNumber({ required: false }),
            branch(false),
        ],
    },

    GB: {
        country_code: "GB",
        country_name: "United Kingdom",
        default_currency: "GBP",
        fields: [
            holder,
            bankName,
            {
                key: "sort_code",
                label: "Sort Code",
                type: "text",
                required: true,
                pattern: "^[0-9]{2}-?[0-9]{2}-?[0-9]{2}$",
                placeholder: "12-34-56",
                help: "6 digits, hyphens optional.",
            },
            accountNumber({
                pattern: "^[0-9]{8}$",
                placeholder: "12345678",
                help: "Exactly 8 digits.",
            }),
            { ...swift(false), required: false },
        ],
    },

    US: {
        country_code: "US",
        country_name: "United States",
        default_currency: "USD",
        fields: [
            holder,
            bankName,
            {
                key: "routing_number",
                label: "Routing Number (ABA)",
                type: "text",
                required: true,
                pattern: "^[0-9]{9}$",
                placeholder: "021000021",
                help: "Exactly 9 digits.",
            },
            accountNumber({
                pattern: "^[0-9]{4,17}$",
                placeholder: "1234567890",
            }),
            accountType(true),
        ],
    },

    SA: {
        country_code: "SA",
        country_name: "Saudi Arabia",
        default_currency: "SAR",
        fields: [
            holder,
            bankName,
            {
                key: "iban",
                label: "IBAN",
                type: "text",
                required: true,
                transform: "uppercase_nospace",
                pattern: "^SA[0-9]{22}$",
                placeholder: "SA0380000000608010167519",
                help: "24 characters starting with SA.",
            },
            swift(false),
        ],
    },

    EG: {
        country_code: "EG",
        country_name: "Egypt",
        default_currency: "EGP",
        fields: [
            holder,
            bankName,
            accountNumber({ pattern: "^[A-Za-z0-9]{8,34}$" }),
            {
                key: "iban",
                label: "IBAN",
                type: "text",
                required: false,
                transform: "uppercase_nospace",
                pattern: "^EG[0-9]{27}$",
            },
            swift(false),
            branch(false),
        ],
    },

    BD: {
        country_code: "BD",
        country_name: "Bangladesh",
        default_currency: "BDT",
        fields: [
            holder,
            bankName,
            accountNumber({ pattern: "^[0-9]{10,20}$" }),
            branch(true),
            {
                key: "routing_number",
                label: "Routing Number",
                type: "text",
                required: false,
                pattern: "^[0-9]{9}$",
            },
        ],
    },

    NP: {
        country_code: "NP",
        country_name: "Nepal",
        default_currency: "NPR",
        fields: [holder, bankName, accountNumber(), branch(true)],
    },

    LK: {
        country_code: "LK",
        country_name: "Sri Lanka",
        default_currency: "LKR",
        fields: [
            holder,
            bankName,
            accountNumber({ pattern: "^[0-9]{6,20}$" }),
            branch(true),
            {
                key: "bank_code",
                label: "Bank Code",
                type: "text",
                required: false,
                pattern: "^[0-9]{4,7}$",
            },
        ],
    },

    PH: {
        country_code: "PH",
        country_name: "Philippines",
        default_currency: "PHP",
        fields: [
            holder,
            bankName,
            accountNumber({ pattern: "^[0-9]{10,16}$" }),
            branch(false),
            accountType(false),
        ],
    },

    /**
     * Fallback for any country without a dedicated spec. Deliberately permissive
     * — collect the international essentials and let `extra` carry the rest.
     */
    OTHER: {
        country_code: "OTHER",
        country_name: "Other / International",
        default_currency: null,
        fields: [
            holder,
            bankName,
            accountNumber({ required: true }),
            { ...swift(false), required: false },
            {
                key: "iban",
                label: "IBAN",
                type: "text",
                required: false,
                transform: "uppercase_nospace",
                pattern: "^[A-Z]{2}[0-9A-Z]{13,32}$",
            },
            branch(false),
            {
                key: "bank_address",
                label: "Bank Address",
                type: "textarea",
                required: false,
            },
        ],
    },
});

/**
 * Resolves the field spec for an ISO 3166-1 alpha-2 country code.
 *
 * A country without a dedicated entry gets the permissive OTHER template, but
 * the returned `country_code` still echoes what was asked for — the stored
 * value is always the real country, never the literal string "OTHER".
 */
function getSpec(country_code) {
    const code = String(country_code || "").toUpperCase();
    const dedicated = code && code !== "OTHER" ? COUNTRY_SPECS[code] : null;

    if (dedicated) return { ...dedicated, is_generic: false };

    return {
        ...COUNTRY_SPECS.OTHER,
        country_code: /^[A-Z]{2}$/.test(code) ? code : "OTHER",
        country_name: /^[A-Z]{2}$/.test(code) ? code : COUNTRY_SPECS.OTHER.country_name,
        is_generic: true,
    };
}

/**
 * Countries with a dedicated format. Any other ISO2 code is still accepted —
 * it just renders the generic international form.
 */
function listCountries() {
    return Object.values(COUNTRY_SPECS)
        .filter((s) => s.country_code !== "OTHER")
        .map((s) => ({
            country_code: s.country_code,
            country_name: s.country_name,
            default_currency: s.default_currency,
            is_generic: false,
            required_fields: s.fields.filter((f) => f.required).map((f) => f.key),
        }));
}

/**
 * `companies.country` and `branches.country` are free text holding full country
 * names ("United Arab Emirates", "India"), not ISO codes. This resolves either
 * form to an ISO2 code so we can derive a sensible default work_country.
 * Returns null when it can't tell — better than guessing.
 */
const COUNTRY_ALIASES = Object.freeze({
    "united arab emirates": "AE", uae: "AE", "u.a.e.": "AE", emirates: "AE",
    india: "IN", bharat: "IN",
    pakistan: "PK",
    "united kingdom": "GB", uk: "GB", "great britain": "GB", england: "GB", britain: "GB",
    "united states": "US", usa: "US", "united states of america": "US", "u.s.a.": "US", america: "US",
    "saudi arabia": "SA", ksa: "SA", "kingdom of saudi arabia": "SA",
    egypt: "EG",
    bangladesh: "BD",
    nepal: "NP",
    "sri lanka": "LK",
    philippines: "PH", "the philippines": "PH",
});

function resolveCountryCode(input) {
    if (!input) return null;

    const raw = String(input).trim();
    if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();

    return COUNTRY_ALIASES[raw.toLowerCase()] || null;
}

/** True when the code has a dedicated spec (as opposed to falling back). */
const isSupportedCountry = (code) =>
    Boolean(code) &&
    String(code).toUpperCase() !== "OTHER" &&
    Object.prototype.hasOwnProperty.call(COUNTRY_SPECS, String(code).toUpperCase());

module.exports = {
    COUNTRY_SPECS,
    BANK_COLUMNS,
    getSpec,
    listCountries,
    isSupportedCountry,
    resolveCountryCode,
};
