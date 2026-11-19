/**
 * /api/auth/agency — public sign-up and sign-in for recruitment agencies.
 * See service/agencyOnboardingService.js for the flow and the rules.
 */
const express = require("express");
const rateLimit = require("express-rate-limit");
const AgencyOnboardingService = require("../service/agencyOnboardingService");

const router = express.Router();

// Behind a proxy every request shares one socket IP — key on the forwarded one.
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

const sendsEmail = limiter(15, 8, "Too many codes requested — try again in a few minutes");
const signIn = limiter(15, 30, "Too many attempts — try again in a few minutes");

const handle = (fn) => async (req, res) => {
    try {
        const { status, ...result } = await fn(req);
        return res.status(status || (result.success ? 200 : 400)).json(result);
    } catch (error) {
        console.error("[AgencyAuth]", error);
        return res.status(500).json({ success: false, message: "Something went wrong — please try again" });
    }
};

const meta = (req) => ({
    ip_address: clientIp(req) || null,
    user_agent: req.headers["user-agent"] || null,
});

router.post("/signup", sendsEmail, handle((req) => AgencyOnboardingService.signupStart(req.body || {})));
router.post("/signup/resend", sendsEmail, handle((req) => AgencyOnboardingService.signupResend(req.body || {})));
router.post("/signup/verify", signIn, handle((req) => AgencyOnboardingService.signupVerify(req.body || {})));
router.post("/google", signIn, handle((req) => AgencyOnboardingService.google(req.body || {})));
router.post("/setup", signIn, handle((req) => AgencyOnboardingService.setup(req.body || {}, meta(req))));
router.post("/login", signIn, handle((req) => AgencyOnboardingService.login(req.body || {})));

// One-time workspace link (agency → teamBook HRMS) → a normal session.
const WorkspaceSwitchService = require("../service/workspaceSwitchService");
router.post("/switch/redeem", signIn, handle((req) => WorkspaceSwitchService.redeem(req.body?.token)));

module.exports = router;
