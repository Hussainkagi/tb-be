-- ============================================================
-- 43_free_plan_and_full_trial.sql
-- Must run after 34_plans_and_entitlements.sql and 40_task_module.sql
--
-- Splits one plan that was doing two jobs.
--
-- Until now `trial` was BOTH the plan new signups land on AND the plan
-- flagged is_fallback — where every company with no plan, or an expired one,
-- resolves to. One row cannot be both a generous 45-day showcase and the
-- restricted floor a lapsed Gold account drops to, which is why a new
-- company only ever saw the free feature set.
--
-- After this migration:
--
--   free   is_fallback = TRUE        the floor. Exactly the feature set
--                                    `trial` carried before today, perpetual,
--                                    no expiry. Where companies land when a
--                                    plan lapses or was never set.
--
--   trial  is_signup_default = TRUE  45 days, every feature switched on,
--                                    with evaluation-sized caps on the four
--                                    numeric limits.
--
-- Existing companies are deliberately left with the entitlements they have
-- today: anyone currently on `trial` (or on no plan at all) is repointed to
-- `free`, which carries the identical grid. Nobody gains or loses access on
-- deploy. Companies on pro/gold are untouched.
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. Which plan do new signups get?
--
-- Previously the signup path called findFallbackPlan(), conflating the two
-- roles. A dedicated flag keeps the choice in the database — where
-- is_fallback already lives — so switching the signup plan later is a panel
-- edit, not a deploy.
-- ------------------------------------------------------------
ALTER TABLE plans
    ADD COLUMN IF NOT EXISTS is_signup_default BOOLEAN NOT NULL DEFAULT FALSE;

-- At most one of each flag, enforced rather than trusted: two fallback plans
-- would make entitlement resolution depend on row order.
CREATE UNIQUE INDEX IF NOT EXISTS uq_plans_single_signup_default
    ON plans ((is_signup_default))
    WHERE is_signup_default = TRUE AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_plans_single_fallback
    ON plans ((is_fallback))
    WHERE is_fallback = TRUE AND deleted_at IS NULL;


-- ------------------------------------------------------------
-- 2. The new floor: `free`
--
-- duration_days NULL = perpetual. It is the destination for expiry, so it
-- must never expire itself.
-- ------------------------------------------------------------
INSERT INTO plans (code, name, tagline, price_amount, price_currency, billing_period,
                   tier, duration_days, grace_days, is_fallback, is_public, sort_order, description)
VALUES
    ('free', 'Free', 'The essentials, at no cost',
     0, 'USD', 'once', 0, NULL, 0, FALSE, TRUE, 5,
     'Core attendance and leave for a small team. No time limit.')
ON CONFLICT (code) DO NOTHING;


-- ------------------------------------------------------------
-- 3. Give `free` the grid `trial` carries TODAY
--
-- Copied from the live rows rather than re-typed, so whatever the panel has
-- been edited to since 34 is preserved exactly. This must happen BEFORE
-- trial's own grid is rewritten in step 6.
-- ------------------------------------------------------------
INSERT INTO plan_feature_values (plan_id, feature_key, bool_value, limit_value, is_unlimited, json_value, note)
SELECT f.id, v.feature_key, v.bool_value, v.limit_value, v.is_unlimited, v.json_value, v.note
FROM plan_feature_values v
JOIN plans t ON t.id = v.plan_id AND t.code = 'trial'
CROSS JOIN plans f
WHERE f.code = 'free'
ON CONFLICT (plan_id, feature_key) DO NOTHING;


-- ------------------------------------------------------------
-- 4. Move today's trial companies onto `free`
--
-- "Leave existing customers exactly as they are." Their plan_id currently
-- points at trial, whose grid is about to become all-features — without this
-- repoint they would silently gain the full product on deploy.
--
-- plan_expires_at is cleared: free is perpetual, and a stale expiry would
-- have them permanently resolving through the expired-plan branch.
--
-- companies.plan is the legacy text label, kept in step with plan_id.
-- ------------------------------------------------------------
UPDATE companies c
   SET plan_id         = f.id,
       plan            = 'free',
       plan_expires_at = NULL
FROM plans f, plans t
WHERE f.code = 'free'
  AND t.code = 'trial'
  AND c.deleted_at IS NULL
  AND (c.plan_id = t.id OR c.plan_id IS NULL);


