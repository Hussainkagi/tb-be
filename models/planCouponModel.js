const db = require("../config/database");

/**
 * Upgrade coupons — the offline payment bridge.
 *
 * Flow: customer emails us → payment settled outside the app → Super Admin
 * mints a code bound to that company → company admin redeems it in-app.
 *
 * The redemption path is the only place in this module where correctness under
 * concurrency matters, so it runs in a transaction with SELECT ... FOR UPDATE
 * on the coupon row. Two simultaneous submits of the same code (a double-click,
 * a retried request) serialise: the second one finds status = 'redeemed' and is
 * rejected, instead of both reading 'active' and stacking two subscriptions.
 */

const PlanCouponModel = {
    async create(data) {
        const {
            code, company_id, plan_id,
            valid_from, valid_until, duration_days = null,
            notes = null, created_by = null,
        } = data;

        const result = await db.query(
            `INSERT INTO plan_coupons (
                code, company_id, plan_id,
                valid_from, valid_until, duration_days,
                notes, created_by
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             RETURNING *`,
            [code, company_id, plan_id, valid_from, valid_until,
             duration_days, notes, created_by]
        );
        return result.rows[0];
    },

    async findByCode(code) {
        const result = await db.query(
            `SELECT c.*, p.code AS plan_code, p.name AS plan_name, p.tier AS plan_tier
             FROM plan_coupons c
             JOIN plans p ON p.id = c.plan_id
             WHERE c.code = $1`,
            [code]
        );
        return result.rows[0];
    },

    async findById(id) {
        const result = await db.query(
            `SELECT c.*, p.code AS plan_code, p.name AS plan_name, p.tier AS plan_tier,
                    co.company_name
             FROM plan_coupons c
             JOIN plans p     ON p.id  = c.plan_id
             JOIN companies co ON co.id = c.company_id
             WHERE c.id = $1`,
            [id]
        );
        return result.rows[0];
    },

    async list({ page = 1, limit = 20, company_id, status, search } = {}) {
        const conds = [];
        const values = [];
        let i = 1;

        if (company_id) { conds.push(`c.company_id = $${i++}`); values.push(company_id); }
        if (status)     { conds.push(`c.status = $${i++}`);     values.push(status); }
        if (search)     { conds.push(`c.code ILIKE $${i++}`);   values.push(`%${search}%`); }

        const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";

        const countResult = await db.query(
            `SELECT COUNT(*)::int AS total FROM plan_coupons c ${where}`,
            values
        );

        const offset = (page - 1) * limit;
        const result = await db.query(
            `SELECT c.*,
                    p.code AS plan_code, p.name AS plan_name,
                    co.company_name, co.company_code,
                    (c.status = 'active' AND c.valid_until < NOW()) AS is_window_expired
             FROM plan_coupons c
             JOIN plans p      ON p.id  = c.plan_id
             JOIN companies co ON co.id = c.company_id
             ${where}
             ORDER BY c.created_at DESC
             LIMIT $${i++} OFFSET $${i}`,
            [...values, limit, offset]
        );

        return { rows: result.rows, total: countResult.rows[0].total };
    },

    /** History for the company's own upgrade page — no cross-tenant leakage. */
    async listForCompany(company_id) {
        const result = await db.query(
            `SELECT c.code, c.status, c.valid_from, c.valid_until,
                    c.redeemed_at, c.created_at,
                    p.code AS plan_code, p.name AS plan_name
             FROM plan_coupons c
             JOIN plans p ON p.id = c.plan_id
             WHERE c.company_id = $1
             ORDER BY c.created_at DESC`,
            [company_id]
        );
        return result.rows;
    },

    async codeExists(code) {
        const result = await db.query(
            `SELECT EXISTS (SELECT 1 FROM plan_coupons WHERE code = $1) AS taken`,
            [code]
        );
        return result.rows[0].taken;
    },

    async revoke(id, reason) {
        const result = await db.query(
            `UPDATE plan_coupons
             SET status = 'revoked', revoked_at = NOW(), revoked_reason = $2
             WHERE id = $1 AND status = 'active'
             RETURNING *`,
            [id, reason || null]
        );
        return result.rows[0];
    },

    /**
     * Redeems a coupon and moves the company onto its plan — atomically.
     *
     * Returns { success, reason, data }. `reason` is a stable machine code the
     * controller maps to a message, so the caller never has to string-match.
     *
     * Guards enforced here rather than in the service, because only inside the
     * row lock are they race-free:
     *   - code exists, is active, is inside its redemption window
     *   - belongs to THIS company
     *   - target plan still exists and is active
     *   - target tier is not lower than what the company already has
     *
     * Renewal (same plan) extends from the current expiry rather than from
     * today, so a customer who renews early is not silently shortchanged.
     */
    async redeem({ code, company_id, user_id }) {
        const client = await db.getClient();
        try {
            await client.query("BEGIN");

            const couponResult = await client.query(
                `SELECT * FROM plan_coupons WHERE code = $1 FOR UPDATE`,
                [code]
            );
            const coupon = couponResult.rows[0];

            if (!coupon) {
                await client.query("ROLLBACK");
                return { success: false, reason: "NOT_FOUND" };
            }

            // A code minted for another tenant must look exactly like a wrong
            // code — revealing "this belongs to someone else" would confirm a
            // valid code to whoever guessed it.
            if (coupon.company_id !== company_id) {
                await client.query("ROLLBACK");
                return { success: false, reason: "NOT_FOUND" };
            }

            if (coupon.status === "redeemed") {
                await client.query("ROLLBACK");
                return { success: false, reason: "ALREADY_REDEEMED", data: coupon };
            }
            if (coupon.status === "revoked") {
                await client.query("ROLLBACK");
                return { success: false, reason: "REVOKED", data: coupon };
            }

            const now = new Date();
            if (new Date(coupon.valid_from) > now) {
                await client.query("ROLLBACK");
                return { success: false, reason: "NOT_YET_VALID", data: coupon };
            }
            if (new Date(coupon.valid_until) < now) {
                await client.query("ROLLBACK");
                return { success: false, reason: "WINDOW_EXPIRED", data: coupon };
            }

            const planResult = await client.query(
                `SELECT * FROM plans WHERE id = $1 AND deleted_at IS NULL AND is_active = TRUE`,
                [coupon.plan_id]
            );
            const plan = planResult.rows[0];
            if (!plan) {
                await client.query("ROLLBACK");
                return { success: false, reason: "PLAN_UNAVAILABLE" };
            }

            // Lock the company too: a Super Admin plan change landing at the
            // same instant must not interleave with this read-modify-write.
            const companyResult = await client.query(
                `SELECT c.id, c.plan_id, c.plan_expires_at,
                        p.tier AS current_tier, p.code AS current_plan_code
                 FROM companies c
                 LEFT JOIN plans p ON p.id = c.plan_id
                 WHERE c.id = $1 AND c.deleted_at IS NULL
                 FOR UPDATE OF c`,
                [company_id]
            );
            const company = companyResult.rows[0];
            if (!company) {
                await client.query("ROLLBACK");
                return { success: false, reason: "COMPANY_NOT_FOUND" };
            }

            // A leaked old Trial code must never strip a paying customer.
            const currentTier = company.current_tier ?? -1;
            if (plan.tier < currentTier) {
                await client.query("ROLLBACK");
                return {
                    success: false,
                    reason: "DOWNGRADE_BLOCKED",
                    data: { current_plan_code: company.current_plan_code, target_plan_code: plan.code },
                };
            }

            // Renewal of the same plan extends the remaining time; a genuine
            // upgrade starts a fresh term from today.
            const isRenewal = company.plan_id === plan.id;
            const existingExpiry = company.plan_expires_at
                ? new Date(company.plan_expires_at)
                : null;

            const startFrom =
                isRenewal && existingExpiry && existingExpiry > now ? existingExpiry : now;

            const durationDays = coupon.duration_days ?? plan.duration_days;
            const newExpiry = durationDays
                ? new Date(startFrom.getTime() + durationDays * 24 * 60 * 60 * 1000)
                : null; // NULL = perpetual

            const updatedCompany = await client.query(
                `UPDATE companies
                 SET plan_id = $2, plan = $3, plan_expires_at = $4
                 WHERE id = $1
                 RETURNING id, company_name, plan, plan_id, plan_expires_at`,
                [company_id, plan.id, plan.code, newExpiry]
            );

            await client.query(
                `UPDATE plan_coupons
                 SET status = 'redeemed',
                     redeemed_at = NOW(),
                     redeemed_by = $2,
                     previous_plan_id = $3,
                     previous_expires_at = $4
                 WHERE id = $1`,
                [coupon.id, user_id, company.plan_id, company.plan_expires_at]
            );

            await client.query("COMMIT");

            return {
                success: true,
                data: {
                    company: updatedCompany.rows[0],
                    plan,
                    coupon: { ...coupon, status: "redeemed" },
                    was_renewal: isRenewal,
                    previous_plan_code: company.current_plan_code,
                    expires_at: newExpiry,
                },
            };
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    },

    // ── Attempt log ───────────────────────────────────────────────────────────

    async logAttempt({ company_id, user_id, code_attempted, was_successful, failure_reason, ip_address }) {
        await db.query(
            `INSERT INTO plan_coupon_attempts (
                company_id, user_id, code_attempted,
                was_successful, failure_reason, ip_address
             ) VALUES ($1,$2,$3,$4,$5,$6)`,
            [company_id, user_id, code_attempted, was_successful,
             failure_reason || null, ip_address || null]
        );
    },

    /** Failed attempts by this company in the last N minutes — throttle input. */
    async countRecentFailures(company_id, minutes = 15) {
        const result = await db.query(
            `SELECT COUNT(*)::int AS n FROM plan_coupon_attempts
             WHERE company_id = $1
               AND was_successful = FALSE
               AND created_at > NOW() - ($2 || ' minutes')::INTERVAL`,
            [company_id, minutes]
        );
        return result.rows[0].n;
    },
};

module.exports = PlanCouponModel;
