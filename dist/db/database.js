"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.FALLBACK_TIMEZONE = exports.db = void 0;
exports.getDefaultTimezone = getDefaultTimezone;
exports.getDefaultTgApiCredentials = getDefaultTgApiCredentials;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const fuzzy_1 = require("./fuzzy");
const secretColumns_1 = require("./secretColumns");
const DB_PATH = process.env.DB_PATH ?? path_1.default.resolve(process.cwd(), "data/bemby.db");
const dir = path_1.default.dirname(DB_PATH);
if (!fs_1.default.existsSync(dir)) {
    fs_1.default.mkdirSync(dir, { recursive: true });
}
exports.db = new better_sqlite3_1.default(DB_PATH);
exports.db.pragma("journal_mode = WAL");
exports.db.pragma("foreign_keys = ON");
// Custom function used by list endpoints for fuzzy text search (see db/fuzzy.ts)
exports.db.function("fuzzy_score", { deterministic: true }, (needle, haystack) => (0, fuzzy_1.fuzzyScore)(needle, haystack));
exports.db.exec(`
  CREATE TABLE IF NOT EXISTS tg_accounts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    phone_number TEXT   NOT NULL,
    api_id      INTEGER NOT NULL,
    api_hash    TEXT    NOT NULL,
    session_string TEXT,
    auth_status TEXT    NOT NULL DEFAULT 'unauthenticated',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL,
    account_id            INTEGER NOT NULL REFERENCES tg_accounts(id) ON DELETE CASCADE,
    job_type              TEXT    NOT NULL DEFAULT 'checkin',
    bot_username          TEXT    NOT NULL,
    schedule_window_start INTEGER NOT NULL DEFAULT 1400,
    schedule_window_end   INTEGER NOT NULL DEFAULT 1600,
    timezone              TEXT    NOT NULL DEFAULT '',
    reply_timeout_ms      INTEGER NOT NULL DEFAULT 40000,
    retry_max             INTEGER NOT NULL DEFAULT 5,
    enabled               INTEGER NOT NULL DEFAULT 1,
    created_at            DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS job_logs (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    ran_at  TEXT    NOT NULL,
    status  TEXT    NOT NULL,
    message TEXT,
    source  TEXT    NOT NULL DEFAULT 'scheduler'
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  INSERT OR IGNORE INTO settings (key, value) VALUES
    ('default_timezone',     'Australia/Sydney'),
    ('default_max_retry',    '5'),
    ('check_daily_run',      'true'),
    ('default_ua',           'SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0'),
    ('default_play_duration','300'),
    ('default_device_name',  'Mac'),
    ('ai_base_url',          'https://openrouter.ai/api/v1'),
    ('ai_api_key',           ''),
    ('ai_model',             'nvidia/nemotron-nano-12b-v2-vl:free'),
    ('ai_timeout_ms',        '25000'),
    ('ai_fallback_enabled',  'true'),
    ('account_display_with_tg_name','false'),
    ('log_retention_days',   '0'),
    ('ua_presets',           '[{"name":"SenPlayer (Mac)","value":"SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0"},{"name":"Yamby (Android TV)","value":"Yamby/2.0.3.4(Android)"},{"name":"Hills (Windows)","value":"Hills/0.2.1"},{"name":"Lenna (iOS)","value":"Lenna/1.0.15 CFNetwork/1494.0.7 Darwin/23.4.0"},{"name":"VidHub (iOS)","value":"VidHub/2.2.4"}]');
`);
// Seed ua_presets for existing installs that pre-date this setting
try {
    exports.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run("ua_presets", '[{"name":"SenPlayer (Mac)","value":"SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0"},{"name":"Yamby (Android TV)","value":"Yamby/2.0.3.4(Android)"},{"name":"Hills (Windows)","value":"Hills/0.2.1"},{"name":"Lenna (iOS)","value":"Lenna/1.0.15 CFNetwork/1494.0.7 Darwin/23.4.0"},{"name":"VidHub (iOS)","value":"VidHub/2.2.4"}]');
}
catch { }
/**
 * Runs a data fix-up exactly once, recording completion in the settings table
 * under a migration:<id> key. Value-matching UPDATEs must not re-run on every
 * boot or they silently revert values the user has deliberately set.
 */
