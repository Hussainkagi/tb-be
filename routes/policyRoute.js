const express = require("express");
const router = express.Router();

const PolicyController = require("../controller/policyController");

// ─────────────────────────────────────────────
// PUBLIC — no auth
// ─────────────────────────────────────────────
//
// The registration form needs to show the Terms and Privacy Policy BEFORE an
// account exists, so these are open. They serve only the current, published
// version — the archive lives behind the Super Admin routes.
//
// ?country=AE            → country-specific document, falling back to global
// ?policy_type=terms     → one document instead of both
//
// The country accepts either an ISO alpha-2 code or a country name, because
// the signup form's country field is free text.

router.get("/", PolicyController.getPublicPolicies);

module.exports = router;
