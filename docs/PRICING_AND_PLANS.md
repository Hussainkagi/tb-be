# Pricing, Plans & Entitlements

How Ikration teamBook decides what a company is allowed to do, and how a company moves between plans.

Source of the plan definitions: `Ikration_teamBook_Pricing_Plans.xlsx` in the repo root, seeded into the database by `database/migration/34_plans_and_entitlements.sql`.

Frontend build prompts: [FRONTEND_PROMPT.md](./FRONTEND_PROMPT.md) (company app) and [SUPERADMIN_FRONTEND_PROMPT.md](./SUPERADMIN_FRONTEND_PROMPT.md) (Super Admin console).

---

## 1. The core idea

Two things are kept deliberately apart, because they change at different speeds and by different people:

| | What it is | Who changes it | How |
|---|---|---|---|
| **Feature catalog** | The list of gateable capabilities (`payroll.generate`, `limit.employees`) | Developers | A migration + `enums/features.js` |
| **The grid** | Which plans get which features, and at what limits | You, at runtime | Super Admin panel |

A feature key only belongs in the catalog once code actually enforces it. If the panel could invent new keys, you would accumulate config that looks live and gates nothing.

The grid is data, so **adding the Task module to Gold next month is a checkbox, not a deploy**. The module ships with `task.*` keys switched off for every plan; you tick them into the plans that should have them.

---

## 2. The four tables

```
plan_features               ← the CATALOG      (migration-owned)
      ▲
      │ referenced by
      │
plan_feature_values         ← the GRID         (Super Admin CRUD)
      ▲                        plan × feature
      │
plans                       ← Trial/Pro/Gold   (Super Admin CRUD)
      ▲
      │ companies.plan_id
      │
company_feature_overrides   ← exceptions       (Super Admin CRUD)
```

Plus `plan_coupons` (+ `plan_coupon_attempts`) for the upgrade path.

### Resolution order

For every feature key, per company:

```
1. company_feature_overrides   (unexpired)   → wins
2. plan_feature_values          for the EFFECTIVE plan
3. nothing                                    → DENIED / zero
```

**A missing grid row means denied, not "inherit."** That is what makes a new feature key safe to ship: it is off everywhere until someone turns it on.

### The effective plan

Not simply `companies.plan_id`. A company whose `plan_expires_at` has passed — *plus* the plan's `grace_days` — is served the plan flagged `is_fallback` (Trial). Otherwise an expired Gold company would keep Gold forever.

```
plan_expires_at ────── + grace_days ──────▶
      │                      │
   expired,               fully
   still entitled         lapsed → falls back to Trial
   (is_in_grace)          (is_downgraded_by_expiry)
```

Grace exists because payment confirmation is manual here. A customer who paid on Friday should not lose payroll over the weekend.

### Value types

The spreadsheet is not all yes/no, so the schema is not either:

| Type | Column | Meaning | Example |
|---|---|---|---|
| `boolean` | `bool_value` | on / off | Photo verification |
| `limit` | `limit_value` | `NULL` = unlimited, `0` = blocked, `n` = cap | Employees 10 / 100 / ∞ |
| `enum` | `json_value` | array of allowed sub-keys | Reports per plan |

`is_enforceable = FALSE` marks rows that exist only so the pricing page can advertise them — the Support & SLA rows. Nothing in code gates on them, and `requireFeature()` **throws at boot** if you try to mount one, so the mistake surfaces immediately.

---

## 3. Enforcement

### Features

```js
const { requireFeature } = require("./middleware/enforceEntitlement");
const { Feature } = require("./enums/features");

app.use("/api/companies/:company_id/gratuity",
        requireFeature(Feature.GRATUITY_CALCULATE),
        EmployeeGratuityRoutes);
```

`{ allowReads: true }` gates writes only. Used on payroll and payslips: a company that lapses from Pro can still open the payroll it already ran, it just cannot generate more. Finance records are the worst possible thing to make someone feel they have lost.

