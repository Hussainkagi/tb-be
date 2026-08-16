/**
 * Minimal .docx → HTML converter.
 *
 * A .docx is a ZIP holding XML. Both halves are handled here with Node
 * built-ins (`zlib` for the deflate streams, string parsing for the XML)
 * rather than pulling in mammoth/adm-zip, because the module needs exactly one
 * thing — turn Legal's Word file into renderable HTML at upload time — and a
 * parser we own is a parser we can debug when a document renders oddly.
 *
 * Scope is deliberately narrow: headings, paragraphs, bold/italic/underline,
 * bullet and numbered lists, hyperlinks, and tables. That covers a terms &
 * conditions document. Images, footnotes and floating shapes are dropped —
 * the original file is kept on Cloudinary for anyone who needs the real thing.
 */

const zlib = require("zlib");

// ─────────────────────────────────────────────────────────────────────────────
// ZIP reading
// ─────────────────────────────────────────────────────────────────────────────

const SIG_EOCD = 0x06054b50;   // End of central directory
const SIG_CEN = 0x02014b50;    // Central directory file header
const SIG_LOC = 0x04034b50;    // Local file header

/**
 * Locate the End-Of-Central-Directory record. It sits at the tail of the file
 * but may be followed by up to 64KB of comment, so scan backwards.
 */
function findEocd(buf) {
    const minPos = Math.max(0, buf.length - 0xffff - 22);
    for (let i = buf.length - 22; i >= minPos; i--) {
        if (buf.readUInt32LE(i) === SIG_EOCD) return i;
    }
    return -1;
}

/**
 * Read a ZIP archive into a { filename → Buffer } map.
 * Only the two compression methods Word actually emits are supported:
 * 0 (stored) and 8 (deflate).
 */
function readZipEntries(buf) {
    const eocd = findEocd(buf);
    if (eocd < 0) throw new Error("Not a valid .docx file (no ZIP directory found)");

    const entryCount = buf.readUInt16LE(eocd + 10);
    let ptr = buf.readUInt32LE(eocd + 16);

    const entries = {};

    for (let n = 0; n < entryCount; n++) {
        if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== SIG_CEN) break;

        const method = buf.readUInt16LE(ptr + 10);
        const compressedSize = buf.readUInt32LE(ptr + 20);
        const nameLen = buf.readUInt16LE(ptr + 28);
        const extraLen = buf.readUInt16LE(ptr + 30);
        const commentLen = buf.readUInt16LE(ptr + 32);
        const localOffset = buf.readUInt32LE(ptr + 42);
        const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);

        // The local header repeats the name and carries its own extra field,
        // which is usually a different length from the central one — the data
        // offset has to be computed from the local header, not the central.
        if (buf.readUInt32LE(localOffset) === SIG_LOC) {
            const locNameLen = buf.readUInt16LE(localOffset + 26);
            const locExtraLen = buf.readUInt16LE(localOffset + 28);
            const dataStart = localOffset + 30 + locNameLen + locExtraLen;
            const raw = buf.subarray(dataStart, dataStart + compressedSize);

            try {
                if (method === 0) entries[name] = Buffer.from(raw);
                else if (method === 8) entries[name] = zlib.inflateRawSync(raw);
            } catch {
                // A single unreadable part (a font, a thumbnail) must not fail
                // the whole document — only word/document.xml is required.
            }
        }

        ptr += 46 + nameLen + extraLen + commentLen;
    }

    return entries;
}

// ─────────────────────────────────────────────────────────────────────────────
// XML helpers
// ─────────────────────────────────────────────────────────────────────────────

const decodeXml = (s) =>
    s
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&amp;/g, "&");

const escapeHtml = (s) =>
    s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

/** Value of a `w:val`-style attribute on the first matching tag. */
const attrOf = (xml, tag, attr = "w:val") => {
    const m = xml.match(new RegExp(`<${tag}\\b[^>]*\\s${attr}="([^"]*)"`));
    return m ? m[1] : null;
};

/** True when the toggle element is present and not explicitly switched off. */
const hasToggle = (xml, tag) => {
    const m = xml.match(new RegExp(`<${tag}\\b([^>]*)/?>`));
    if (!m) return false;
    return !/\sw:val="(0|false|off)"/.test(m[1]);
};

