const multer = require("multer");

/**
 * Upload guard for policy documents (Terms & Conditions, Privacy Policy).
 *
 * Word documents only. The check is deliberately on BOTH the extension and the
 * MIME type: browsers send the .docx type inconsistently (and some send
 * application/octet-stream for a perfectly valid file), while the extension
 * alone is trivial to fake. Either signal being right is enough to accept —
 * the real verification happens downstream, where parseDocx() refuses anything
 * that is not a readable Word package.
 *
 * The legacy binary .doc format is rejected with its own message rather than a
 * generic one: it is not a ZIP, the parser cannot read it, and telling the
 * uploader to "Save As .docx" is more useful than "invalid file type".
 */

const DOCX_MIME =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const ACCEPTED_MIMES = [DOCX_MIME, "application/octet-stream"];

// 15MB. A T&C document with images sits well under this; anything larger is a
// mistake worth catching at the edge instead of in the parser.
const MAX_FILE_SIZE = 15 * 1024 * 1024;

const uploadPolicyDocument = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_SIZE, files: 1 },
    fileFilter(_req, file, cb) {
        const name = (file.originalname || "").toLowerCase();

        if (name.endsWith(".doc")) {
            return cb(
                new Error(
                    "The legacy .doc format cannot be read. Open the file in Word and use Save As → .docx."
                ),
                false
            );
        }

        const okExtension = name.endsWith(".docx");
        const okMime = ACCEPTED_MIMES.includes(file.mimetype);

        if (!okExtension && !okMime) {
            return cb(
                new Error("Only Word documents (.docx) are accepted for policy uploads"),
                false
            );
        }

        return cb(null, true);
    },
});

/**
 * Turns multer's own failures into the API's error envelope.
 * Mount immediately after the routes that use the uploader — without it,
 * an oversized file surfaces as an unhandled 500.
 */
const handlePolicyUploadError = (err, _req, res, next) => {
    if (!err) return next();

    if (err instanceof multer.MulterError) {
        const message =
            err.code === "LIMIT_FILE_SIZE"
                ? `The document is too large. Maximum size is ${MAX_FILE_SIZE / (1024 * 1024)}MB.`
                : err.code === "LIMIT_UNEXPECTED_FILE"
                    ? "Unexpected upload field. Send the document as 'file'."
                    : err.message;

        return res.status(400).json({ success: false, message });
    }

    // fileFilter rejections arrive as plain Errors carrying our own message.
    if (/\.docx|\.doc format/i.test(err.message || "")) {
        return res.status(400).json({ success: false, message: err.message });
    }

    return next(err);
};

module.exports = { uploadPolicyDocument, handlePolicyUploadError, MAX_FILE_SIZE };
