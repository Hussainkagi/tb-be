const cron = require("node-cron");
const dotenv = require("dotenv");

// Load .env here rather than relying on server.js having done it first.
// dotenv never overwrites a variable that is already set, so this is a no-op
// when the process was given RUN_JOBS directly (Docker, CI, `RUN_JOBS=true npm
// start`). Without it the answer to "are jobs enabled" depended on whether
// some other module had already pulled in config/database — which quietly
// calls dotenv.config() — and a job file imported directly could end up
// scheduling crons that registerAllJobs() had just declined to register.
dotenv.config();

/**
 * Background job gate.
 *
 * Every job in this folder registers its cron schedule as a side effect of
 * being required. That was fine for one process and wrong the moment the API
 * runs on more than one instance: each container would register the same
 * schedules, and the same sweep would fire N times. The per-minute dispatch
 * queue flush (jobs/attendanceReminderJob.js) is the sharpest edge — it
 * marks rows 'processing' and pushes them, so two instances racing it means
 * duplicate notifications on people's phones.
 *
 * RUN_JOBS decides whether THIS process is the one that runs them:
 *
 *   RUN_JOBS=false / unset   API only. No schedule is registered.
 *   RUN_JOBS=true            This process runs every job.
 *
 * Default is off, so scaling the API to more instances can never
 * accidentally multiply the crons. The trade is that SOMETHING has to run
 * with RUN_JOBS=true or scheduled notifications are never delivered — hence
 * the warning startupSummary() prints, and the `worker` service in
 * docker-compose.yml.
 */

// Read at call time, never at module load: dotenv.config() runs inside
// server.js, and a module-level read here could beat it depending on import
// order — which would silently disable jobs on a correctly configured box.
const jobsEnabled = () => {
    const raw = String(process.env.RUN_JOBS ?? "").trim().toLowerCase();
    return raw === "true" || raw === "1" || raw === "yes";
};

/**
 * Schedules registered in this process, keyed by name.
 *
 * The name is what makes registration idempotent. Node's module cache
 * already means a second `require` of a job file does not re-run it, but
 * that only holds while the file is the sole registration path; this map
 * makes the guarantee explicit and survives a job file being imported by a
 * script or a test as well.
 */
const registry = new Map();

/**
 * Register one cron schedule. Replaces a bare cron.schedule() call inside a
 * job file — same expression, same handler, same options.
 *
 * Returns the node-cron task, or null when jobs are disabled in this process
 * or the name is already registered.
 */
const scheduleJob = (name, expression, handler, options = { timezone: "UTC" }) => {
    if (!jobsEnabled()) {
        return null;
    }

    if (registry.has(name)) {
        console.warn(`[CRON] "${name}" is already registered in this process — ignoring duplicate.`);
        return registry.get(name);
    }

    const task = cron.schedule(expression, handler, options);
    registry.set(name, { expression, task });

    console.log(`[CRON] Registered "${name}" (${expression} ${options?.timezone || "UTC"}).`);
    return task;
};

/** Names of everything registered in this process — used by the startup log and tests. */
const registeredJobs = () =>
    [...registry.entries()].map(([name, { expression }]) => ({ name, expression }));

/** Guards against registerAllJobs() being called twice (e.g. server.js reloaded in a test). */
let registrationRan = false;

/**
 * The single place the job files are pulled in.
 *
 * The requires live INSIDE this function on purpose. Registration is an
 * import side effect, so requiring these at the top of the module would
 * schedule the crons before anyone could check RUN_JOBS — the exact bug this
 * file exists to prevent.
 */
const registerAllJobs = () => {
    if (!jobsEnabled()) {
        return { enabled: false, jobs: [] };
    }

    if (registrationRan) {
        return { enabled: true, jobs: registeredJobs() };
    }
    registrationRan = true;

    require("./attendanceReminderJob");        // daily sweep + per-minute dispatch flush
    require("./birthdayNotificationJob");
    require("./Task/taskDeadlineJob");
    require("./Task/taskPerformanceRollupJob");

    return { enabled: true, jobs: registeredJobs() };
};

/** One line at boot saying which kind of process this is. */
const startupSummary = () => {
    if (!jobsEnabled()) {
        console.log(
            "[CRON] RUN_JOBS is not enabled — this process serves the API only. " +
            "Scheduled reminders and the notification dispatch queue will not run here; " +
            "a process started with RUN_JOBS=true must handle them."
        );
        return;
    }

    const jobs = registeredJobs();
    console.log(`[CRON] RUN_JOBS enabled — ${jobs.length} schedule(s) active in this process.`);
};

module.exports = {
    jobsEnabled,
    scheduleJob,
    registerAllJobs,
    registeredJobs,
    startupSummary,
};