/** All occurrences of `<tag …>…</tag>` (and self-closing `<tag/>`), in order. */
function matchBlocks(xml, tag) {
    const out = [];
    const re = new RegExp(`<${tag}\\b[^>]*/>|<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, "g");
    let m;
    while ((m = re.exec(xml)) !== null) out.push(m[0]);
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Document conversion
// ─────────────────────────────────────────────────────────────────────────────

/** Relationship id → target URL, for hyperlinks. */
function readRelationships(entries) {
    const rels = {};
    const xml = entries["word/_rels/document.xml.rels"]?.toString("utf8");
    if (!xml) return rels;

    const re = /<Relationship\b[^>]*>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const id = m[0].match(/\sId="([^"]*)"/)?.[1];
        const target = m[0].match(/\sTarget="([^"]*)"/)?.[1];
        if (id && target) rels[id] = decodeXml(target);
    }
    return rels;
}

/**
 * numId → list format ("bullet" | "decimal" | …), read from numbering.xml.
 *
 * Word stores the marker style two hops away from the paragraph: the paragraph
 * cites a numId, numId maps to an abstractNumId, and the abstract definition
 * carries the numFmt per indent level. Only level 0 is read — deeper levels
 * would need real nesting, which a policy document does not use.
 */
function readNumbering(entries) {
    const xml = entries["word/numbering.xml"]?.toString("utf8");
    if (!xml) return {};

    const abstractFmt = {};
    for (const block of matchBlocks(xml, "w:abstractNum")) {
        const abstractId = block.match(/w:abstractNumId="(\d+)"/)?.[1];
        if (!abstractId) continue;
        const lvl0 = matchBlocks(block, "w:lvl")[0] || block;
        abstractFmt[abstractId] = attrOf(lvl0, "w:numFmt") || "decimal";
    }

    const byNumId = {};
    for (const block of matchBlocks(xml, "w:num")) {
        const numId = block.match(/<w:num\b[^>]*w:numId="(\d+)"/)?.[1];
        const abstractId = attrOf(block, "w:abstractNumId");
        if (numId) byNumId[numId] = abstractFmt[abstractId] || "decimal";
    }
    return byNumId;
}

/**
 * Render the runs inside one paragraph (or table cell) to inline HTML.
 * Hyperlinks are unwrapped to <a>; everything else keeps its run formatting.
 */
function renderInline(xml, rels) {
    let out = "";

    // Walk runs and hyperlink wrappers in document order.
    const re = /<w:hyperlink\b[^>]*>[\s\S]*?<\/w:hyperlink>|<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
    let m;

    while ((m = re.exec(xml)) !== null) {
        const chunk = m[0];

        if (chunk.startsWith("<w:hyperlink")) {
            const relId = chunk.match(/r:id="([^"]*)"/)?.[1];
            const anchor = chunk.match(/w:anchor="([^"]*)"/)?.[1];
            const inner = renderInline(chunk, rels);
            if (!inner.trim()) continue;

            const href = relId ? rels[relId] : anchor ? `#${anchor}` : null;
            out += href
                ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
                : inner;
            continue;
        }

        // Run properties live in <w:rPr> — read them before the text so a
        // <w:t> containing the literal word "b" is never mistaken for bold.
        const rPr = chunk.match(/<w:rPr>[\s\S]*?<\/w:rPr>/)?.[0] || "";
        const bold = hasToggle(rPr, "w:b");
        const italic = hasToggle(rPr, "w:i");
        const underline = !!attrOf(rPr, "w:u") && attrOf(rPr, "w:u") !== "none";

        let text = "";
        const textRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g;
        let t;
        while ((t = textRe.exec(chunk)) !== null) {
            if (t[0].startsWith("<w:tab")) text += " ";
            else if (t[0].startsWith("<w:br")) text += "<br />";
            else text += escapeHtml(decodeXml(t[1]));
        }

        if (!text) continue;
        if (bold) text = `<strong>${text}</strong>`;
        if (italic) text = `<em>${text}</em>`;
        if (underline) text = `<u>${text}</u>`;
        out += text;
    }

    return out;
}

/**
 * Word has no list elements — a bullet is just a paragraph carrying a <w:numPr>
 * reference. Consecutive such paragraphs are stitched back into a single
 * <ul>/<ol> here, otherwise the rendered terms come out as a wall of orphan
 * lines with no visual nesting.
 */
