/**
 * File storage — Cloudflare R2 (private bucket) for new uploads, Cloudinary
 * kept for everything already stored there.
 *
 * Layout inside the bucket:
 *
 *   teambook-hr/<company>/attendance/<YYYY-MM-DD>/<EMP>-check-in-<HHmmss>.jpg
 *   teambook-hr/<company>/tasks/<task-title>-<id>/images/<file>
 *   teambook-hr/<company>/tasks/<task-title>-<id>/files/<file>
 *   teambook-hr/<company>/leave/<EMP>/<YYYY-MM-DD>-<file>
 *   teambook-hr/<company>/support-tickets/<ticket-id>/image-<n>.<ext>
 *   teambook-sourcing/<agency>/logo/logo-<ts>.<ext>
 *   teambook-sourcing/<agency>/jobs/<job-title>-<id>/cvs/<candidate>-<ts>.<ext>
 *   teambook-platform/policies/<type>/<country>/<file>          (not per company)
 *   teambook-sourcing/candidates/<person>/cvs/<file>            (job seekers; not per company)
 *
 * <company> is "<name-slug>-<first 8 of id>": readable, unique even when two
 * companies share a name, and stable when a company is renamed.
 *
 * The database stores "r2://<key>" for R2 files (in the same url/public_id
 * columns Cloudinary used). Nothing in the bucket is public: an API response
 * that carries an r2:// value has it swapped for a short-lived signed URL by
 * the signStorageUrls middleware, so every existing screen keeps working.
 *
 * Until the R2 env vars are set, uploads fall back to Cloudinary exactly as
 * before — deploying this changes nothing until R2 is configured.
 *
 * Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
 *      R2_SIGNED_URL_TTL (seconds, default 3600)
 */
const crypto = require("crypto");
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const db = require("../config/database");
const cloud = require("./cloudinaryHelper");

const REF = "r2://";
const ROOTS = { hr: "teambook-hr", sourcing: "teambook-sourcing", platform: "teambook-platform", candidates: "teambook-sourcing/candidates" };

const env = () => ({
    account: process.env.R2_ACCOUNT_ID,
    key: process.env.R2_ACCESS_KEY_ID,
    secret: process.env.R2_SECRET_ACCESS_KEY,
    bucket: process.env.R2_BUCKET,
    ttl: Math.max(60, Number(process.env.R2_SIGNED_URL_TTL) || 3600),
});

const r2Enabled = () => {
    const e = env();
    return Boolean(e.account && e.key && e.secret && e.bucket);
};

let client = null;
function s3() {
    if (!client) {
        const e = env();
        client = new S3Client({
            region: "auto",
            endpoint: `https://${e.account}.r2.cloudflarestorage.com`,
            credentials: { accessKeyId: e.key, secretAccessKey: e.secret },
        });
    }
    return client;
}

// ── Names ────────────────────────────────────────────────────────────────────

function slug(text, max = 50) {
    return String(text || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, max)
        .replace(/-+$/g, "");
}

const shortId = (id) => String(id || "").replace(/-/g, "").slice(0, 8);
const stamp = () => `${Date.now()}${crypto.randomBytes(2).toString("hex")}`;

/** "invoice final (2).pdf" → "invoice-final-2.pdf" (keeps a safe extension). */
function fileName(original, fallbackExt = "bin") {
    const raw = String(original || "");
    const dot = raw.lastIndexOf(".");
    const ext = (dot > 0 ? raw.slice(dot + 1) : fallbackExt).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || fallbackExt;
    const base = slug(dot > 0 ? raw.slice(0, dot) : raw, 60) || "file";
    return `${base}.${ext}`;
}

const companyFolders = new Map();
/** "<name-slug>-<id8>", cached per process. */
async function companyFolder(company_id) {
    if (companyFolders.has(company_id)) return companyFolders.get(company_id);
    const { rows } = await db.query(`SELECT company_name FROM companies WHERE id = $1`, [company_id]);
    const folder = `${slug(rows[0]?.company_name, 40) || "company"}-${shortId(company_id)}`;
    companyFolders.set(company_id, folder);
    return folder;
}

/** Best-effort content type from the bytes, for buffers that arrive without one. */
function sniff(buffer) {
    const b = buffer;
    if (!b || b.length < 4) return "application/octet-stream";
    if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
    if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
    if (b.toString("ascii", 0, 4) === "%PDF") return "application/pdf";
    if (b.toString("ascii", 4, 8) === "ftyp") return "image/heic";
    return "application/octet-stream";
}

/** By extension, for documents the byte sniff can't tell apart (docx/xlsx are zips). */
const TYPE_BY_EXT = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    txt: "text/plain",
    csv: "text/csv",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    svg: "image/svg+xml",
};

const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "application/pdf": "pdf" };
const extFor = (contentType) => EXT[contentType] || "bin";

// ── R2 primitives ────────────────────────────────────────────────────────────

const isR2Ref = (v) => typeof v === "string" && v.startsWith(REF);
const keyOf = (ref) => ref.slice(REF.length);

