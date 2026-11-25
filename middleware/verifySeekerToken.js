/**
 * Job seeker routes only. Accepts a "job_seeker" token (see seekerAuthService)
 * and nothing else — a staff or client token is refused here, just as a seeker
 * token is refused by verifyToken on staff routes.
 */
const SeekerAuthService = require("../service/Seeker/seekerAuthService");

module.exports = function verifySeekerToken(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const seekerId = SeekerAuthService.readToken(token);
    if (!seekerId) return res.status(401).json({ success: false, message: "Please sign in to continue" });
    req.seeker_id = seekerId;
    next();
};
