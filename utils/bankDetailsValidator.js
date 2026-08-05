const { getSpec, BANK_COLUMNS } = require("../enums/bankFieldSpecs");

/**
 * Validates a bank-details payload against the field spec of a country and
 * splits it into real table columns plus an `extra` JSONB bag.
 *
 * Returns { valid, errors: [{ field, message }], data }
 * where `data` is ready to hand to the model.
 */

/** Applies a field's declared transform before validating. */
function applyTransform(value, transform) {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();

    switch (transform) {
        case "uppercase":
            return trimmed.toUpperCase();
        case "uppercase_nospace":
            return trimmed.toUpperCase().replace(/\s+/g, "");
        default:
            return trimmed;
    }
}

const isBlank = (v) => v === undefined || v === null || String(v).trim() === "";

/** work_country must be a real ISO 3166-1 alpha-2 code — the column is VARCHAR(2). */
function normalizeCountry(work_country) {
    const code = String(work_country || "").trim().toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code : null;
}

function validateBankDetails(work_country, payload = {}) {
    const country = normalizeCountry(work_country);

    if (!country) {
        return {
            valid: false,
            errors: [
                {
                    field: "work_country",
                    message:
                        "work_country is required and must be a 2-letter ISO country code (e.g. AE, IN, GB)",
                },
            ],
            data: null,
        };
    }

    const spec = getSpec(country);
    const errors = [];
    const cleaned = {};
    const extra = {};

    for (const field of spec.fields) {
        const raw = payload[field.key];

        if (isBlank(raw)) {
            if (field.required) {
                errors.push({
                    field: field.key,
                    message: `${field.label} is required for ${spec.country_name}`,
                });
            }
            continue;
        }

        const value = applyTransform(raw, field.transform);

        if (field.pattern && !new RegExp(field.pattern).test(value)) {
            errors.push({
                field: field.key,
                message: `${field.label} is not valid${field.help ? ` — ${field.help}` : ""}`,
            });
            continue;
        }

        if (field.max_length && String(value).length > field.max_length) {
            errors.push({
                field: field.key,
                message: `${field.label} must be at most ${field.max_length} characters`,
            });
            continue;
        }

        if (field.type === "select" && field.options) {
            const allowed = field.options.map((o) => o.value);
            if (!allowed.includes(value)) {
                errors.push({
                    field: field.key,
                    message: `${field.label} must be one of: ${allowed.join(", ")}`,
                });
                continue;
            }
        }

        // Known column, or park it in the JSONB bag.
        if (BANK_COLUMNS.includes(field.key)) cleaned[field.key] = value;
        else extra[field.key] = value;
    }

    // Carry through any columns the caller sent that the spec doesn't mention
    // (e.g. swift_bic on a country whose spec omits it) — useful, never required.
    for (const col of BANK_COLUMNS) {
        if (cleaned[col] === undefined && !isBlank(payload[col])) {
            cleaned[col] = String(payload[col]).trim();
        }
    }

    // Free-form additions the caller explicitly nested under `extra`.
    if (payload.extra && typeof payload.extra === "object" && !Array.isArray(payload.extra)) {
        for (const [k, v] of Object.entries(payload.extra)) {
            if (!isBlank(v)) extra[k] = v;
        }
    }

    return {
        valid: errors.length === 0,
        errors,
        data: {
            ...cleaned,
            extra,
            work_country: country,
            account_currency: !isBlank(payload.account_currency)
                ? String(payload.account_currency).trim().toUpperCase()
                : spec.default_currency,
        },
    };
}

module.exports = { validateBankDetails, applyTransform, normalizeCountry };