/**
 * A signed URL for one of our own R2 files (as handed out in API responses),
 * turned back into its permanent "r2://<key>" ref. Anything else comes back
 * unchanged — so a form can round-trip a value it was given without saving a
 * link that expires.
 */
function toStoredRef(value) {
    if (typeof value !== "string" || !value.startsWith("https://") || !r2Enabled()) return value;
    try {
        const u = new URL(value);
        const { account, bucket } = env();
        const host = `${account}.r2.cloudflarestorage.com`.toLowerCase();
        let key = null;
        if (u.hostname.toLowerCase() === `${bucket}.${host}`.toLowerCase()) key = u.pathname.slice(1);
        else if (u.hostname.toLowerCase() === host && u.pathname.startsWith(`/${bucket}/`)) key = u.pathname.slice(bucket.length + 2);
        return key ? REF + decodeURIComponent(key) : value;
    } catch {
        return value;
    }
}

async function put(key, body, contentType) {
    await s3().send(
        new PutObjectCommand({ Bucket: env().bucket, Key: key, Body: body, ContentType: contentType }),
    );
    return `${REF}${key}`;
}

/** A short-lived GET link. `downloadName` makes the browser save it under that name. */
async function signedUrl(ref, { downloadName, inline = true, expiresIn } = {}) {
    const disposition = downloadName
        ? `${inline ? "inline" : "attachment"}; filename="${String(downloadName).replace(/[^\w.\- ]/g, "_")}"`
        : undefined;
    return getSignedUrl(
        s3(),
        new GetObjectCommand({ Bucket: env().bucket, Key: keyOf(ref), ResponseContentDisposition: disposition }),
        { expiresIn: expiresIn ?? env().ttl },
    );
}

/** Deep-copies `value`, replacing every r2:// string with a signed URL. */
async function signAll(value) {
    const refs = new Set();
    const walk = (v) => {
        if (isR2Ref(v)) refs.add(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) Object.values(v).forEach(walk);
    };
    walk(value);
    if (!refs.size) return value;

    const signed = new Map(await Promise.all([...refs].map(async (r) => [r, await signedUrl(r)])));
    const swap = (v) => {
        if (isR2Ref(v)) return signed.get(v);
        if (Array.isArray(v)) return v.map(swap);
        if (v && typeof v === "object" && !(v instanceof Date) && !Buffer.isBuffer(v)) {
            const out = {};
            for (const [k, x] of Object.entries(v)) out[k] = swap(x);
            return out;
        }
        return v;
    };
    return swap(value);
}

// ── What the services call ───────────────────────────────────────────────────

/**
 * Upload a file. With R2 configured it lands at
 *   <root>/<company folder>/<...path>/<name>
 * otherwise it goes to Cloudinary with the `cloudinary` options (old layout).
 *
 * Returns the same shape uploadToCloudinary did, so call sites store
 * `secureUrl` / `publicId` exactly as before.
 *
 * @param {Buffer} buffer
 * @param {object} o
 * @param {"hr"|"sourcing"|"platform"} o.area
 * @param {string} [o.companyId]        required for hr / sourcing
 * @param {string[]} o.path             folders under the company folder
 * @param {string} o.name               file name (made safe; keep the extension)
 * @param {string} [o.contentType]      sniffed from the bytes when omitted
 * @param {object} o.cloudinary         uploadToCloudinary options for the fallback
 */
async function uploadFile(buffer, { area, companyId, path = [], name, contentType, cloudinary }) {
    if (!r2Enabled()) return cloud.uploadToCloudinary(buffer, cloudinary);

    let type = contentType || sniff(buffer);
    if (type === "application/octet-stream") type = TYPE_BY_EXT[name.split(".").pop().toLowerCase()] || type;
    const company = area === "platform" || area === "candidates" ? null : await companyFolder(companyId);
    const key = [ROOTS[area], company, ...path.map((p) => String(p)), name].filter(Boolean).join("/");
    const ref = await put(key, buffer, type);
    return { url: ref, secureUrl: ref, publicId: ref, format: name.split(".").pop(), duration: undefined };
}

/** Delete by stored public id — R2 or Cloudinary, whichever holds it. */
async function deleteFile(publicId, resourceType = "image") {
    if (!publicId) return;
    if (isR2Ref(publicId)) {
        await s3().send(new DeleteObjectCommand({ Bucket: env().bucket, Key: keyOf(publicId) }));
        return;
    }
    return cloud.deleteFromCloudinary(publicId, resourceType);
}

/** A link the server (or a client) can download the file from, for either store. */
async function downloadUrl(publicId, { resourceType = "image", format = "", name } = {}) {
    if (isR2Ref(publicId)) return signedUrl(publicId, { downloadName: name });
    return cloud.privateDownloadUrl(publicId, { resourceType, format });
}

module.exports = {
    r2Enabled,
    uploadFile,
    deleteFile,
    downloadUrl,
    signAll,
    signedUrl,
    isR2Ref,
    toStoredRef,
    // naming helpers for call sites
    slug,
    shortId,
    stamp,
    fileName,
    sniff,
    extFor,
};
