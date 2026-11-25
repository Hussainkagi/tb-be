// middleware/verifyToken.js
const { verifyAccessToken } = require("../utils/jwt");

const verifyToken = (req, res, next) => {
    const authHeader = req.headers["authorization"];

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
            success: false,
            message: "Access denied. No token provided.",
        });
    }

    const token = authHeader.split(" ")[1];

    try {
        const decoded = verifyAccessToken(token);
        // Staff sessions carry no `typ`. Anything typed — a recruitment
        // client's token (only valid on /api/recruitment-client) or an agency
        // signup's setup token — is signed with the same secret but must
        // never open a staff route.
        if (decoded?.typ) {
            return res.status(401).json({ success: false, message: "Invalid token." });
        }
        req.user = decoded;
        next();
    } catch (err) {
        if (err.name === "TokenExpiredError") {
            return res.status(401).json({
                success: false,
                message: "Token has expired. Please log in again.",
            });
        }
        return res.status(401).json({
            success: false,
            message: "Invalid token.",
        });
    }
};

module.exports = verifyToken;