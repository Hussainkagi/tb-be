const db = require("../config/database");
const { PolicyDocument, PolicyAcceptance } = require("../models/policyModel");
const CompanyModel = require("../models/companyModel");
const SuperAdminModel = require("../models/superAdminModel");
const NotificationService = require("./notificationService");
const { parseDocx } = require("../utils/docxParser");
const { uploadToCloudinary } = require("../utils/cloudinaryHelper");
const { validateCountryCode, resolveCountryCode } = require("../utils/countryCodes");
const { sendEmail } = require("../utils/mailer");
const { policyUpdateTemplate } = require("../utils/emailTemplates");

const POLICY_TYPES = Object.freeze(["terms", "privacy"]);

const POLICY_LABEL = Object.freeze({
    terms: "Terms and Conditions",
    privacy: "Privacy Policy",
});

/**
 * Shape a document row for a company-facing response.
 *
 * Anything that is Ikration's business and not the tenant's is stripped:
 * which Super Admin published it, and the Cloudinary public_id. The rendered
 * HTML and the download link stay, because that is what the profile screen
 * and the "download a copy" button need.
 */
const toPublicDocument = (row, { includeContent = true } = {}) => {
    if (!row) return null;
    return {
        id: row.id,
        policy_type: row.policy_type,
        policy_label: POLICY_LABEL[row.policy_type] || row.policy_type,
        country_code: row.country_code,
        version: row.version,
        title: row.title,
        change_note: row.change_note,
        effective_from: row.effective_from,
        requires_reacceptance: row.requires_reacceptance,
        published_at: row.published_at,
        source_file_url: row.source_file_url,
        source_file_name: row.source_file_name,
        ...(includeContent && {
            content_html: row.content_html,
            content_text: row.content_text,
        }),
    };
};

