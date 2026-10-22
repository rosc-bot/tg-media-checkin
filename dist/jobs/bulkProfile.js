"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBulkProfileStatus = getBulkProfileStatus;
exports.cancelBulkProfile = cancelBulkProfile;
exports.startBulkProfile = startBulkProfile;
const crypto_1 = __importDefault(require("crypto"));
const database_1 = require("../db/database");
const secretColumns_1 = require("../db/secretColumns");
const tgAuth_1 = require("../auth/tgAuth");
const runner_1 = require("./runner");
const appClient_1 = require("../tg/appClient");
const liveClient_1 = require("../tg/liveClient");
const DEFAULT_GAP_SECONDS = 3;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_SECONDS = 60;
function resolveConfig(opts) {
    const gap = Number(opts?.gapSeconds);
    const retries = Number(opts?.maxRetries);
    const retryDelay = Number(opts?.retryDelaySeconds);
    return {
        betweenAccountsMs: Number.isFinite(gap) && gap >= 0
            ? gap * 1000
            : DEFAULT_GAP_SECONDS * 1000,
        maxRetries: Number.isFinite(retries) && retries >= 0
            ? Math.floor(retries)
            : DEFAULT_MAX_RETRIES,
        retryDelayMs: Number.isFinite(retryDelay) && retryDelay >= 0
            ? retryDelay * 1000
            : DEFAULT_RETRY_DELAY_SECONDS * 1000,
    };
}
let current = null;
function getBulkProfileStatus() {
    return current;
}
function cancelBulkProfile() {
    if (!current || !current.running)
        return false;
    current.cancelled = true;
    return true;
}
function resolveProxyUrl(proxyId) {
    if (!proxyId)
        return undefined;
    const row = database_1.db
        .prepare("SELECT value FROM settings WHERE key = ?")
        .get("proxies");
    try {
        const list = row?.value
            ? JSON.parse(row.value)
            : [];
        return list.find((p) => p.id === proxyId)?.url;
    }
    catch {
        return undefined;
    }
}
// Abortable sleep -- resolves early when the batch is cancelled.
function sleep(ms, batch) {
    return new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
            if (batch.cancelled || Date.now() - start >= ms) {
                resolve();
                return;
            }
            setTimeout(tick, Math.min(1000, ms));
        };
        tick();
    });
}
async function updateOne(item) {
    const account = database_1.db
        .prepare("SELECT * FROM tg_accounts WHERE id = ?")
        .get(item.accountId);
    if (!account)
        throw new Error("Account not found");
    (0, secretColumns_1.decryptAccountRow)(account);
    if (account.auth_status !== "authenticated" || !account.session_string) {
        throw new Error("Account is not authenticated");
    }
    const own = account.api_id && account.api_hash
        ? { apiId: account.api_id, apiHash: account.api_hash }
        : null;
    const creds = own ?? (0, database_1.getDefaultTgApiCredentials)();
    if (!creds) {
        throw new Error("No API credentials -- configure global defaults in Settings");
    }
    const proxy = (0, runner_1.parseTgProxy)(resolveProxyUrl(account.proxy_id));
    const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
    const profile = await (0, tgAuth_1.updateProfile)(creds.apiId, creds.apiHash, account.session_string, { firstName: item.firstName, lastName: item.lastName, about: item.about }, proxy, deviceParams);
    // Keep the cached display name in sync with the new profile.
    const displayName = [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null;
    database_1.db.prepare("UPDATE tg_accounts SET tg_display_name = ? WHERE id = ?").run(displayName, account.id);
}
async function runBatch(batch, config) {
    try {
        const queue = batch.items.map((item) => ({
            item,
            readyAt: 0,
        }));
        const totalAttempts = config.maxRetries + 1;
        let processedAny = false;
        while (queue.length && !batch.cancelled) {
            const entry = queue.shift();
            const { item } = entry;
            const cooldownMs = entry.readyAt - Date.now();
            if (cooldownMs > 0) {
                item.status = "retrying";
                item.message = `Retrying in ${Math.round(cooldownMs / 1000)}s (attempt ${item.attempts + 1}/${totalAttempts})`;
                await sleep(cooldownMs, batch);
                if (batch.cancelled)
                    break;
            }
            // The gap spaces successive Telegram calls; applied before every update
            // except the first.
            if (processedAny) {
                item.status = "waiting";
                item.message = `Waiting ${Math.round(config.betweenAccountsMs / 1000)}s before updating`;
                await sleep(config.betweenAccountsMs, batch);
                if (batch.cancelled)
                    break;
            }
            item.attempts++;
            item.status = "updating";
            item.message = "Updating profile";
            try {
                await updateOne(item);
                item.status = "done";
                item.message = "Profile updated";
                item.error = null;
            }
            catch (err) {
                const reason = err?.message ?? String(err);
                if ((0, liveClient_1.isAuthError)(reason))
                    (0, liveClient_1.markSessionExpired)(item.accountId);
                if (item.attempts <= config.maxRetries && !batch.cancelled) {
                    entry.readyAt = Date.now() + config.retryDelayMs;
                    item.status = "retrying";
                    item.error = null;
                    item.message = `Attempt ${item.attempts}/${totalAttempts} failed (${reason}) -- retrying in ${Math.round(config.retryDelayMs / 1000)}s`;
                    queue.push(entry);
                }
                else {
                    item.status = "failed";
                    item.error = reason;
                    item.message = `Failed after ${item.attempts} attempt(s): ${reason}`;
                }
            }
            processedAny = true;
        }
    }
    finally {
        batch.running = false;
    }
}
function startBulkProfile(entries, options) {
    if (current?.running) {
        return { ok: false, error: "A bulk-rename batch is already running" };
    }
    if (!Array.isArray(entries) || !entries.length) {
        return { ok: false, error: "No accounts provided" };
    }
    const items = [];
    for (const [index, entry] of entries.entries()) {
        const accountId = Number(entry?.accountId);
        const firstName = String(entry?.firstName ?? "").trim();
        if (!Number.isInteger(accountId) || accountId <= 0) {
            return { ok: false, error: `Invalid account id on row ${index + 1}` };
        }
        if (!firstName) {
            return { ok: false, error: `First name is required on row ${index + 1}` };
        }
        const row = database_1.db
            .prepare("SELECT id, name FROM tg_accounts WHERE id = ?")
            .get(accountId);
        if (!row) {
            return { ok: false, error: `Account ${accountId} not found` };
        }
        items.push({
            index,
            accountId,
            accountName: row.name,
            firstName,
            lastName: String(entry?.lastName ?? "").trim(),
            about: String(entry?.about ?? "").trim(),
            attempts: 0,
            status: "pending",
            message: "",
            error: null,
        });
    }
    const config = resolveConfig(options);
    const batch = {
        id: crypto_1.default.randomUUID(),
        createdAt: new Date().toISOString(),
        running: true,
        cancelled: false,
        total: items.length,
        items,
    };
    current = batch;
    void runBatch(batch, config);
    return { ok: true, batch };
}
