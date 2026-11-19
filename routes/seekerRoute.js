/**
 * /api/seeker — job seekers on the public job board.
 *
 *   /auth/*   sign up / sign in (email code, Google)          — public
 *   the rest  profile, CVs, saved, drafts, applications, apply — signed in
 */
const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const SeekerAuthService = require("../service/Seeker/seekerAuthService");
const SeekerService = require("../service/Seeker/seekerService");
const verifySeekerToken = require("../middleware/verifySeekerToken");

const router = express.Router();

const clientIp = (req) => String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip;
const limiter = (minutes, limit, message, key = clientIp) =>
    rateLimit({
        windowMs: minutes * 60 * 1000,
        limit,
        keyGenerator: key,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        validate: false,
        message: { success: false, message },
    });
const sendsEmail = limiter(15, 8, "Too many codes requested — try again in a few minutes");
const signIn = limiter(15, 30, "Too many attempts — try again in a few minutes");
// CV reading is a paid call — per account, generous for real use.
const cvLimiter = limiter(60, 20, "Too many CV uploads — try again later", (req) => `cv:${req.seeker_id}`);

const cvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

const handle = (fn) => async (req, res) => {
    try {
        const { status, ...result } = await fn(req);
        return res.status(status || (result.success ? 200 : 400)).json(result);
    } catch (error) {
        console.error("[seeker]", error);
        return res.status(500).json({ success: false, message: "Something went wrong — please try again" });
    }
};
const sid = (req) => req.seeker_id;

// ── Public ───────────────────────────────────────────────────────────────────
router.post("/auth/start", sendsEmail, handle((req) => SeekerAuthService.start(req.body || {})));
router.post("/auth/verify", signIn, handle((req) => SeekerAuthService.verify(req.body || {})));
router.post("/auth/google", signIn, handle((req) => SeekerAuthService.google(req.body || {})));

// ── Signed in ────────────────────────────────────────────────────────────────
router.use(verifySeekerToken);

router.get("/me", handle((req) => SeekerService.me(sid(req))));
router.put("/me", handle((req) => SeekerService.updateProfile(sid(req), req.body || {})));

router.get("/cvs", handle((req) => SeekerService.listCvs(sid(req))));
router.post("/cvs", cvLimiter, cvUpload.single("cv"), handle((req) => SeekerService.uploadCv(sid(req), req.file)));
router.put("/cvs/:id/default", handle((req) => SeekerService.setDefaultCv(sid(req), req.params.id)));
router.delete("/cvs/:id", handle((req) => SeekerService.deleteCv(sid(req), req.params.id)));

router.get("/saved", handle((req) => SeekerService.listSaved(sid(req))));
router.get("/saved/slugs", handle((req) => SeekerService.savedIds(sid(req))));
router.post("/saved/:slug", handle((req) => SeekerService.save(sid(req), req.params.slug)));
router.delete("/saved/:slug", handle((req) => SeekerService.unsave(sid(req), req.params.slug)));

router.get("/applications", handle((req) => SeekerService.listApplications(sid(req))));

router.get("/drafts", handle((req) => SeekerService.listDrafts(sid(req))));
router.put("/drafts/:slug", handle((req) => SeekerService.saveDraft(sid(req), req.params.slug, req.body || {})));
router.delete("/drafts/:slug", handle((req) => SeekerService.deleteDraft(sid(req), req.params.slug)));

router.get("/jobs/:slug/apply", handle((req) => SeekerService.applyContext(sid(req), req.params.slug)));
router.post("/jobs/:slug/apply", signIn, handle((req) => SeekerService.apply(sid(req), req.params.slug, req.body || {})));

module.exports = router;
