const db = require("../config/database");

const OtpVerification = {
    async create(data) {
        const { user_id, company_id = null, type, token, expires_at } = data;

        // Invalidate any existing unused OTPs of same type for this user+company
        await db.query(
            `UPDATE otp_verifications
             SET verified_at = NOW()
             WHERE user_id = $1
               AND type = $2
               AND company_id IS NOT DISTINCT FROM $3
               AND verified_at IS NULL`,
            [user_id, type, company_id]
        );

        const result = await db.query(
            `INSERT INTO otp_verifications (user_id, company_id, type, token, expires_at)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [user_id, company_id, type, token, expires_at]
        );
        return result.rows[0];
    },

    async findByToken(token) {
        const result = await db.query(
            `SELECT * FROM otp_verifications
             WHERE token = $1
               AND verified_at IS NULL
               AND expires_at > NOW()`,
            [token]
        );
        return result.rows[0];
    },

    async markVerified(id) {
        const result = await db.query(
            `UPDATE otp_verifications SET verified_at = NOW()
             WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    },

    async deleteExpired() {
        await db.query(
            `DELETE FROM otp_verifications WHERE expires_at < NOW()`
        );
    },
};

module.exports = OtpVerification;