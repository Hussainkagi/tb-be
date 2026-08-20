const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("./config/database");

// ─── ANSI Colors for console ────────────────────────────────────────────────
const green = (msg) => `\x1b[32m${msg}\x1b[0m`;
const yellow = (msg) => `\x1b[33m${msg}\x1b[0m`;
const red = (msg) => `\x1b[31m${msg}\x1b[0m`;
const cyan = (msg) => `\x1b[36m${msg}\x1b[0m`;
const blue = (msg) => `\x1b[34m${msg}\x1b[0m`;

// ─── Config ──────────────────────────────────────────────────────────────────
const MIGRATIONS_DIR = path.join(__dirname, "database", "migration");
const MIGRATIONS_TABLE = "migrations";

// ─── Helper: Calculate file hash ──────────────────────────────────────────────
const calculateFileHash = (filePath) => {
    const fileContent = fs.readFileSync(filePath, "utf8");
    return crypto.createHash("md5").update(fileContent).digest("hex");
};

// ─── Step 1: Create migrations tracker table if not exists ──────────────────
const createMigrationsTable = async () => {
    await db.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id          SERIAL PRIMARY KEY,
      filename    VARCHAR(255) UNIQUE NOT NULL,
      file_hash   VARCHAR(32),
      ran_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

    await db.query(`
        ALTER TABLE ${MIGRATIONS_TABLE}
            ADD COLUMN IF NOT EXISTS file_hash VARCHAR(32),
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    `);

    await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS migrations_filename_unique_idx
        ON ${MIGRATIONS_TABLE}(filename);
    `);

    console.log(cyan("📋 Migrations tracker table ready."));
};

// ─── Step 2: Get list of already-ran migrations with their hashes ───────────
const getRanMigrations = async () => {
    const { rows } = await db.query(
        `SELECT filename, file_hash FROM ${MIGRATIONS_TABLE} ORDER BY ran_at ASC`
    );
    return rows.reduce((acc, r) => {
        acc[r.filename] = r.file_hash;
        return acc;
    }, {});
};

// ─── Step 3: Get all .sql files from migrations folder (sorted) ──────────────
const getMigrationFiles = () => {
    if (!fs.existsSync(MIGRATIONS_DIR)) {
        throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
    }

    return fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();
};

// ─── Step 4: Run a single migration file ─────────────────────────────────────
const runMigration = async (filename, isRerun = false) => {
    const filePath = path.join(MIGRATIONS_DIR, filename);
    const sql = fs.readFileSync(filePath, "utf8");
    const fileHash = calculateFileHash(filePath);

    await db.query("BEGIN");
    try {
        await db.query(sql);

        if (isRerun) {
            await db.query(
                `UPDATE ${MIGRATIONS_TABLE} SET file_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE filename = $2`,
                [fileHash, filename]
            );
            console.log(blue(`🔄 Re-ran:   ${filename} (changes detected)`));
        } else {
            await db.query(
                `INSERT INTO ${MIGRATIONS_TABLE} (filename, file_hash) VALUES ($1, $2)`,
                [filename, fileHash]
            );
            console.log(green(`✅ Ran:     ${filename}`));
        }

        await db.query("COMMIT");
    } catch (err) {
        await db.query("ROLLBACK");
        throw new Error(`Failed on ${filename}: ${err.message}`);
    }
};

// ─── Cross-process lock ───────────────────────────────────────────────────────
//
// More than one process now boots this file at the same time: the API
// container and the worker container both run server.js, and server.js runs
// migrate() before listening (and the API may itself be scaled to several
// replicas). Without a lock they all read the same "pending" list and run the
// same DDL concurrently — which ends in a duplicate-key error on the
// migrations table, or two ALTER TABLEs fighting over the same relation, and
// a container that exits and restarts mid-deploy.
//
// A Postgres advisory lock serialises the runner across processes and hosts:
// the first one in does the work, the others block here and then find nothing
// left to do. The lock is session-scoped, so it must be held on a dedicated
// client for the whole run (a pooled query would return the connection — and
// release the lock — immediately), and it disappears on its own if the
// process dies, so a crashed deploy cannot wedge the next one.
//
// The key is an arbitrary constant; it only has to be the same in every
// process that runs these migrations.
const MIGRATION_LOCK_KEY = 4917283;

const withMigrationLock = async (fn) => {
    const client = await db.getClient();

    try {
        console.log(cyan("🔒 Acquiring migration lock..."));
        await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

        return await fn();
    } finally {
        try {
            await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
        } catch {
            // Losing the unlock is survivable — the lock dies with the session.
        }
        client.release();
    }
};

// ─── Main ─────────────────────────────────────────────────────────────────────
const migrate = async () => {
    console.log(cyan("\n🚀 Starting migration runner...\n"));

    try {
        await createMigrationsTable();

        return await withMigrationLock(async () => {
            const ranMigrationsMap = await getRanMigrations();
            const allFiles = getMigrationFiles();

            const newMigrations = [];
            const modifiedMigrations = [];

            for (const file of allFiles) {
                const filePath = path.join(MIGRATIONS_DIR, file);
                const currentHash = calculateFileHash(filePath);
                const storedHash = ranMigrationsMap[file];
                const alreadyRan = Object.prototype.hasOwnProperty.call(ranMigrationsMap, file);

                if (!alreadyRan) {
                    newMigrations.push(file);
                } else if (storedHash !== currentHash) {
                    modifiedMigrations.push(file);
                }
            }

            const totalToRun = newMigrations.length + modifiedMigrations.length;

            if (totalToRun === 0) {
                console.log(yellow("⚡ No new or modified migrations. Database is up to date.\n"));
                return; // ✅ return instead of process.exit(0)
            }

            if (newMigrations.length > 0) {
                console.log(blue(`\n📂 Found ${newMigrations.length} new migration(s):\n`));
                for (const file of newMigrations) {
                    await runMigration(file, false);
                }
            }

            if (modifiedMigrations.length > 0) {
                console.log(blue(`\n📝 Found ${modifiedMigrations.length} modified migration(s):\n`));
                for (const file of modifiedMigrations) {
                    await runMigration(file, true);
                }
            }

            console.log(green(`\n🎉 Done! ${totalToRun} migration(s) applied successfully.\n`));
            // ✅ return instead of process.exit(0)
        });

    } catch (err) {
        console.error(red(`\n❌ Migration error: ${err.message}\n`));
        // ✅ throw instead of process.exit(1) so server.js can catch it
        throw err;
    }
};

// ✅ Only auto-run when called directly: node migrate.js
if (require.main === module) {
    migrate()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
}

module.exports = { migrate };