function paragraphToHtml(pXml, rels) {
    const pPr = pXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/)?.[0] || "";
    const style = (attrOf(pPr, "w:pStyle") || "").toLowerCase();
    const inline = renderInline(pXml, rels);

    const numId = pPr.match(/<w:numPr>[\s\S]*?<\/w:numPr>/)
        ? attrOf(pPr, "w:numId") || "0"
        : null;

    if (!inline.trim()) return null;

    // Word numbers headings Heading1..Heading9. h1 is reserved for the policy
    // title the app renders above the content, so everything shifts down one.
    const headingMatch = style.match(/^heading(\d)$/);
    if (headingMatch) {
        const level = Math.min(Number(headingMatch[1]) + 1, 6);
        return { kind: "heading", html: `<h${level}>${inline}</h${level}>` };
    }
    if (style === "title") return { kind: "heading", html: `<h2>${inline}</h2>` };

    if (numId !== null || style === "listparagraph") {
        return { kind: "list-item", numId: numId || "list", html: `<li>${inline}</li>` };
    }

    return { kind: "paragraph", html: `<p>${inline}</p>` };
}

function tableToHtml(tblXml, rels) {
    const rows = matchBlocks(tblXml, "w:tr");
    if (!rows.length) return null;

    const body = rows
        .map((row) => {
            const cells = matchBlocks(row, "w:tc")
                .map((cell) => {
                    const content = matchBlocks(cell, "w:p")
                        .map((p) => renderInline(p, rels))
                        .filter(Boolean)
                        .join("<br />");
                    return `<td>${content}</td>`;
                })
                .join("");
            return `<tr>${cells}</tr>`;
        })
        .join("");

    return `<table>${body}</table>`;
}

/**
 * Convert a .docx buffer into HTML + plain text.
 *
 * @param {Buffer} buffer - Raw .docx file contents.
 * @returns {{ html: string, text: string, title: string|null }}
 *          `title` is the document's first heading, offered as a default when
 *          the uploader does not supply one.
 */
function parseDocx(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new Error("No file content to parse");
    }

    const entries = readZipEntries(buffer);
    const documentXml = entries["word/document.xml"]?.toString("utf8");
    if (!documentXml) {
        throw new Error("Could not read word/document.xml — the file is not a valid .docx");
    }

    const rels = readRelationships(entries);
    const numFmt = readNumbering(entries);
    const body = documentXml.match(/<w:body>[\s\S]*<\/w:body>/)?.[0] || documentXml;

    // Paragraphs and tables, in document order. w:p is matched non-greedily so
    // a paragraph nested inside a table cell is consumed by the table branch.
    const blockRe = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;

    const parts = [];
    let openList = null; // { numId, items: [] }

    const closeList = () => {
        if (!openList) return;
        // A paragraph styled ListParagraph but carrying no numPr has no
        // definition to look up; it renders as a bullet, which is what Word
        // shows for it too.
        const fmt = numFmt[openList.numId] || "bullet";
        const tag = fmt === "bullet" ? "ul" : "ol";
        parts.push(`<${tag}>${openList.items.join("")}</${tag}>`);
        openList = null;
    };

    let m;
    while ((m = blockRe.exec(body)) !== null) {
        const block = m[0];

        if (block.startsWith("<w:tbl")) {
            closeList();
            const html = tableToHtml(block, rels);
            if (html) parts.push(html);
            continue;
        }

        const para = paragraphToHtml(block, rels);
        if (!para) continue;

        if (para.kind === "list-item") {
            if (openList && openList.numId !== para.numId) closeList();
            if (!openList) openList = { numId: para.numId, items: [] };
            openList.items.push(para.html);
            continue;
        }

        closeList();
        parts.push(para.html);
    }
    closeList();

    const html = parts.join("\n");
    if (!html.trim()) {
        throw new Error("The document appears to be empty — no readable text was found");
    }

    const text = html
        .replace(/<\/(p|h[1-6]|li|tr|table)>/g, "\n")
        .replace(/<br\s*\/?>/g, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    // Legal documents usually open with the title as a bold paragraph rather
    // than a styled heading, so the opening lines are checked first and only
    // then the first real heading — otherwise the suggested title comes back
    // as "1. Introduction and Acceptance of Terms".
    const plain = (p) => p.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const opener = parts
        .slice(0, 3)
        .find((p) => /^<p>/.test(p) && plain(p).length > 0 && plain(p).length <= 120);
    const title = plain(opener || parts.find((p) => /^<h[12]>/.test(p)) || "") || null;

    return { html, text, title };
}

module.exports = { parseDocx };
