/**
 * GET /api/app-version?platform=android|ios
 *
 * Tells the mobile app whether a newer STORE build exists, so it can show its
 * "Update available" sheet. Public and read-only — the app asks before (and
 * regardless of) sign-in.
 *
 * The values are set by Super Admins under Platform → App versions (tables
 * app_releases + app_release_settings), so a release needs no redeploy.
 * Only the store link falls back to env (APP_ANDROID_STORE_URL /
 * APP_IOS_STORE_URL).
 *
 * Over-the-air (EAS Update) changes need none of this — the app picks those up
 * itself and offers a Reload.
 */
const express = require("express");
const router = express.Router();
const AppReleaseService = require("../service/appReleaseService");

router.get("/", async (req, res) => {
    const platform = req.query.platform === "ios" ? "ios" : "android";
    try {
        const data = await AppReleaseService.publicInfo(platform);
        res.set("Cache-Control", "public, max-age=60");
        return res.json({ success: true, data });
    } catch {
        // Never an error the app has to handle: no data means no prompt.
        return res.json({ success: true, data: { platform, latest_version: null, min_version: null, notes: null, store_url: null } });
    }
});

module.exports = router;