const PolicyService = {
    // ═════════════════════════════════════════════════════════════════════════
    // SUPER ADMIN — PUBLISHING
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Publish a new version of a policy from an uploaded .docx.
     *
     * The whole thing is one story: parse → version → supersede → insert →
     * notify. Parsing runs FIRST, before anything is written or uploaded, so a
     * malformed file costs nothing: no orphan Cloudinary asset, no half-created
     * version, and the previous document stays live.
     *
     * Notification and email are fired AFTER the transaction commits and are
     * never allowed to fail the publish — a mail outage must not roll back a
     * legal document that is already in force.
     *
     * @param {object} params
     * @param {Buffer} params.file_buffer      - Raw .docx contents.
     * @param {string} params.policy_type      - 'terms' | 'privacy'.
     * @param {string} [params.country]        - ISO alpha-2 or country name; blank = global.
     * @param {string} [params.title]          - Defaults to the document's own heading.
     * @param {boolean} [params.notify=true]   - Skip to publish quietly.
     */
    async publish(params) {
        const {
            file_buffer,
            file_name = "policy.docx",
            file_mime = null,
            file_size = null,
            policy_type,
            country = null,
            title = null,
            change_note = null,
            effective_from = null,
            requires_reacceptance = true,
            notify = true,
            actor_user_id = null,
            ip_address = null,
        } = params;

        if (!POLICY_TYPES.includes(policy_type)) {
            return {
                success: false,
                message: `policy_type must be one of: ${POLICY_TYPES.join(", ")}`,
            };
        }

        const country_check = validateCountryCode(country);
        if (!country_check.valid) {
            return { success: false, message: country_check.message };
        }
        const country_code = country_check.code;

        if (!file_buffer || !file_buffer.length) {
            return { success: false, message: "A .docx document file is required" };
        }

        // ── 1. Parse before anything is persisted ────────────────────────────
        let parsed;
        try {
            parsed = parseDocx(file_buffer);
        } catch (error) {
            return {
                success: false,
                message: `Could not read the document: ${error.message}`,
            };
        }

        const resolvedTitle =
            (title && title.trim()) ||
            parsed.title ||
            `${POLICY_LABEL[policy_type]}${country_code ? ` — ${country_code}` : ""}`;

        // ── 2. Keep the original file ────────────────────────────────────────
        // resource_type "raw" is required: Cloudinary's default is "image" and
        // it rejects a .docx outright.
        let upload = null;
        try {
            upload = await uploadToCloudinary(file_buffer, {
                folder: `policies/${policy_type}/${country_code || "global"}`,
                publicId: `${policy_type}_${country_code || "global"}_${Date.now()}`,
                resourceType: "raw",
            });
        } catch (error) {
            // The rendered text is what the app serves, so a storage hiccup is
            // logged and the publish continues without the download link
            // rather than blocking Legal from shipping an urgent change.
            console.error("[PolicyService] Cloudinary upload failed:", error.message);
        }

        // ── 3. Supersede + insert, atomically ────────────────────────────────
        const client = await db.getClient();
        let document;
        let previous = null;

        try {
            await client.query("BEGIN");

            const latestVersion = await PolicyDocument.getLatestVersionNumber(
                policy_type, country_code, client
            );
            previous = await PolicyDocument.demoteCurrent(policy_type, country_code, client);

            document = await PolicyDocument.create(
                {
                    policy_type,
                    country_code,
                    version: latestVersion + 1,
                    title: resolvedTitle,
                    change_note,
                    effective_from,
                    content_html: parsed.html,
                    content_text: parsed.text,
                    source_file_url: upload?.secureUrl || null,
                    source_file_public_id: upload?.publicId || null,
                    source_file_name: file_name,
                    source_file_mime: file_mime,
                    source_file_size: file_size,
                    requires_reacceptance: requires_reacceptance !== false,
                    published_by_user_id: actor_user_id,
                },
                client
            );

            await client.query("COMMIT");
        } catch (error) {
            await client.query("ROLLBACK");
            return { success: false, message: error.message, error };
        } finally {
            client.release();
        }

        // ── 4. Audit the platform action ─────────────────────────────────────
        try {
            await SuperAdminModel.createAuditLog({
                actor_user_id,
                action: "policy.publish",
                reason: change_note,
                ip_address,
                metadata: {
                    policy_type,
                    country_code,
                    version: document.version,
                    previous_version: previous?.version || null,
                    document_id: document.id,
                    file_name,
                },
            });
        } catch (error) {
            console.error("[PolicyService] Audit log failed:", error.message);
        }

        // ── 5. Tell the affected company admins ──────────────────────────────
        let notified = { admins: 0, companies: 0, emails_sent: 0 };
        if (notify) {
            notified = await PolicyService._notifyAdmins(document, previous);
        }

        return {
            success: true,
            message: `${POLICY_LABEL[policy_type]} v${document.version} published`,
            data: {
                document: toPublicDocument(document, { includeContent: false }),
                superseded_version: previous?.version || null,
                notified,
            },
        };
    },

    /**
     * In-app notification + email to every company admin the new version
     * applies to.
     *
     * Each company gets its own notification because the fan-out is
     * tenant-scoped, and admins are addressed by role rather than by id so a
     * company with three admins reaches all three. Failures are counted, not
     * thrown: one company with a broken email address must not stop the
     * remaining two hundred from being told.
     */
    async _notifyAdmins(document, previous = null) {
        const label = POLICY_LABEL[document.policy_type] || document.policy_type;

        let admins = [];
        try {
            admins = await PolicyDocument.findAdminsForCountry(
                document.policy_type, document.country_code
            );
        } catch (error) {
            console.error("[PolicyService] Could not resolve admins:", error.message);
            return { admins: 0, companies: 0, emails_sent: 0, error: error.message };
        }

        const companyIds = [...new Set(admins.map((a) => a.company_id))];
        let emails_sent = 0;

        // ── In-app / push, one notification per tenant ───────────────────────
        for (const company_id of companyIds) {
            try {
                await NotificationService.send({
                    company_id,
                    notification_type: "system",
                    channel: "in_app",
                    title: `Updated ${label}`,
                    body: document.change_note
                        ? `Version ${document.version} of our ${label} takes effect on ${document.effective_from}. ${document.change_note}`
                        : `Version ${document.version} of our ${label} takes effect on ${document.effective_from}. Please review it in your company profile.`,
                    deep_link: `/company/profile/legal?policy=${document.policy_type}`,
                    entity_type: "policy_document",
                    entity_id: document.id,
                    audience: { type: "role_based", role: "0" },
                });
            } catch (error) {
                console.error(
                    `[PolicyService] In-app notify failed for company ${company_id}:`,
                    error.message
                );
            }
        }

        // ── Email, one per admin ─────────────────────────────────────────────
        for (const admin of admins) {
            if (!admin.email) continue;
            try {
                await sendEmail({
                    to: admin.email,
                    subject: `Updated ${label} — action may be required`,
                    html: policyUpdateTemplate({
                        first_name: admin.first_name,
                        company_name: admin.company_name,
                        policy_label: label,
                        version: document.version,
                        previous_version: previous?.version || null,
                        effective_from: document.effective_from,
                        change_note: document.change_note,
                        requires_reacceptance: document.requires_reacceptance,
                        view_url: `${process.env.FRONTEND_URL}/company/profile/legal?policy=${document.policy_type}`,
                        download_url: document.source_file_url,
                    }),
                });
                emails_sent++;
            } catch (error) {
                console.error(
                    `[PolicyService] Email failed for ${admin.email}:`,
                    error.message
                );
            }
        }

        return { admins: admins.length, companies: companyIds.length, emails_sent };
    },

    // ═════════════════════════════════════════════════════════════════════════
    // SUPER ADMIN — READING
    // ═════════════════════════════════════════════════════════════════════════

    /** One row per (type, country) lane, with version counts. Panel index. */
    async listLanes() {
        try {
            return { success: true, data: await PolicyDocument.listLanes() };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    async listCurrent(filters = {}) {
        try {
            const country_check = validateCountryCode(filters.country);
            if (!country_check.valid) {
                return { success: false, message: country_check.message };
            }
            const rows = await PolicyDocument.listCurrent({
                policy_type: filters.policy_type || null,
                country_code: country_check.code,
            });
            return { success: true, data: rows };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * Version history for one lane — superseded documents included.
     *
     * Super-Admin-only by design: a company sees the terms it is bound by
     * today, while the archive is what Legal reads when an old agreement is
     * disputed, and exposing every prior draft to tenants invites arguments
     * about which version they "really" signed.
     */
    async listVersions({ policy_type, country, page = 1, limit = 20 }) {
        try {
            if (!POLICY_TYPES.includes(policy_type)) {
                return {
                    success: false,
                    message: `policy_type must be one of: ${POLICY_TYPES.join(", ")}`,
                };
            }
            const country_check = validateCountryCode(country);
            if (!country_check.valid) {
                return { success: false, message: country_check.message };
            }

            const { rows, total } = await PolicyDocument.listVersions({
                policy_type,
                country_code: country_check.code,
                page: Number(page),
                limit: Number(limit),
            });

            return { success: true, data: rows, total };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Any version, current or archived, with its full content. */
    async getDocument(id) {
        try {
            const row = await PolicyDocument.findById(id);
            if (!row) return { success: false, message: "Policy document not found" };
            return { success: true, data: row };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Which companies accepted one specific version. */
    async listDocumentAcceptances(policy_document_id, { page = 1, limit = 50 } = {}) {
        try {
            const document = await PolicyDocument.findById(policy_document_id);
            if (!document) return { success: false, message: "Policy document not found" };

            const { rows, total } = await PolicyAcceptance.listByDocument(
                policy_document_id, { page: Number(page), limit: Number(limit) }
            );

            return {
                success: true,
                data: {
                    document: toPublicDocument(document, { includeContent: false }),
                    acceptances: rows,
                },
                total,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ═════════════════════════════════════════════════════════════════════════
    // PUBLIC — REGISTRATION SCREEN
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * The documents a prospective customer must accept, for their country.
     *
     * Unauthenticated: the signup form has to render the checkbox links before
     * any account exists.
     */
    async getPolicyForCountry(country, { policy_type = null } = {}) {
        try {
            const country_code = resolveCountryCode(country);

            if (policy_type) {
                if (!POLICY_TYPES.includes(policy_type)) {
                    return {
                        success: false,
                        message: `policy_type must be one of: ${POLICY_TYPES.join(", ")}`,
                    };
                }
                const row = await PolicyDocument.findCurrent(policy_type, country_code);
                if (!row) {
                    return {
                        success: false,
                        message: `No ${POLICY_LABEL[policy_type]} has been published yet`,
                    };
                }
                return { success: true, data: toPublicDocument(row) };
            }

            const rows = await PolicyDocument.findAllCurrentForCountry(country_code);
            return {
                success: true,
                data: {
                    country_code,
                    resolved_from: country || null,
                    policies: rows.map((r) => toPublicDocument(r)),
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    // ═════════════════════════════════════════════════════════════════════════
    // REGISTRATION — RECORDING ACCEPTANCE
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Record that a company accepted the live terms and privacy policy.
     *
     * Called from the registration flow once the company row exists. Returns
     * what was recorded rather than throwing on a missing policy: a country
     * with no published document yet must not block signups, and the absence
     * is reported back so it shows up rather than passing silently.
     */
    async recordRegistrationAcceptance({
        company_id,
        country = null,
        accepted_by_user_id = null,
        accepted_by_name = null,
        accepted_by_email = null,
        ip_address = null,
        user_agent = null,
        acceptance_context = "registration",
        client = db,
    }) {
        const country_code = resolveCountryCode(country);
        const recorded = [];
        const missing = [];

        for (const policy_type of POLICY_TYPES) {
            const document = await PolicyDocument.findCurrent(policy_type, country_code);
            if (!document) {
                missing.push(policy_type);
                continue;
            }

            const row = await PolicyAcceptance.record(
                {
                    company_id,
                    policy_document_id: document.id,
                    policy_type,
                    policy_version: document.version,
                    country_code: document.country_code,
                    accepted_by_user_id,
                    accepted_by_name,
                    accepted_by_email,
                    acceptance_context,
                    ip_address,
                    user_agent,
                },
                client
            );

            recorded.push({
                policy_type,
                policy_document_id: document.id,
                version: document.version,
                accepted_at: row?.accepted_at || null,
            });
        }

        return { recorded, missing };
    },

    // ═════════════════════════════════════════════════════════════════════════
    // COMPANY — PROFILE VIEW & RE-ACCEPTANCE
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Everything the company profile's Legal tab renders: the live documents
     * for the company's country, what the company has accepted, and whether a
     * newer version is waiting.
     *
     * `pending` is computed rather than stored, so it stays correct without a
     * backfill every time a policy is published.
     */
    async getCompanyPolicyStatus(company_id) {
        try {
            const company = await CompanyModel.findById(company_id);
            if (!company) return { success: false, message: "Company not found" };

            const country_code =
                company.country_code || resolveCountryCode(company.country);

            const [current, accepted] = await Promise.all([
                PolicyDocument.findAllCurrentForCountry(country_code),
                PolicyAcceptance.latestByCompany(company_id),
            ]);

            const acceptedByType = {};
            for (const a of accepted) acceptedByType[a.policy_type] = a;

            const policies = current.map((doc) => {
                const acceptance = acceptedByType[doc.policy_type] || null;
                const isAccepted = acceptance?.policy_document_id === doc.id;

                return {
                    ...toPublicDocument(doc, { includeContent: false }),
                    accepted: isAccepted,
                    // Only nag when the new version actually asks for it. A
                    // typo fix is published with requires_reacceptance = false
                    // and shows as "updated", not as an outstanding action.
                    action_required: !isAccepted && doc.requires_reacceptance,
                    accepted_version: acceptance?.policy_version || null,
                    accepted_at: acceptance?.accepted_at || null,
                    accepted_by: acceptance?.accepted_by_name || null,
                };
            });

            return {
                success: true,
                data: {
                    company_id,
                    country: company.country,
                    country_code,
                    policies,
                    pending_acceptance: policies.filter((p) => p.action_required),
                },
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** Full content of one live policy, for the company's own country. */
    async getCompanyPolicyDocument(company_id, policy_type) {
        try {
            if (!POLICY_TYPES.includes(policy_type)) {
                return {
                    success: false,
                    message: `policy_type must be one of: ${POLICY_TYPES.join(", ")}`,
                };
            }

            const company = await CompanyModel.findById(company_id);
            if (!company) return { success: false, message: "Company not found" };

            const country_code =
                company.country_code || resolveCountryCode(company.country);

            const document = await PolicyDocument.findCurrent(policy_type, country_code);
            if (!document) {
                return {
                    success: false,
                    message: `No ${POLICY_LABEL[policy_type]} has been published for this country yet`,
                };
            }

            return { success: true, data: toPublicDocument(document) };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /**
     * A company admin accepting a newly published version from the profile.
     *
     * The version accepted is always the one currently live — the client sends
     * the document id it displayed, and a mismatch is rejected rather than
     * silently recorded, so an admin who left the tab open overnight cannot
     * accept a document that has since been superseded.
     */
    async acceptPolicy({
        company_id,
        policy_type,
        policy_document_id = null,
        accepted_by_user_id = null,
        accepted_by_name = null,
        accepted_by_email = null,
        ip_address = null,
        user_agent = null,
    }) {
        try {
            if (!POLICY_TYPES.includes(policy_type)) {
                return {
                    success: false,
                    message: `policy_type must be one of: ${POLICY_TYPES.join(", ")}`,
                };
            }

            const company = await CompanyModel.findById(company_id);
            if (!company) return { success: false, message: "Company not found" };

            const country_code =
                company.country_code || resolveCountryCode(company.country);

            const document = await PolicyDocument.findCurrent(policy_type, country_code);
            if (!document) {
                return {
                    success: false,
                    message: `No ${POLICY_LABEL[policy_type]} has been published for this country yet`,
                };
            }

            if (policy_document_id && policy_document_id !== document.id) {
                return {
                    success: false,
                    message:
                        "This document has been superseded. Reload the page and review the current version before accepting.",
                    code: "POLICY_SUPERSEDED",
                };
            }

            const row = await PolicyAcceptance.record({
                company_id,
                policy_document_id: document.id,
                policy_type,
                policy_version: document.version,
                country_code: document.country_code,
                accepted_by_user_id,
                accepted_by_name,
                accepted_by_email,
                acceptance_context: "reacceptance",
                ip_address,
                user_agent,
            });

            return {
                success: true,
                message: `${POLICY_LABEL[policy_type]} v${document.version} accepted`,
                data: row,
            };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },

    /** The company's own acceptance history — its copy of the audit trail. */
    async getCompanyAcceptances(company_id, { policy_type = null } = {}) {
        try {
            const rows = await PolicyAcceptance.listByCompany(company_id, { policy_type });
            return { success: true, data: rows };
        } catch (error) {
            return { success: false, message: error.message, error };
        }
    },
};

module.exports = { PolicyService, POLICY_TYPES, POLICY_LABEL };