function runOnce(id, fn) {
    const flagKey = `migration:${id}`;
    try {
        const done = exports.db
            .prepare("SELECT 1 FROM settings WHERE key = ?")
            .get(flagKey);
        if (done)
            return;
        fn();
        exports.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, '1')").run(flagKey);
    }
    catch (e) {
        console.error(`[db] migration ${id} failed:`, e);
    }
}
// Migrations for columns added after initial schema
try {
    exports.db.exec("ALTER TABLE job_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'scheduler'");
}
catch { }
try {
    exports.db.exec("ALTER TABLE jobs ADD COLUMN config TEXT");
}
catch { }
runOnce("device-name-tg-runner-to-yamby", () => {
    exports.db.exec("UPDATE settings SET value = 'Yamby' WHERE key = 'default_device_name' AND value = 'tg-runner'");
});
runOnce("device-name-yamby-to-mac", () => {
    exports.db.exec("UPDATE settings SET value = 'Mac' WHERE key = 'default_device_name' AND value = 'Yamby'");
});
runOnce("ua-chrome-to-senplayer", () => {
    exports.db.exec("UPDATE settings SET value = 'SenPlayer/6.1.0 CFNetwork/1490.0.4 Darwin/23.2.0' WHERE key = 'default_ua' AND value = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'");
});
runOnce("ua-senplayer-610-to-612", () => {
    exports.db.exec("UPDATE settings SET value = 'SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0' WHERE key = 'default_ua' AND value = 'SenPlayer/6.1.0 CFNetwork/1490.0.4 Darwin/23.2.0'");
});
// Overwrite placeholder preset values written before correct UAs were researched
runOnce("ua-presets-placeholder-fix", () => {
    exports.db.prepare("UPDATE settings SET value = ? WHERE key = 'ua_presets' AND (value LIKE '%ExoPlayerLib%' OR value LIKE '%VidHub/2.1.0%')").run('[{"name":"SenPlayer (Mac)","value":"SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0"},{"name":"Yamby (Android TV)","value":"Yamby/2.0.3.4(Android)"},{"name":"Hills (Windows)","value":"Hills/0.2.1"},{"name":"Lenna (iOS)","value":"Lenna/1.0.15 CFNetwork/1494.0.7 Darwin/23.4.0"},{"name":"VidHub (iOS)","value":"VidHub/2.2.4"}]');
});
try {
    exports.db.exec("ALTER TABLE jobs ADD COLUMN start_command TEXT NOT NULL DEFAULT '/start'");
}
catch { }
try {
    exports.db.exec("ALTER TABLE jobs ADD COLUMN checkin_button TEXT NOT NULL DEFAULT '签到'");
}
catch { }
try {
    exports.db.exec("ALTER TABLE job_logs ADD COLUMN detail TEXT");
}
catch { }
try {
    exports.db.exec("ALTER TABLE job_logs ADD COLUMN retired INTEGER NOT NULL DEFAULT 0");
}
catch { }
try {
    exports.db.exec("ALTER TABLE jobs ADD COLUMN template_id INTEGER REFERENCES job_templates(id) ON DELETE SET NULL");
}
catch { }
try {
    exports.db.exec("ALTER TABLE tg_accounts ADD COLUMN proxy_id TEXT");
}
catch { }
try {
    exports.db.exec("ALTER TABLE tg_accounts ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0");
}
catch { }
try {
    exports.db.exec("ALTER TABLE tg_accounts ADD COLUMN app_client_id TEXT");
}
catch { }
try {
    exports.db.exec("ALTER TABLE tg_accounts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
    // only seed sort_order on first migration; subsequent starts must not overwrite user-defined order
    exports.db.exec("UPDATE tg_accounts SET sort_order = id WHERE sort_order = 0");
}
catch { }
try {
    exports.db.exec("ALTER TABLE jobs ADD COLUMN run_every_days INTEGER NOT NULL DEFAULT 1");
}
catch { }
try {
    exports.db.exec("ALTER TABLE tg_accounts ADD COLUMN tg_display_name TEXT");
}
catch { }
try {
    exports.db.exec("ALTER TABLE tg_accounts ADD COLUMN tg_username TEXT");
}
catch { }
try {
    exports.db.exec("ALTER TABLE tg_accounts ADD COLUMN notes TEXT");
}
catch { }
try {
    exports.db.exec("ALTER TABLE jobs ADD COLUMN retired TEXT");
}
catch { }
// Seed default TG app client profiles (Linux is default)
try {
    exports.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run("tg_app_clients", JSON.stringify([
        {
            id: "preset-ios",
            name: "iOS",
            deviceModel: "iPhone 13 Pro Max",
            systemVersion: "iOS 15.4.1",
            appVersion: "8.4.2",
            langCode: "en",
            langPack: "ios",
            systemLangCode: "en-US",
            isDefault: false,
        },
        {
            id: "preset-android",
            name: "Android",
            deviceModel: "Samsung SM-G991B",
            systemVersion: "Android 12",
            appVersion: "9.1.1",
            langCode: "en",
            langPack: "android",
            systemLangCode: "en-US",
            isDefault: false,
        },
        {
            id: "preset-windows",
            name: "Windows",
            deviceModel: "Desktop",
            systemVersion: "Windows 10",
            appVersion: "4.16.5",
            langCode: "en",
            langPack: "tdesktop",
            systemLangCode: "en-US",
            isDefault: false,
        },
        {
            id: "preset-mac",
            name: "Mac",
            deviceModel: "MacBook Pro",
            systemVersion: "macOS 13.2",
            appVersion: "8.4.2",
            langCode: "en",
            langPack: "macos",
            systemLangCode: "en-US",
            isDefault: false,
        },
        {
            id: "preset-linux",
            name: "Linux",
            deviceModel: "PC 64bit",
            systemVersion: "Ubuntu 22.04 LTS",
            appVersion: "4.16.5",
            langCode: "en",
            langPack: "tdesktop",
            systemLangCode: "en-US",
            isDefault: true,
        },
    ]));
}
catch { }
exports.db.exec(`
  CREATE TABLE IF NOT EXISTS job_templates (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT    NOT NULL,
    job_type         TEXT    NOT NULL DEFAULT 'checkin',
    bot_username     TEXT    NOT NULL DEFAULT '',
    timezone         TEXT    NOT NULL DEFAULT '',
    reply_timeout_ms INTEGER NOT NULL DEFAULT 40000,
    retry_max        INTEGER NOT NULL DEFAULT 5,
    enabled          INTEGER NOT NULL DEFAULT 1,
    config           TEXT,
    start_command    TEXT    NOT NULL DEFAULT '/start',
    checkin_button   TEXT    NOT NULL DEFAULT '签到',
    run_every_days   INTEGER NOT NULL DEFAULT 1,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
// Upgrade path: older databases created job_templates before run_every_days
// existed. This ALTER must run after the CREATE above, not before it. (issue #19)
try {
    exports.db.exec("ALTER TABLE job_templates ADD COLUMN run_every_days INTEGER NOT NULL DEFAULT 1");
}
catch { }
// Jobs and templates historically froze the default timezone at creation, so
// changing the default in Settings never affected them (issue #13). An empty
// timezone now means "follow the default_timezone setting", resolved at
// scheduling time. The per-row value was never exposed in the UI, so existing
// rows all hold stale defaults rather than deliberate choices; blank them.
runOnce("timezone-follow-default", () => {
    exports.db.exec("UPDATE jobs SET timezone = ''");
    exports.db.exec("UPDATE job_templates SET timezone = ''");
});
// AI supplier + model tables
exports.db.exec(`
  CREATE TABLE IF NOT EXISTS ai_suppliers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    base_url   TEXT    NOT NULL,
    api_key    TEXT    NOT NULL DEFAULT '',
    timeout_ms INTEGER NOT NULL DEFAULT 25000
  );
  CREATE TABLE IF NOT EXISTS ai_models (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL REFERENCES ai_suppliers(id) ON DELETE CASCADE,
    model_id    TEXT    NOT NULL,
    label       TEXT
  );
`);
// Seed default OpenRouter supplier on first run; carry over any legacy flat-settings values for upgrades
try {
    const supplierCount = exports.db.prepare("SELECT COUNT(*) AS n FROM ai_suppliers").get().n;
    if (supplierCount === 0) {
        const getSetting = (key) => exports.db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? "";
        const apiKey = getSetting("ai_api_key");
        const baseUrl = getSetting("ai_base_url") || "https://openrouter.ai/api/v1";
        const model = getSetting("ai_model") || "nvidia/nemotron-nano-12b-v2-vl:free";
        const timeout = getSetting("ai_timeout_ms");
        const { lastInsertRowid } = exports.db
            .prepare("INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)")
            .run("OpenRouter", baseUrl, apiKey, Number(timeout) || 25000);
        exports.db.prepare("INSERT INTO ai_models (supplier_id, model_id) VALUES (?, ?)").run(lastInsertRowid, model);
    }
}
catch (e) {
    console.error("[db] AI supplier seed failed:", e);
}
// Make account_id nullable so embywatch jobs don't require a Telegram account
try {
    const cols = exports.db.prepare("PRAGMA table_info(jobs)").all();
    if (cols.find((c) => c.name === "account_id")?.notnull === 1) {
        // job_logs.job_id -> jobs(id) ON DELETE CASCADE: with foreign_keys on,
        // DROP TABLE jobs below fires that cascade and wipes all job history.
        // Turn enforcement off for the swap, per SQLite's documented table-rebuild pattern.
        // The pragma is a no-op inside a transaction, so it must sit outside; the
        // copy/drop/rename runs in one transaction so a crash mid-swap rolls back
        // instead of leaving jobs dropped and the data stranded in jobs_v2.
        exports.db.pragma("foreign_keys = OFF");
        try {
            exports.db.transaction(() => {
                exports.db.exec(`
        DROP TABLE IF EXISTS jobs_v2;
        CREATE TABLE jobs_v2 (
          id                    INTEGER PRIMARY KEY AUTOINCREMENT,
          name                  TEXT    NOT NULL,
          account_id            INTEGER REFERENCES tg_accounts(id) ON DELETE SET NULL,
          job_type              TEXT    NOT NULL DEFAULT 'checkin',
          bot_username          TEXT    NOT NULL,
          schedule_window_start INTEGER NOT NULL DEFAULT 1400,
          schedule_window_end   INTEGER NOT NULL DEFAULT 1600,
          timezone              TEXT    NOT NULL DEFAULT '',
          reply_timeout_ms      INTEGER NOT NULL DEFAULT 40000,
          retry_max             INTEGER NOT NULL DEFAULT 5,
          enabled               INTEGER NOT NULL DEFAULT 1,
          created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
          config                TEXT,
          start_command         TEXT    NOT NULL DEFAULT '/start',
          checkin_button        TEXT    NOT NULL DEFAULT '签到',
          template_id           INTEGER REFERENCES job_templates(id) ON DELETE SET NULL,
          run_every_days        INTEGER NOT NULL DEFAULT 1,
          retired               TEXT
        );
        INSERT INTO jobs_v2 SELECT * FROM jobs;
        DROP TABLE jobs;
        ALTER TABLE jobs_v2 RENAME TO jobs;
      `);
            })();
            console.log("[db] Migrated jobs.account_id to nullable");
        }
        finally {
            exports.db.pragma("foreign_keys = ON");
        }
    }
}
catch (e) {
    console.error("[db] account_id migration failed:", e);
}
// Range support for "run every X days": a nullable upper bound. When set (and
// greater than run_every_days), each scheduling picks a random interval in
// [run_every_days, run_every_days_max]. Added after the jobs table rebuild above
// so its positional `SELECT *` copy isn't broken by an extra column.
try {
    exports.db.exec("ALTER TABLE jobs ADD COLUMN run_every_days_max INTEGER");
}
catch { }
try {
    exports.db.exec("ALTER TABLE job_templates ADD COLUMN run_every_days_max INTEGER");
}
catch { }
// Durable stamp of a job's last successful run. job_logs is pruned by the
// log_retention_days setting, so the derived value cannot be trusted long-term.
// Added after the jobs table rebuild above so its positional `SELECT *` copy
// isn't broken by an extra column.
try {
    exports.db.exec("ALTER TABLE jobs ADD COLUMN last_success_at TEXT");
}
catch { }
// One-shot backfill from whatever log history survives. Guarded by runOnce and
// an IS NULL filter so a later purge never re-writes a live value.
runOnce("jobs-last-success-at-backfill", () => {
    exports.db.exec(`
    UPDATE jobs SET last_success_at = (
      SELECT MAX(l.ran_at) FROM job_logs l
      WHERE l.job_id = jobs.id AND l.status = 'success'
    )
    WHERE last_success_at IS NULL
  `);
});
try {
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS tg_message_cache (
      account_id INTEGER NOT NULL,
      chat_id    TEXT    NOT NULL,
      msg_id     INTEGER NOT NULL,
      msg_date   INTEGER NOT NULL,
      payload    TEXT    NOT NULL,
      PRIMARY KEY (account_id, chat_id, msg_id)
    )
  `);
    exports.db.exec(`CREATE INDEX IF NOT EXISTS idx_tgmc ON tg_message_cache(account_id, chat_id, msg_id DESC)`);
}
catch { }
// Indexes for the job list and log queries, which sort by name / ran_at on every page view
try {
    exports.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_jobs_retired_enabled_name
      ON jobs(retired, enabled, name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_jobs_template_id
      ON jobs(template_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_account_id
      ON jobs(account_id);
    CREATE INDEX IF NOT EXISTS idx_job_logs_ran_at
      ON job_logs(ran_at DESC);
    CREATE INDEX IF NOT EXISTS idx_job_logs_job_ran_at
      ON job_logs(job_id, ran_at DESC);
    CREATE INDEX IF NOT EXISTS idx_job_logs_retired_ran_at
      ON job_logs(retired, ran_at DESC);
  `);
}
catch { }
try {
    exports.db.exec(`
    CREATE TABLE IF NOT EXISTS tg_dialog_cache (
      account_id INTEGER NOT NULL,
      chat_id    TEXT    NOT NULL,
      sort_order INTEGER NOT NULL,
      payload    TEXT    NOT NULL,
      PRIMARY KEY (account_id, chat_id)
    )
  `);
}
catch { }
// Make api_id and api_hash nullable so accounts can fall back to global defaults
try {
    const cols = exports.db.prepare("PRAGMA table_info(tg_accounts)").all();
    if (cols.find((c) => c.name === "api_id")?.notnull === 1) {
        // jobs.account_id -> tg_accounts(id) ON DELETE SET NULL: with foreign_keys
        // on, DROP TABLE tg_accounts below fires that cascade on every linked job,
        // wiping account_id to NULL even though the account itself is preserved
        // under the same id in tg_accounts_v2. Turn enforcement off for the swap,
        // per SQLite's documented table-rebuild pattern. The pragma is a no-op
        // inside a transaction, so it must sit outside; the copy/drop/rename runs
        // in one transaction so a crash mid-swap rolls back cleanly.
        exports.db.pragma("foreign_keys = OFF");
        try {
            exports.db.transaction(() => {
                exports.db.exec(`
        CREATE TABLE tg_accounts_v2 (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          name            TEXT    NOT NULL,
          phone_number    TEXT    NOT NULL,
          api_id          INTEGER,
          api_hash        TEXT,
          session_string  TEXT,
          auth_status     TEXT    NOT NULL DEFAULT 'unauthenticated',
          created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
          proxy_id        TEXT,
          disabled        INTEGER NOT NULL DEFAULT 0,
          app_client_id   TEXT,
          sort_order      INTEGER NOT NULL DEFAULT 0,
          tg_display_name TEXT,
          tg_username     TEXT,
          notes           TEXT
        );
        INSERT INTO tg_accounts_v2 SELECT
          id, name, phone_number,
          NULLIF(api_id, 0), NULLIF(api_hash, ''),
          session_string, auth_status, created_at,
          proxy_id, disabled, app_client_id, sort_order,
          tg_display_name, tg_username, notes
        FROM tg_accounts;
        DROP TABLE tg_accounts;
        ALTER TABLE tg_accounts_v2 RENAME TO tg_accounts;
      `);
            })();
            console.log("[db] Migrated tg_accounts api_id/api_hash to nullable");
        }
        finally {
            exports.db.pragma("foreign_keys = ON");
        }
    }
}
catch (e) {
    console.error("[db] tg_accounts nullable migration failed:", e);
}
// Bemby-owned per-account columns, added after the nullable rebuild above so that
// rebuild's explicit column list stays untouched:
//   passkey               -- the single passkey secret (JSON); kept in its own column,
//                            never serialised to the UI (holds a private key)
//   additional_attributes -- generic UI-safe flags bag (JSON), e.g. email/restriction status
try {
    exports.db.exec("ALTER TABLE tg_accounts ADD COLUMN passkey TEXT");
}
catch { }
try {
    exports.db.exec("ALTER TABLE tg_accounts ADD COLUMN additional_attributes TEXT");
}
catch { }
// One-time move of passkeys from the old settings key-value store (tg_passkey_secrets)
// onto their account's passkey column. When an account held more than one, keep the
// entry with a known DC (the one usable for login). The old setting is then dropped.
runOnce("passkey-settings-to-column", () => {
    const row = exports.db
        .prepare("SELECT value FROM settings WHERE key = 'tg_passkey_secrets'")
        .get();
    if (!row?.value)
        return;
    let store;
    try {
        store = JSON.parse(row.value);
    }
    catch {
        return;
    }
    const chosen = new Map();
    for (const secret of Object.values(store)) {
        const accountId = secret?.accountId;
        if (typeof accountId !== "number")
            continue;
        const current = chosen.get(accountId);
        if (!current || (secret.dcId != null && current.dcId == null)) {
            chosen.set(accountId, secret);
        }
    }
    const upd = exports.db.prepare("UPDATE tg_accounts SET passkey = ? WHERE id = ?");
    for (const [accountId, secret] of chosen) {
        const { accountId: _omit, ...passkey } = secret;
        upd.run(JSON.stringify(passkey), accountId);
    }
    exports.db.prepare("DELETE FROM settings WHERE key = 'tg_passkey_secrets'").run();
});
// Corrective one-off: an earlier build briefly stored the passkey inside the
// additional_attributes bag. Move any stray passkey into the dedicated column (which
// keeps the secret out of the UI-facing bag) and strip it from the bag.
runOnce("passkey-move-out-of-attributes", () => {
    const rows = exports.db
        .prepare("SELECT id, passkey, additional_attributes FROM tg_accounts WHERE additional_attributes IS NOT NULL")
        .all();
    const updBoth = exports.db.prepare("UPDATE tg_accounts SET passkey = ?, additional_attributes = ? WHERE id = ?");
    const updAttrs = exports.db.prepare("UPDATE tg_accounts SET additional_attributes = ? WHERE id = ?");
    for (const r of rows) {
        let bag;
        try {
            bag = JSON.parse(r.additional_attributes);
        }
        catch {
            continue;
        }
        if (!bag || typeof bag !== "object" || !("passkey" in bag))
            continue;
        const { passkey, ...rest } = bag;
        const restJson = Object.keys(rest).length ? JSON.stringify(rest) : null;
        if (!r.passkey && passkey && typeof passkey === "object") {
            const { accountId: _omit, ...stored } = passkey;
            updBoth.run(JSON.stringify(stored), restJson, r.id);
        }
        else {
            updAttrs.run(restJson, r.id);
        }
    }
});
// With BEMBY_DATA_KEY configured, bring any credential still sitting in plain text up to
// date. Not a runOnce migration: the key can be turned on at any point, and rows written
// while it was off have to be caught the next time the app starts with it on. Rows already
// encrypted are skipped, so this costs a single scan on a boot with nothing to do.
try {
    if ((0, secretColumns_1.isSecretEncryptionEnabled)()) {
        const rows = exports.db
            .prepare("SELECT id, api_hash, session_string, passkey FROM tg_accounts")
            .all();
        const upd = exports.db.prepare("UPDATE tg_accounts SET api_hash = ?, session_string = ?, passkey = ? WHERE id = ?");
        let converted = 0;
        exports.db.transaction(() => {
            for (const r of rows) {
                const pending = secretColumns_1.ENCRYPTED_ACCOUNT_COLUMNS.some((c) => r[c] && !(0, secretColumns_1.isEncryptedSecret)(r[c]));
                if (!pending)
                    continue;
                upd.run((0, secretColumns_1.encryptSecret)(r.api_hash), (0, secretColumns_1.encryptSecret)(r.session_string), (0, secretColumns_1.encryptSecret)(r.passkey), r.id);
                converted++;
            }
        })();
        if (converted) {
            console.log(`[secrets] encrypted stored credentials for ${converted} account(s)`);
        }
    }
    else {
        const anyStored = exports.db
            .prepare("SELECT 1 FROM tg_accounts WHERE session_string IS NOT NULL OR passkey IS NOT NULL LIMIT 1")
            .get();
        if (anyStored) {
            console.warn("[secrets] Telegram session strings and passkeys are stored unencrypted. Set " +
                "BEMBY_DATA_KEY to encrypt them at rest (see env.example).");
        }
    }
}
catch (e) {
    console.error("[secrets] encryption sweep failed:", e);
}
exports.FALLBACK_TIMEZONE = "Australia/Sydney";
/** Returns the default_timezone setting, or the built-in fallback when unset. */
function getDefaultTimezone() {
    try {
        const row = exports.db
            .prepare("SELECT value FROM settings WHERE key = 'default_timezone'")
            .get();
        return row?.value || exports.FALLBACK_TIMEZONE;
    }
    catch {
        return exports.FALLBACK_TIMEZONE;
    }
}
/** Returns the global fallback TG API credentials, or null if not configured. */
function getDefaultTgApiCredentials() {
    try {
        const idRow = exports.db
            .prepare("SELECT value FROM settings WHERE key = ?")
            .get("default_tg_api_id");
        const hashRow = exports.db
            .prepare("SELECT value FROM settings WHERE key = ?")
            .get("default_tg_api_hash");
        const apiId = Number(idRow?.value);
        const apiHash = hashRow?.value ?? "";
        if (!apiId || !apiHash)
            return null;
        return { apiId, apiHash };
    }
    catch {
        return null;
    }
}
