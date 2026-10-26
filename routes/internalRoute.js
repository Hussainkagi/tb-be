const express = require("express");
const internalOnly = require("../middleware/internalOnly");
const InternalController = require("../controller/internalController");

const router = express.Router();

router.post("/verify-login", internalOnly, InternalController.verifyLogin);

module.exports = router;
