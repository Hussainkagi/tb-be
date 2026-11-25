/**
 * Where each part of the web app lives, for links the backend builds (emails,
 * apply links, the client login link …). Each portal can have its own domain:
 *
 *   FRONTEND_URL / PUBLIC_SITE_URL   teamBook HR            https://teambook.ikration.com
 *   JOBS_SITE_URL                    public job board       https://jobs.teambook.ikration.com
 *   AGENCY_SITE_URL                  agency portal          https://agency.teambook.ikration.com
 *   CLIENT_SITE_URL                  agencies' clients      https://client.teambook.ikration.com
 *
 * Any left unset fall back to the main site, so nothing changes until they're set.
 * Paths keep their prefix on every domain (…/jobs/…, …/agency/…, …/client/…).
 */
const clean = (v) => (v ? String(v).trim().replace(/\/+$/, "") : "");

const mainUrl = () => clean(process.env.PUBLIC_SITE_URL) || clean(process.env.FRONTEND_URL) || "https://teambook.ikration.com";
const jobsUrl = () => clean(process.env.JOBS_SITE_URL) || mainUrl();
const agencyUrl = () => clean(process.env.AGENCY_SITE_URL) || mainUrl();
const clientUrl = () => clean(process.env.CLIENT_SITE_URL) || mainUrl();

module.exports = { mainUrl, jobsUrl, agencyUrl, clientUrl };