Fully gated (reads included) where the read *is* the feature — gratuity figures, the audit trail. A plan without the feature never produced any data, so there is nothing to strand.

### Limits — create only

```js
router.post("/", verifyToken, validateTenant, isAdmin,
            enforceLimit(Limit.BRANCHES),
            BranchController.create);
```

**Caps are checked on CREATE and nowhere else.** A company that downgrades holding 140 employees against a 100 cap keeps every one of them — sees them, edits them, pays them. It simply cannot invite the 141st.

Enforcing caps on reads would read as data loss and is the single most common way this kind of gating goes wrong.

The check counts live rather than trusting the cached snapshot, so two admins inviting simultaneously cannot both slip through on a stale count.

Bulk imports check the **whole batch up front** (`service/userCompanyService.js` → `bulkInviteEmployees`). Checking row by row would walk a company 50 seats past its cap on one upload and leave a half-imported file.

### Reports (enum)

```js
router.get("/working-hours", …, requireReport(ReportKey.WORKING_HOURS), …);
```

Adding a report later = add the key to `enums/features.js`, tick it into the plans that should have it. No change to the route file.

### Photo verification — stripped, not rejected

The selfie is an optional part of check-in. A 403 would stop a Trial employee clocking in at all, so `stripUnentitledUpload()` drops the file and lets the attendance record through, with `X-Feature-Stripped` on the response.

---

## 4. The upgrade flow

Payment happens off-platform. No gateway in the app; one manual step per upgrade.

```
1. Customer emails us wanting Pro/Gold
2. We invoice → they pay → payment confirmed
3. Super Admin panel → Coupons → New
      select company, plan, redemption window, duration
      → TB-4KDM-9XQP-2WVH
4. We email the code
5. Company admin: Settings → Billing → enter code
6. Plan changes instantly; entitlement cache invalidated
```

### Two windows, kept separate

| Field | Means |
|---|---|
| `valid_from` / `valid_until` | when the code may be **redeemed** |
| `duration_days` | how long the plan runs **once redeemed** |

Collapsing these into one date is the mistake that surfaces three months later as *"the customer redeemed on the last day and got two days of Pro."* A code that must be used by 31 Jan and then grants 12 months needs both.

### What protects the codes

They travel by email, so:

- **Bound to one company at mint time.** We always know who paid. An unbound code is pure risk — anyone who saw it could claim it. A code presented by the wrong tenant returns the same "not valid" as a wrong code; confirming it exists would confirm a valid code to whoever guessed it.
- **Single-use under a row lock.** `SELECT … FOR UPDATE` inside a transaction, not a status check. A double-click cannot stack two subscriptions.
- **Never downgrades.** A leaked old Trial code cannot strip a paying customer. Blocked at redemption *and* refused at mint, so you never hand over a dead code.
- **Throttled.** 10 failures per company per 15 minutes → 429. Every attempt, success or failure, is logged to `plan_coupon_attempts`.
- **Renewal extends, upgrade restarts.** Redeeming the same plan again adds time to the existing expiry, so an early renewal is not silently shortchanged.

### Revoking

An unredeemed code can be revoked (wrong company, payment reversed, code leaked). A redeemed one cannot — the upgrade already happened; reversing it is a plan change (`PATCH /super-admin/companies/:id/plan`), not a coupon operation. The coupon stores `previous_plan_id` and `previous_expires_at` so the reversal is exact rather than guesswork.

---

## 5. Overrides

`company_feature_overrides` answers *"Pro, but 150 employees"* without minting a private plan per customer.

Without it, the first negotiated deal spawns a `pro-custom-acme` plan, and the plan table rots within a year. `reason` is **required** — an override nobody can explain later is worse than no override. `expires_at` lets a goodwill grant during a support incident expire on its own instead of being forgotten.

---

## 6. Caching

`entitlementService` holds a 60-second TTL map, mirroring `enforceCompanyActive` and `isSuperAdmin`.

The TTL is the safety net, not the mechanism. Anything that changes entitlements invalidates explicitly:

| Event | Invalidates |
|---|---|
| Coupon redeemed | that company |
| Plan changed directly | that company |
| Override added/removed | that company |
| Plan edited, grid saved | **everything** (generation bump) |

An upgrade has to feel instant — the admin is watching the screen. Waiting out a TTL would leave the UI locked for up to a minute after a successful redemption.

Grid edits take effect for existing customers immediately, which is the intent: a module ticked into Gold lights up for Gold customers without them doing anything.

---

## 7. API surface

### Company-facing — `/api/companies/:company_id/billing`

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/entitlements` | any | **The one call the frontend gates off.** Fetch at login. |
| GET | `/pricing` | any | Every public plan + which one they are on |
| POST | `/coupons/redeem` | admin | `{ "code": "TB-…" }` |
| GET | `/coupons` | admin | Their own code history |

Never gated by a plan. A lapsed company must always reach the upgrade path — that would be the one lockout with no way out.

### Super Admin — `/api/super-admin`

| Method | Path | Purpose |
|---|---|---|
| GET | `/plan-features` | The catalog, grouped by category |
| GET/POST | `/plans` | List / create |
| GET/PUT/DELETE | `/plans/:plan_id` | Read / edit / soft-delete |
| GET/PUT | `/plans/:plan_id/grid` | **The grid screen** |
| PATCH | `/plans/:plan_id/features/:feature_key` | Toggle one cell |
| GET | `/companies/:company_id/entitlements` | Resolved view (support tool) |
| GET/PUT | `/companies/:company_id/overrides` | Per-company exceptions |
| DELETE | `/companies/:company_id/overrides/:feature_key` | Remove one |
| GET/POST | `/coupons` | List / mint |
| PATCH | `/coupons/:coupon_id/revoke` | Kill an unredeemed code |

Every mutation writes to `super_admin_audit_logs`. Plan changes are money decisions; *"who moved this company to Gold"* must be answerable a year later.

### Delete guards

A plan cannot be deleted while companies are on it, while unredeemed coupons point at it, or if it is the fallback. A plan cannot be deactivated while companies are on it — move them first.

---

## 8. Error contract

One shape, so the frontend needs one interceptor:

```jsonc
// 403
{
  "success": false,
  "code": "FEATURE_NOT_IN_PLAN",     // or "LIMIT_REACHED"
  "message": "Gratuity calculation is not included in your current plan.",
  "data": {
    "feature": "gratuity.calculate",
    "current_plan": "pro",
    "required_plans": [{ "code": "gold", "name": "Gold", "tier": 20 }],
    "upgrade_path": "/billing/pricing"
  }
}
```

`LIMIT_REACHED` additionally carries `limit`, `used`, `requested`, `remaining`.

`429` with `code: "THROTTLED"` on coupon brute-forcing — distinct from a wrong code so the UI can say "wait a few minutes" rather than "try again".

---

## 9. Adding a new module later

The whole point of the design. To gate a Task module:

1. Add `TASKS: "tasks.manage"` to `enums/features.js`
2. Add the catalog row in the Task module's own migration
3. Mount `requireFeature(Feature.TASKS)` on the task routes
4. Deploy — it is **off for every plan**, so nothing changes for anyone
5. Open Super Admin → Plans → Gold → Grid, tick it, save

Step 5 needs no deploy, and every existing Gold customer has it within the second.

---

## 10. Known limitations

- **`companies.plan` (text) still exists** alongside `plan_id`. Both are written together by `CompanyModel.updatePlan` and `SuperAdminModel.updateCompanyPlan`. It stays until the Super Admin console filters move to `plan_id`; dropping it in the same migration that introduced `plan_id` would have broken those reads mid-deploy.
- **Storage quota** (`data.image_storage`, "Trial: limited quota") is advertised but not metered. There is no byte counter today; the key is in the catalog so it appears on the pricing page.
- **Support & SLA rows are advertised, not enforced.** By design — see `is_enforceable`.
- **Prices are all zero** in the seed. Fill them in from the panel; they are display-only, since no payment is processed in-app.
