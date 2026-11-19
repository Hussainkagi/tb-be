/**
 * The R2 bucket is private. Files are stored as "r2://<key>"; on the way out,
 * every such value in a JSON response is replaced with a short-lived signed
 * URL (utils/storage.signAll). Screens keep receiving plain links, and a
 * leaked link stops working after R2_SIGNED_URL_TTL.
 *
 * Cheap when unused: a response without "r2://" in it is passed straight on.
 */
const storage = require("../utils/storage");

module.exports = function signStorageUrls(req, res, next) {
    if (!storage.r2Enabled()) return next();

    const send = res.json.bind(res);
    res.json = (body) => {
        let text;
        try {
            text = JSON.stringify(body);
        } catch {
            return send(body);
        }
        if (!text || !text.includes('"r2://')) return send(body);

        storage
            .signAll(body)
            .then((signed) => send(signed))
            .catch((error) => {
                console.error("[storage] could not sign file links:", error.message);
                send(body);
            });
        return res;
    };
    next();
};