-- ------------------------------------------------------------
-- 5. Swap the roles
-- ------------------------------------------------------------
UPDATE plans SET is_fallback = FALSE, is_signup_default = FALSE WHERE code <> 'free';
UPDATE plans SET is_fallback = TRUE                              WHERE code = 'free';
UPDATE plans SET is_signup_default = TRUE                        WHERE code = 'trial';


-- ------------------------------------------------------------
-- 6. `trial` becomes the 45-day full-feature showcase
-- ------------------------------------------------------------
UPDATE plans
   SET duration_days = 45,
       grace_days    = 0,
       tagline       = 'Try every teamBook feature free for 45 days',
       description   = 'Full access to the entire product for 45 days — payroll, '
                       'gratuity, tasks, reporting and multi-level approvals included. '
                       'No card required.',
       sort_order    = 10,
       is_public     = TRUE
 WHERE code = 'trial';

-- Rewrite trial's grid from gold's, so "everything" stays true for features
-- added since 34 (the task module's four keys came in with 40) without this
-- migration having to list them.
--
-- DELETE + INSERT rather than upsert: this is a deliberate, wholesale
-- redefinition of what trial means. Any hand-edit made to trial in the Super
-- Admin panel before today is intentionally discarded — that is the point of
-- the change, not a side effect of it.
DELETE FROM plan_feature_values
 WHERE plan_id = (SELECT id FROM plans WHERE code = 'trial');

INSERT INTO plan_feature_values (plan_id, feature_key, bool_value, limit_value, is_unlimited, json_value, note)
SELECT t.id, v.feature_key, v.bool_value, v.limit_value, v.is_unlimited, v.json_value, v.note
FROM plan_feature_values v
JOIN plans g ON g.id = v.plan_id AND g.code = 'gold'
CROSS JOIN plans t
WHERE t.code = 'trial';


-- ------------------------------------------------------------
-- 7. Evaluation-sized caps
--
-- Every FEATURE is on; the numeric limits are not gold's "unlimited". A
-- 45-day window is for judging whether the product fits, not for running a
-- 500-person rollout free — and a company that onboards its whole workforce
-- on a trial hits a wall at renewal, which is a worse experience than being
-- capped from the start.
-- ------------------------------------------------------------
UPDATE plan_feature_values v
   SET limit_value  = x.cap,
       is_unlimited = FALSE,
       bool_value   = NULL,
       note         = x.note
FROM plans t, (VALUES
    ('limit.employees',   25, 'Up to 25 employees during the trial'),
    ('limit.branches',     3, 'Up to 3 branches during the trial'),
    ('limit.shifts',       5, 'Up to 5 shifts during the trial'),
    ('limit.departments',  5, 'Up to 5 departments during the trial')
) AS x(feature_key, cap, note)
WHERE t.code = 'trial'
  AND v.plan_id = t.id
  AND v.feature_key = x.feature_key;


-- ------------------------------------------------------------
-- 8. Guard rails — fail the migration rather than deploy a broken grid
-- ------------------------------------------------------------
DO $$
DECLARE
    fallback_count INT;
    signup_count   INT;
    trial_days     INT;
    trial_off      INT;
BEGIN
    SELECT count(*) INTO fallback_count FROM plans WHERE is_fallback AND deleted_at IS NULL;
    SELECT count(*) INTO signup_count   FROM plans WHERE is_signup_default AND deleted_at IS NULL;
    SELECT duration_days INTO trial_days FROM plans WHERE code = 'trial';

    SELECT count(*) INTO trial_off
      FROM plan_feature_values v
      JOIN plans t ON t.id = v.plan_id AND t.code = 'trial'
      JOIN plan_features f ON f.key = v.feature_key
     WHERE f.value_type = 'boolean' AND v.bool_value IS DISTINCT FROM TRUE;

    IF fallback_count <> 1 THEN
        RAISE EXCEPTION 'Expected exactly 1 fallback plan, found %', fallback_count;
    END IF;
    IF signup_count <> 1 THEN
        RAISE EXCEPTION 'Expected exactly 1 signup-default plan, found %', signup_count;
    END IF;
    IF trial_days <> 45 THEN
        RAISE EXCEPTION 'Trial duration is % days, expected 45', trial_days;
    END IF;
    IF trial_off > 0 THEN
        RAISE EXCEPTION 'Trial has % boolean feature(s) switched off — it must grant everything', trial_off;
    END IF;
END $$;

COMMIT;
