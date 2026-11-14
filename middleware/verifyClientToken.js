/**
 * Tokens for recruitment CLIENT logins (an agency's customers).
 *
 * They are signed with the same secret as staff tokens but carry
 * `typ: "recruitment_client"` and no company_id/role, and verifyToken refuses
 * them outright — so a client token can only ever reach /api/recruitment-client.
 */
const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret_key";
const CLIENT_TOKEN_TYPE = "recruitment_client";

function signClientToken({ client_user_id, client_id, agency_company_id }) {
    return jwt.sign(
        { typ: CLIENT_TOKEN_TYPE, client_user_id, client_id, agency_company_id },
        JWT_SECRET,
        { expiresIn: "7d" },
    );
}

function verifyClientToken(req, res, next) {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
        return res.status(401).json({ success: false, message: "Please sign in." });
    }
    try {
        const decoded = jwt.verify(header.slice(7), JWT_SECRET);
        if (decoded.typ !== CLIENT_TOKEN_TYPE || !decoded.client_id) throw new Error("wrong token type");
        req.client = decoded;
        next();
    } catch (err) {
        return res.status(401).json({
            success: false,
            message: err.name === "TokenExpiredError" ? "Your session has expired. Please sign in again." : "Invalid session.",
        });
    }
}

module.exports = { signClientToken, verifyClientToken, CLIENT_TOKEN_TYPE };
