"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.previewDeviceModel = previewDeviceModel;
exports.resolveAppClientParams = resolveAppClientParams;
const database_1 = require("../db/database");
const checkin_1 = require("../jobs/checkin");
// Per-account map of the randomly-assigned app client, keyed by account id.
// Kept in the settings table so a random pick stays stable for an account.
const ASSIGNMENTS_KEY = "tg_client_assignments";
// Per-account cache of the expanded deviceModel string. Persisting it keeps
// random tokens (e.g. {word:4}) stable across connects; we only re-expand when
// the source template or the account context changes (see `sig`).
const DEVICE_NAMES_KEY = "tg_client_device_names";
function readAppClients() {
    try {
        const row = database_1.db
            .prepare("SELECT value FROM settings WHERE key = ?")
            .get("tg_app_clients");
        if (!row?.value)
            return [];
        return JSON.parse(row.value);
    }
    catch {
        return [];
    }
}
function readAssignments() {
    try {
        const row = database_1.db
            .prepare("SELECT value FROM settings WHERE key = ?")
            .get(ASSIGNMENTS_KEY);
        if (!row?.value)
            return {};
        return JSON.parse(row.value);
    }
    catch {
        return {};
    }
}
function saveAssignment(accountId, clientId) {
    const map = readAssignments();
    map[String(accountId)] = clientId;
    database_1.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(ASSIGNMENTS_KEY, JSON.stringify(map));
}
function readDeviceNames() {
    try {
        const row = database_1.db
            .prepare("SELECT value FROM settings WHERE key = ?")
            .get(DEVICE_NAMES_KEY);
        if (!row?.value)
            return {};
        return JSON.parse(row.value);
    }
    catch {
        return {};
    }
}
function saveDeviceName(accountId, entry) {
    const map = readDeviceNames();
    map[String(accountId)] = entry;
    database_1.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(DEVICE_NAMES_KEY, JSON.stringify(map));
}
/**
 * Resolve the deviceModel for an account, expanding template variables.
 * Supported tokens: {name} (Bemby name), {tgName} (Telegram display name),
 * {tgUsername}, {id}, plus the random tokens from expandCommand ({word:4} etc.).
 * The expanded value is persisted per account so random tokens stay stable;
 * it is only re-rolled when the template or account context changes.
 */
function resolveDeviceModel(accountId, client, persist = true) {
    const template = client.deviceModel;
    // Fast path: no variables to expand.
    if (!template.includes("{"))
        return template;
    const acct = database_1.db
        .prepare("SELECT name, tg_display_name, tg_username FROM tg_accounts WHERE id = ?")
        .get(accountId);
    const context = {
        name: acct?.name ?? "",
        tgName: acct?.tg_display_name ?? "",
        tgUsername: acct?.tg_username ?? "",
        id: String(accountId),
    };
    // Signature captures everything that should trigger a re-expansion.
    const sig = [
        client.id,
        template,
        context.name,
        context.tgName,
        context.tgUsername,
    ].join("|");
    const cached = readDeviceNames()[String(accountId)];
    if (cached && cached.sig === sig)
        return cached.deviceModel;
    const expanded = (0, checkin_1.expandCommand)(template, context);
    if (persist)
        saveDeviceName(accountId, { sig, deviceModel: expanded });
    return expanded;
}
/**
 * Read-only preview of the device model an account would use for a given
 * (possibly hypothetical) client selection. Does not persist random tokens or
 * random-client assignments, so it is safe to call for UI previews.
 * Returns null when no clients are configured / resolvable.
 */
function previewDeviceModel(accountId, appClientId) {
    try {
        const list = readAppClients();
        if (!list.length)
            return null;
        let client;
        if (appClientId) {
            client = list.find((c) => c.id === appClientId);
        }
        else {
            const modeRow = database_1.db
                .prepare("SELECT value FROM settings WHERE key = ?")
                .get("tg_client_mode");
            if (modeRow?.value === "random") {
                // Reuse an existing sticky pick if present; otherwise fall back to the
                // default as an illustrative preview (the real pick happens on connect).
                const assignedId = readAssignments()[String(accountId)];
                client =
                    (assignedId && list.find((c) => c.id === assignedId)) ||
                        list.find((c) => c.isDefault);
            }
            else {
                client = list.find((c) => c.isDefault);
            }
        }
        if (!client)
            return null;
        return resolveDeviceModel(accountId, client, false);
    }
    catch {
        return null;
    }
}
function toDeviceParams(accountId, c) {
    return {
        deviceModel: resolveDeviceModel(accountId, c),
        systemVersion: c.systemVersion,
        appVersion: c.appVersion,
        langCode: c.langCode,
        langPack: c.langPack,
        systemLangCode: c.systemLangCode,
    };
}
/**
 * Resolve the Telegram device params for an account.
 * - Explicit appClientId: use that client.
 * - No client + random mode: use a per-account sticky random pick that is
 *   persisted, so the same device is reused for auth, jobs and the live client.
 *   Only re-rolls if the previously assigned client no longer exists.
 * - Otherwise: use the default client.
 */
function resolveAppClientParams(accountId, appClientId) {
    try {
        const list = readAppClients();
        if (!list.length)
            return undefined;
        if (appClientId) {
            const client = list.find((c) => c.id === appClientId);
            return client ? toDeviceParams(accountId, client) : undefined;
        }
        const modeRow = database_1.db
            .prepare("SELECT value FROM settings WHERE key = ?")
            .get("tg_client_mode");
        if (modeRow?.value === "random") {
            const assignedId = readAssignments()[String(accountId)];
            const assigned = assignedId
                ? list.find((c) => c.id === assignedId)
                : undefined;
            if (assigned)
                return toDeviceParams(accountId, assigned);
            // First random pick for this account -- persist it so it stays stable.
            const picked = list[Math.floor(Math.random() * list.length)];
            saveAssignment(accountId, picked.id);
            return toDeviceParams(accountId, picked);
        }
        const def = list.find((c) => c.isDefault);
        return def ? toDeviceParams(accountId, def) : undefined;
    }
    catch {
        return undefined;
    }
}
