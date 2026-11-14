/**
 * No-auth recruitment endpoints:
 *
 *   /api/public/jobs            the public job portal (list, facets, detail, apply)
 *   /api/recruitment-client     the agency's clients (login + their portal)
 *
 * Mounted in server.js BEFORE the activity logger and company-active guard:
 * anonymous applications are not staff activity, and a client token carries
 * no company to check.
 */
const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");

const { verifyClientToken } = require("../../middleware/verifyClientToken");
const { PublicController: P, ClientController: C } = require("../../controller/Recruitment/recruitmentController");
const { CV_TYPES, CV_MAX_BYTES } = require("../../service/Recruitment/recruitmentShared");

// Behind a proxy every request shares one socket IP, so key on the first
// forwarded address when there is one.
const clientIp = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip;
const limiter = (windowMinutes, limit, message) =>
    rateLimit({
        windowMs: windowMinutes * 60 * 1000,
        limit,
        keyGenerator: clientIp,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        validate: false,
        message: { success: false, message },
    });

const cvUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: CV_MAX_BYTES, files: 1, fields: 60 },
    fileFilter(_req, file, cb) {
        CV_TYPES[file.mimetype] ? cb(null, true) : cb(new Error("CV must be a PDF or Word document"));
    },
});

/** multer errors (too big, wrong type) as a normal 422, not a 500. */
const acceptCv = (req, res, next) =>
    cvUpload.single("cv")(req, res, (err) => {
        if (!err) return next();
        const message = err.code === "LIMIT_FILE_SIZE" ? "CV must be 5 MB or smaller" : err.message;
        return res.status(422).json({ success: false, message, errors: { cv: message } });
    });

// ── Public job portal ───────────────────────────────────────────────────────
const publicRouter = express.Router();
publicRouter.use(limiter(1, 120, "Too many requests. Please slow down."));
publicRouter.get("/", P.list);
publicRouter.get("/facets", P.facets);
publicRouter.get("/sitemap", P.sitemap);
publicRouter.get("/:slug", P.get);
publicRouter.post("/:slug/apply", limiter(15, 15, "Too many applications from this network. Please try again later."), acceptCv, P.apply);

// ── Client portal ───────────────────────────────────────────────────────────
const clientRouter = express.Router();
clientRouter.post("/auth/login", limiter(15, 20, "Too many sign-in attempts. Please wait a few minutes."), C.login);

clientRouter.use(verifyClientToken);
clientRouter.get("/me", C.me);
clientRouter.put("/me/password", C.changePassword);
clientRouter.get("/jobs", C.listJobs);
clientRouter.post("/jobs", C.requestJob);
clientRouter.get("/jobs/:id", C.getJob);
clientRouter.get("/candidates", C.listCandidates);
clientRouter.patch("/candidates/:appId", C.decide);
clientRouter.get("/candidates/:appId/cv", C.downloadCv);

module.exports = { publicRouter, clientRouter };
