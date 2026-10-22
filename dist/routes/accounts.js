"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = require("../db/database");
const list_query_1 = require("./list-query");
const tgAuth_1 = require("../auth/tgAuth");
const checkin_1 = require("../jobs/checkin");
const profileGen_1 = require("../jobs/profileGen");
const bulkAdd_1 = require("../jobs/bulkAdd");
const bulkProfile_1 = require("../jobs/bulkProfile");
const bulkLoginEmail_1 = require("../jobs/bulkLoginEmail");
const runner_1 = require("../jobs/runner");
const appClient_1 = require("../tg/appClient");
const liveClient_1 = require("../tg/liveClient");
const passkeyStore_1 = require("../tg/passkeyStore");
const accountAttributes_1 = require("../db/accountAttributes");
const scheduler_1 = require("../scheduler");
const exportCrypto_1 = require("../db/exportCrypto");
const secretColumns_1 = require("../db/secretColumns");
// Reasons set by checkAccountStatus for frozen/revoked sessions that need re-auth
const REAUTH_REASONS = new Set([
    "auth_key_duplicated",
    "session_revoked",
    "auth_key_unregistered",
    "account_frozen",
]);
function statusNeedsReauth(status) {
    return status.restrictions.some((r) => REAUTH_REASONS.has(r.reason.toLowerCase()));
}
function internalError(res, err, context) {
    console.error(`[accounts] ${context}:`, err);
    res.status(500).json({ error: 'An internal error occurred' });
}
// Surface Telegram RPC refusals (e.g. EMAIL_NOT_ALLOWED) as a 400 with the raw
// error code so the frontend can translate them; returns false for other errors.
function rpcBadRequest(res, err, context) {
    if (typeof err?.errorMessage !== "string" || typeof err?.code !== "number")
        return false;
    console.warn(`[accounts] ${context}: RPC ${err.errorMessage}`);
    res.status(400).json({ error: err.errorMessage });
    return true;
}
const router = (0, express_1.Router)();
/**
 * Loads one account with its credential columns decrypted. Every handler below goes through
 * this rather than querying directly, so the decryption cannot be forgotten at a call site
 * (see db/secretColumns for why the columns are encrypted at all).
 */
function loadAccount(id) {
    const row = database_1.db.prepare("SELECT * FROM tg_accounts WHERE id = ?").get(id);
    return row ? (0, secretColumns_1.decryptAccountRow)(row) : undefined;
}
/** Resolves effective API credentials, falling back to global defaults. Throws if neither is set. */
function resolveApiCredentials(account) {
    const ownCredentials = account.api_id && account.api_hash
        ? { apiId: account.api_id, apiHash: account.api_hash }
        : null;
    const credentials = ownCredentials ?? (0, database_1.getDefaultTgApiCredentials)();
    const apiId = credentials?.apiId;
    const apiHash = credentials?.apiHash;
    if (!apiId || !apiHash) {
        throw new Error("No API credentials available. Add credentials to this account or configure global defaults in Settings.");
    }
    return { apiId, apiHash };
}
function resolveProxyUrl(proxyId) {
    if (!proxyId)
        return undefined;
    try {
        const row = database_1.db
            .prepare("SELECT value FROM settings WHERE key = ?")
            .get("proxies");
        if (!row?.value)
            return undefined;
        const list = JSON.parse(row.value);
        return list.find((p) => p.id === proxyId)?.url;
    }
    catch {
        return undefined;
    }
}
function toJson(row) {
    return {
        id: row.id,
        name: row.name,
        phoneNumber: row.phone_number,
        apiId: row.api_id ?? null,
        // apiHash intentionally omitted from responses
        /** True when the account has no per-account credentials and relies on global defaults. */
        usesDefaultCredentials: !row.api_id || !row.api_hash,
        authStatus: row.auth_status,
        proxyId: row.proxy_id ?? null,
        disabled: Boolean(row.disabled),
        appClientId: row.app_client_id ?? null,
        createdAt: row.created_at,
        sortOrder: row.sort_order ?? 0,
        tgDisplayName: row.tg_display_name ?? null,
        tgUsername: row.tg_username ?? null,
        notes: row.notes ?? null,
        resolvedDeviceModel: (0, appClient_1.previewDeviceModel)(row.id, row.app_client_id),
        // Generic UI-safe flags; the passkey secret is deliberately never included here.
        attributes: (0, accountAttributes_1.publicAttributes)((0, accountAttributes_1.parseAttributes)(row.additional_attributes)),
        // Whether the Telegram account has ANY passkey (any device/origin). Sourced from the
        // stored flag, refreshed whenever Bemby lists the account's passkeys.
        hasPasskey: (0, accountAttributes_1.parseAttributes)(row.additional_attributes).hasPasskey ??
            false,
        // Whether Bemby holds a stored passkey usable for login (its home DC is known).
        hasBembyPasskey: (0, passkeyStore_1.parseStoredPasskey)(row.passkey)?.dcId != null,
    };
}
function saveTgMeta(id, firstName, lastName, username) {
    const displayName = [firstName, lastName].filter(Boolean).join(" ");
    database_1.db.prepare("UPDATE tg_accounts SET tg_display_name = ?, tg_username = ? WHERE id = ?").run(displayName || null, username || null, id);
}
const ACCOUNT_SORTS = {
    order: "sort_order, id",
    name: "name COLLATE NOCASE",
    phone: "phone_number",
    status: "auth_status",
    created: "created_at",
};
router.get("/", (req, res) => {
    const query = req.query;
    const paging = (0, list_query_1.parsePaging)(query);
    const search = (0, list_query_1.textParam)(query.search);
    const authStatus = (0, list_query_1.textParam)(query.authStatus);
    const disabled = (0, list_query_1.textParam)(query.disabled);
    const conditions = [];
    const params = [];
    if (search) {
        conditions.push(`(
      name LIKE ? ESCAPE '\\' OR phone_number LIKE ? ESCAPE '\\'
      OR COALESCE(tg_display_name, '') LIKE ? ESCAPE '\\'
      OR COALESCE(tg_username, '') LIKE ? ESCAPE '\\'
      OR COALESCE(notes, '') LIKE ? ESCAPE '\\'
    )`);
        const like = `%${(0, list_query_1.escapeLike)(search)}%`;
        params.push(like, like, like, like, like);
    }
    if (authStatus) {
        conditions.push("auth_status = ?");
        params.push(authStatus);
    }
    if (disabled === "1" || disabled === "0") {
        conditions.push("COALESCE(disabled, 0) = ?");
        params.push(Number(disabled));
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const orderClause = (0, list_query_1.parseSort)(query, ACCOUNT_SORTS, ACCOUNT_SORTS.order);
    if (!paging) {
        const rows = database_1.db
            .prepare(`SELECT * FROM tg_accounts ${where} ORDER BY ${orderClause}`)
            .all(...params);
        rows.forEach(secretColumns_1.decryptAccountRow);
        res.json(rows.map(toJson));
        return;
    }
    const totalRow = database_1.db
        .prepare(`SELECT COUNT(*) AS total FROM tg_accounts ${where}`)
        .get(...params);
    const rows = database_1.db
        .prepare(`SELECT * FROM tg_accounts ${where} ORDER BY ${orderClause} LIMIT ? OFFSET ?`)
        .all(...params, paging.limit, paging.offset);
    rows.forEach(secretColumns_1.decryptAccountRow);
    res.json({
        items: rows.map(toJson),
        total: totalRow.total,
        page: paging.page,
        pageSize: paging.pageSize,
    });
});
router.post("/", (req, res) => {
    const { name, phoneNumber, apiId, apiHash, proxyId, appClientId, notes } = req.body;
    if (!name || !phoneNumber) {
        res.status(400).json({ error: "name and phoneNumber are required" });
        return;
    }
    // API credentials required unless global defaults are configured
    if ((!apiId || !apiHash) && !(0, database_1.getDefaultTgApiCredentials)()) {
        res.status(400).json({
            error: "apiId and apiHash are required (or configure global defaults in Settings)",
        });
        return;
    }
    const maxRow = database_1.db
        .prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM tg_accounts")
        .get();
    const result = database_1.db
        .prepare("INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, proxy_id, app_client_id, sort_order, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(name, phoneNumber, apiId ? Number(apiId) : null, (0, secretColumns_1.encryptSecret)(apiHash || null), proxyId || null, appClientId || null, maxRow.m + 1, notes || null);
    const row = loadAccount(result.lastInsertRowid);
    res.status(201).json(toJson(row));
});
// POST /bulk-add -- create accounts from "phone----apiUrl" lines, then
// authenticate them one by one using codes/2FA served by each API page
// Reject bulk-management requests unless enabled via BULK_ACCOUNT_MANAGEMENT
const bulkMgmtGuard = (_req, res, next) => {
    if (!(0, bulkAdd_1.isBulkAccountManagementEnabled)()) {
        res.status(403).json({ error: "Bulk account management is not enabled" });
        return;
    }
    next();
};
router.post("/bulk-add", bulkMgmtGuard, (req, res) => {
    const { text, options } = req.body;
    if (!text || !text.trim()) {
        res.status(400).json({ error: "text is required" });
        return;
    }
    const result = (0, bulkAdd_1.startBulkAdd)(text, options);
    if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
    }
    res.status(201).json(result.batch);
});
// GET /bulk-add/status -- current batch progress (null if none has run)
router.get("/bulk-add/status", bulkMgmtGuard, (_req, res) => {
    res.json((0, bulkAdd_1.getBulkAddStatus)());
});
// POST /bulk-add/cancel -- stop the running batch after the current step
router.post("/bulk-add/cancel", bulkMgmtGuard, (_req, res) => {
    res.json({ cancelled: (0, bulkAdd_1.cancelBulkAdd)() });
});
// POST /bulk-profile -- update first/last name + bio on many accounts at once
router.post("/bulk-profile", bulkMgmtGuard, (req, res) => {
    const { items, options } = req.body;
    if (!Array.isArray(items) || !items.length) {
        res.status(400).json({ error: "items array required" });
        return;
    }
    const result = (0, bulkProfile_1.startBulkProfile)(items, options);
    if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
    }
    res.status(201).json(result.batch);
});
// POST /bulk-profile/generate -- AI-written profiles, cleaned to what Telegram accepts
router.post("/bulk-profile/generate", bulkMgmtGuard, async (req, res) => {
    const { count, hint, includeAbout } = req.body;
    const wanted = Number(count);
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > 200) {
        res.status(400).json({ error: "count must be between 1 and 200" });
        return;
    }
    try {
        const { profiles } = await (0, profileGen_1.generateProfiles)(wanted, hint?.trim() || undefined, includeAbout !== false);
        res.json({ profiles });
    }
    catch (err) {
        res.status(502).json({ error: err?.message ?? "Profile generation failed" });
    }
});
// GET /bulk-profile/status -- current batch progress (null if none has run)
router.get("/bulk-profile/status", bulkMgmtGuard, (_req, res) => {
    res.json((0, bulkProfile_1.getBulkProfileStatus)());
});
// POST /bulk-profile/cancel -- stop the running batch after the current step
router.post("/bulk-profile/cancel", bulkMgmtGuard, (_req, res) => {
    res.json({ cancelled: (0, bulkProfile_1.cancelBulkProfile)() });
});
// POST /gmail/test -- check Gmail IMAP login works (for bulk login-email change)
router.post("/gmail/test", bulkMgmtGuard, async (req, res) => {
    const { gmail, appPassword } = req.body;
    if (!gmail || !gmail.includes("@") || !appPassword) {
        res.status(400).json({ error: "gmail and appPassword are required" });
        return;
    }
    const result = await (0, bulkLoginEmail_1.testGmailImap)(gmail.trim(), appPassword);
    res.json(result);
});
// PUT /reorder -- update sort_order for multiple accounts at once
router.put("/reorder", (req, res) => {
    const { items } = req.body;
    if (!Array.isArray(items)) {
        res.status(400).json({ error: "items array required" });
        return;
    }
    const update = database_1.db.prepare("UPDATE tg_accounts SET sort_order = ? WHERE id = ?");
    const tx = database_1.db.transaction(() => {
        for (const { id, sortOrder } of items)
            update.run(sortOrder, id);
    });
    tx();
    res.json({ ok: true });
});
// PUT /bulk-notes -- update notes for multiple accounts at once
router.put("/bulk-notes", (req, res) => {
    const { ids, notes } = req.body;
    if (!Array.isArray(ids) || !ids.length) {
        res.status(400).json({ error: "ids array required" });
        return;
    }
    const newNotes = notes || null;
    const update = database_1.db.prepare("UPDATE tg_accounts SET notes = ? WHERE id = ?");
    const tx = database_1.db.transaction(() => {
        for (const id of ids)
            update.run(newNotes, id);
    });
    tx();
    res.json({ ok: true });
});
// PUT /bulk-rename -- set the Bemby name for multiple accounts at once. Each
// item carries its own pre-computed name; blank names are skipped.
router.put("/bulk-rename", (req, res) => {
    const { items } = req.body;
    if (!Array.isArray(items) || !items.length) {
        res.status(400).json({ error: "items array required" });
        return;
    }
    const update = database_1.db.prepare("UPDATE tg_accounts SET name = ? WHERE id = ?");
    const tx = database_1.db.transaction(() => {
        for (const { id, name } of items) {
            const trimmed = String(name ?? "").trim();
            if (trimmed)
                update.run(trimmed, id);
        }
    });
    tx();
    res.json({ ok: true });
});
// POST /export -- export selected (or all) accounts with sensitive fields
router.post("/export", (req, res) => {
    const { ids, secret } = req.body;
    let rows;
    if (Array.isArray(ids) && ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        rows = database_1.db
            .prepare(`SELECT * FROM tg_accounts WHERE id IN (${placeholders}) ORDER BY id`)
            .all(...ids);
    }
    else {
        rows = database_1.db
            .prepare("SELECT * FROM tg_accounts ORDER BY id")
            .all();
    }
    // A backup carries the credentials in the clear inside its own encrypted envelope, so the
    // at-rest key is never needed to restore one somewhere else
    rows.forEach(secretColumns_1.decryptAccountRow);
    const payload = {
        version: "1",
        exportedAt: new Date().toISOString(),
        accounts: rows.map((a) => ({
            name: a.name,
            phoneNumber: a.phone_number,
            apiId: a.api_id,
            apiHash: a.api_hash,
            sessionString: a.session_string,
            authStatus: a.auth_status,
            proxyId: a.proxy_id ?? null,
            appClientId: a.app_client_id ?? null,
            disabled: Boolean(a.disabled),
            // Passkey secret (incl. private key + home DC) so the account can still log in
            // after import, even when force-reauth clears the session string.
            passkey: (0, passkeyStore_1.parseStoredPasskey)(a.passkey),
            // Generic per-account flags bag.
            additionalAttributes: (0, accountAttributes_1.parseAttributes)(a.additional_attributes),
        })),
    };
    const hasSecrets = payload.accounts.some((a) => a.sessionString != null || a.apiHash || a.passkey?.privateKeyPem);
    if (hasSecrets && !secret) {
        res.status(400).json({
            error: 'This export contains session strings or API credentials. Provide an encryption secret.',
            code: 'SECRET_REQUIRED',
        });
        return;
    }
    if (secret) {
        res.json((0, exportCrypto_1.encryptPayload)(JSON.stringify(payload), secret));
    }
    else {
        res.json(payload);
    }
});
// POST /import -- import accounts; skips existing by phone number
router.post("/import", (req, res) => {
    let { data, secret, forceReauth = true, } = req.body;
    if (data && data.encrypted === true) {
        if (!secret) {
            res
                .status(400)
                .json({
                error: "This backup is encrypted. Please provide the secret to decrypt it.",
            });
            return;
        }
        try {
            data = JSON.parse((0, exportCrypto_1.decryptPayload)(data, secret));
        }
        catch {
            res
                .status(400)
                .json({
                error: "Incorrect secret or corrupted backup file",
                code: "WRONG_SECRET",
            });
            return;
        }
    }
    const payload = data;
    const items = payload?.accounts;
    if (!Array.isArray(items)) {
        res.status(400).json({ error: "accounts array required" });
        return;
    }
    let imported = 0;
    let skipped = 0;
    const defaults = (0, database_1.getDefaultTgApiCredentials)();
    database_1.db.transaction(() => {
        for (const a of items) {
            if (!a.phoneNumber || ((!a.apiId || !a.apiHash) && !defaults)) {
                skipped++;
                continue;
            }
            const existing = database_1.db
                .prepare("SELECT id FROM tg_accounts WHERE phone_number = ?")
                .get(a.phoneNumber);
            if (existing) {
                skipped++;
                continue;
            }
            const info = database_1.db
                .prepare("INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, session_string, auth_status, proxy_id, app_client_id, disabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
                .run(a.name || a.phoneNumber, a.phoneNumber, a.apiId ? Number(a.apiId) : null, (0, secretColumns_1.encryptSecret)(a.apiHash), (0, secretColumns_1.encryptSecret)(forceReauth ? null : (a.sessionString ?? null)), forceReauth ? "unauthenticated" : (a.authStatus ?? "unauthenticated"), a.proxyId ?? null, a.appClientId ?? null, a.disabled ? 1 : 0);
            const newId = Number(info.lastInsertRowid);
            // Restore the passkey secret under the newly assigned account id. The passkey (with
            // its home DC) is what lets the account log in after a force-reauth import.
            const pk = (0, passkeyStore_1.importedPasskeyFor)(a);
            if (pk)
                (0, passkeyStore_1.savePasskeySecret)({ ...pk, accountId: newId });
            // Restore the generic attributes bag.
            const attrs = (0, accountAttributes_1.foldImportedAttributes)(a);
            if (attrs)
                (0, accountAttributes_1.writeAttributes)(newId, attrs);
            imported++;
        }
    })();
    res.json({ imported, skipped });
});
router.put("/:id", (req, res) => {
    const { name, phoneNumber, apiId, apiHash, proxyId, disabled, appClientId, notes, } = req.body;
    const existing = loadAccount(req.params.id);
    if (!existing) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    // undefined = not in payload (keep existing), null/'' = clear
    const newProxyId = proxyId !== undefined ? proxyId || null : existing.proxy_id;
    const newDisabled = disabled !== undefined ? (disabled ? 1 : 0) : existing.disabled;
    const newAppClientId = appClientId !== undefined ? appClientId || null : existing.app_client_id;
    const newNotes = notes !== undefined ? notes || null : existing.notes;
    database_1.db.prepare("UPDATE tg_accounts SET name = ?, phone_number = ?, api_id = ?, api_hash = ?, proxy_id = ?, disabled = ?, app_client_id = ?, notes = ? WHERE id = ?").run(name ?? existing.name, phoneNumber ?? existing.phone_number, apiId !== undefined ? Number(apiId) : existing.api_id, (0, secretColumns_1.encryptSecret)(apiHash ?? existing.api_hash), newProxyId, newDisabled, newAppClientId, newNotes, req.params.id);
    const row = loadAccount(req.params.id);
    res.json(toJson(row));
});
router.delete("/:id", (req, res) => {
    // checkin/custom jobs can't run without their linked account; deleting it here
    // would silently drop the job out of the scheduler (account_id -> NULL via FK)
    const linkedJobs = database_1.db
        .prepare("SELECT name FROM jobs WHERE account_id = ? AND retired IS NULL AND (job_type = 'checkin' OR job_type = 'custom')")
        .all(req.params.id);
    if (linkedJobs.length) {
        res.status(400).json({
            error: `Cannot delete account: ${linkedJobs.length} job(s) still depend on it (${linkedJobs.map((j) => j.name).join(", ")}). Reassign or delete those jobs first.`,
        });
        return;
    }
    database_1.db.prepare("DELETE FROM tg_accounts WHERE id = ?").run(req.params.id);
    (0, scheduler_1.refreshScheduler)();
    res.status(204).send();
});
// ── TG account status check ─────────────────────────────────────────────────
router.post("/:id/check-status", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!account) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    if (!account.session_string) {
        res.status(400).json({ error: "Account not authenticated" });
        return;
    }
    try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxyUrl = resolveProxyUrl(account.proxy_id);
        const proxy = (0, runner_1.parseTgProxy)(proxyUrl);
        const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
        const status = await (0, tgAuth_1.checkAccountStatus)(apiId, apiHash, account.session_string, proxy, deviceParams);
        if (statusNeedsReauth(status))
            (0, liveClient_1.markSessionExpired)(account.id);
        saveTgMeta(account.id, status.firstName, status.lastName, status.username);
        res.json(status);
    }
    catch (err) {
        if ((0, liveClient_1.isAuthError)(err?.message ?? ""))
            (0, liveClient_1.markSessionExpired)(account.id);
        internalError(res, err, 'check-status');
    }
});
// POST /:id/refresh-tg-meta -- fetch TG display name and persist it; returns { tgDisplayName, tgUsername }
router.post("/:id/refresh-tg-meta", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!account) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    if (!account.session_string) {
        res.status(400).json({ error: "Account not authenticated" });
        return;
    }
    try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxyUrl = resolveProxyUrl(account.proxy_id);
        const proxy = (0, runner_1.parseTgProxy)(proxyUrl);
        const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
        const status = await (0, tgAuth_1.checkAccountStatus)(apiId, apiHash, account.session_string, proxy, deviceParams);
        if (statusNeedsReauth(status))
            (0, liveClient_1.markSessionExpired)(account.id);
        saveTgMeta(account.id, status.firstName, status.lastName, status.username);
        const displayName = [status.firstName, status.lastName]
            .filter(Boolean)
            .join(" ");
        res.json({
            tgDisplayName: displayName || null,
            tgUsername: status.username ?? null,
        });
    }
    catch (err) {
        if ((0, liveClient_1.isAuthError)(err?.message ?? ""))
            (0, liveClient_1.markSessionExpired)(account.id);
        internalError(res, err, 'refresh-tg-meta');
    }
});
// POST /check-enabled-sessions -- check all enabled+authenticated accounts and mark expired ones
router.post("/check-enabled-sessions", async (req, res) => {
    const rows = database_1.db
        .prepare("SELECT * FROM tg_accounts WHERE disabled = 0 AND auth_status = 'authenticated'")
        .all();
    rows.forEach(secretColumns_1.decryptAccountRow);
    const results = await Promise.allSettled(rows.map(async (account) => {
        if (!account.session_string)
            return { id: account.id, expired: true };
        try {
            const { apiId, apiHash } = resolveApiCredentials(account);
            const proxyUrl = resolveProxyUrl(account.proxy_id);
            const proxy = (0, runner_1.parseTgProxy)(proxyUrl);
            const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
            const status = await (0, tgAuth_1.checkAccountStatus)(apiId, apiHash, account.session_string, proxy, deviceParams);
            if (statusNeedsReauth(status)) {
                (0, liveClient_1.markSessionExpired)(account.id);
                return { id: account.id, expired: true };
            }
            return { id: account.id, expired: false };
        }
        catch (err) {
            if ((0, liveClient_1.isAuthError)(err?.message ?? "")) {
                (0, liveClient_1.markSessionExpired)(account.id);
                return { id: account.id, expired: true };
            }
            return { id: account.id, expired: false };
        }
    }));
    const expired = results
        .filter((r) => r.status === "fulfilled" &&
        r.value.expired)
        .map((r) => r.value.id);
    res.json({ checked: rows.length, expired });
});
// POST /:id/check-spam -- send /start to @SpamBot and return the parsed spam status
router.post("/:id/check-spam", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!account) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    if (!account.session_string) {
        res.status(400).json({ error: "Account not authenticated" });
        return;
    }
    try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxyUrl = resolveProxyUrl(account.proxy_id);
        const proxy = (0, runner_1.parseTgProxy)(proxyUrl);
        const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
        const result = await (0, checkin_1.checkSpamStatus)(apiId, apiHash, account.session_string, proxy, deviceParams);
        // Persist the restriction for the account-list badge: store the status when the
        // account is restricted, clear it when confirmed free, leave it on an unknown result.
        if (result.spamStatus === "free") {
            (0, accountAttributes_1.patchAttributes)(account.id, { restriction: undefined });
        }
        else if (result.spamStatus !== "unknown") {
            (0, accountAttributes_1.patchAttributes)(account.id, { restriction: result.spamStatus });
        }
        res.json(result);
    }
    catch (err) {
        if ((0, liveClient_1.isAuthError)(err?.message ?? ""))
            (0, liveClient_1.markSessionExpired)(account.id);
        internalError(res, err, 'check-spam');
    }
});
// POST /:id/fetch-attributes -- refresh all TG meta and extra attributes for one
// account (display name/username, hasEmail, hasPasskey). Deliberately excludes the
// spam check. Each step runs independently so one failure does not block the rest;
// per-step failures are returned as warnings.
router.post("/:id/fetch-attributes", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!requireAuth(account, res))
        return;
    let apiId;
    let apiHash;
    let proxy;
    let deviceParams;
    try {
        ({ apiId, apiHash } = resolveApiCredentials(account));
        proxy = (0, runner_1.parseTgProxy)(resolveProxyUrl(account.proxy_id));
        deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
    }
    catch (err) {
        internalError(res, err, "fetch-attributes");
        return;
    }
    const warnings = [];
    let authExpired = false;
    // Skip remaining steps once the session is known dead; they would only fail too.
    const runStep = async (label, fn) => {
        if (authExpired)
            return;
        try {
            await fn();
        }
        catch (err) {
            if ((0, liveClient_1.isAuthError)(err?.message ?? "")) {
                (0, liveClient_1.markSessionExpired)(account.id);
                authExpired = true;
            }
            warnings.push(`${label}: ${err?.errorMessage ?? err?.message ?? "failed"}`);
        }
    };
    await runStep("status", async () => {
        const status = await (0, tgAuth_1.checkAccountStatus)(apiId, apiHash, account.session_string, proxy, deviceParams);
        if (statusNeedsReauth(status)) {
            (0, liveClient_1.markSessionExpired)(account.id);
            authExpired = true;
        }
        saveTgMeta(account.id, status.firstName, status.lastName, status.username);
    });
    await runStep("password-info", async () => {
        const info = await (0, tgAuth_1.getPasswordInfo)(apiId, apiHash, account.session_string, proxy, deviceParams);
        (0, accountAttributes_1.patchAttributes)(account.id, {
            hasEmail: info.loginEmailPattern ? true : undefined,
        });
    });
    await runStep("passkeys", async () => {
        const passkeys = await (0, tgAuth_1.getPasskeys)(apiId, apiHash, account.session_string, proxy, deviceParams);
        (0, passkeyStore_1.pruneAccountPasskeySecrets)(account.id, passkeys.map((p) => p.id));
        (0, accountAttributes_1.patchAttributes)(account.id, { hasPasskey: passkeys.length > 0 });
    });
    const row = loadAccount(account.id);
    res.json({ account: toJson(row), warnings, authExpired });
});
// POST /:id/update-2fa -- set, change, or remove the account's 2FA password
router.post("/:id/update-2fa", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!account) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    if (!account.session_string) {
        res.status(400).json({ error: "Account not authenticated" });
        return;
    }
    const { currentPassword, newPassword, hint } = req.body;
    try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxyUrl = resolveProxyUrl(account.proxy_id);
        const proxy = (0, runner_1.parseTgProxy)(proxyUrl);
        const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
        await (0, tgAuth_1.updateTwoFa)(apiId, apiHash, account.session_string, { currentPassword, newPassword, hint }, proxy, deviceParams);
        res.json({ success: true });
    }
    catch (err) {
        if ((0, liveClient_1.isAuthError)(err?.message ?? ""))
            (0, liveClient_1.markSessionExpired)(account.id);
        internalError(res, err, 'update-2fa');
    }
});
// GET /:id/profile -- fetch the account's own Telegram profile (first/last name + bio)
router.get("/:id/profile", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!account) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    if (!account.session_string) {
        res.status(400).json({ error: "Account not authenticated" });
        return;
    }
    try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxyUrl = resolveProxyUrl(account.proxy_id);
        const proxy = (0, runner_1.parseTgProxy)(proxyUrl);
        const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
        const profile = await (0, tgAuth_1.getProfile)(apiId, apiHash, account.session_string, proxy, deviceParams);
        res.json(profile);
    }
    catch (err) {
        if ((0, liveClient_1.isAuthError)(err?.message ?? ""))
            (0, liveClient_1.markSessionExpired)(account.id);
        internalError(res, err, "profile");
    }
});
// POST /:id/update-profile -- update the account's own Telegram profile
router.post("/:id/update-profile", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!account) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    if (!account.session_string) {
        res.status(400).json({ error: "Account not authenticated" });
        return;
    }
    const { firstName, lastName, about } = req.body;
    if (!firstName || !firstName.trim()) {
        res.status(400).json({ error: "firstName is required" });
        return;
    }
    try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxyUrl = resolveProxyUrl(account.proxy_id);
        const proxy = (0, runner_1.parseTgProxy)(proxyUrl);
        const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
        const profile = await (0, tgAuth_1.updateProfile)(apiId, apiHash, account.session_string, { firstName, lastName, about }, proxy, deviceParams);
        // Keep the cached display name in sync with the new profile
        saveTgMeta(account.id, profile.firstName, profile.lastName, account.tg_username ?? undefined);
        const tgDisplayName = [profile.firstName, profile.lastName].filter(Boolean).join(" ") || null;
        res.json({ ...profile, tgDisplayName });
    }
    catch (err) {
        if ((0, liveClient_1.isAuthError)(err?.message ?? ""))
            (0, liveClient_1.markSessionExpired)(account.id);
        internalError(res, err, "update-profile");
    }
});
// GET /:id/sessions -- list all active Telegram sessions for this account
router.get("/:id/sessions", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!account) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    if (!account.session_string) {
        res.status(400).json({ error: "Account not authenticated" });
        return;
    }
    try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxyUrl = resolveProxyUrl(account.proxy_id);
        const proxy = (0, runner_1.parseTgProxy)(proxyUrl);
        const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
        const sessions = await (0, tgAuth_1.getSessions)(apiId, apiHash, account.session_string, proxy, deviceParams);
        res.json(sessions);
    }
    catch (err) {
        if ((0, liveClient_1.isAuthError)(err?.message ?? ""))
            (0, liveClient_1.markSessionExpired)(account.id);
        internalError(res, err, 'sessions');
    }
});
// POST /:id/terminate-session -- revoke a specific session by hash
router.post("/:id/terminate-session", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!account) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    if (!account.session_string) {
        res.status(400).json({ error: "Account not authenticated" });
        return;
    }
    const { hash } = req.body;
    if (!hash) {
        res.status(400).json({ error: "hash required" });
        return;
    }
    try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxyUrl = resolveProxyUrl(account.proxy_id);
        const proxy = (0, runner_1.parseTgProxy)(proxyUrl);
        const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
        await (0, tgAuth_1.terminateSession)(apiId, apiHash, account.session_string, hash, proxy, deviceParams);
        res.json({ success: true });
    }
    catch (err) {
        if ((0, liveClient_1.isAuthError)(err?.message ?? ""))
            (0, liveClient_1.markSessionExpired)(account.id);
        internalError(res, err, 'terminate-session');
    }
});
// POST /:id/terminate-other-sessions -- revoke all sessions except the current one
router.post("/:id/terminate-other-sessions", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!account) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    if (!account.session_string) {
        res.status(400).json({ error: "Account not authenticated" });
        return;
    }
    try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxyUrl = resolveProxyUrl(account.proxy_id);
        const proxy = (0, runner_1.parseTgProxy)(proxyUrl);
        const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
        await (0, tgAuth_1.terminateOtherSessions)(apiId, apiHash, account.session_string, proxy, deviceParams);
        res.json({ success: true });
    }
    catch (err) {
        if ((0, liveClient_1.isAuthError)(err?.message ?? ""))
            (0, liveClient_1.markSessionExpired)(account.id);
        internalError(res, err, 'terminate-other-sessions');
    }
});
// POST /:id/force-reauth -- clear session and reset auth status so the account can be re-authenticated
router.post("/:id/force-reauth", (req, res) => {
    const account = loadAccount(req.params.id);
    if (!account) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    // Capture the account's DC onto its stored passkeys before we drop the session,
    // so a later passkey login can still reach the right data centre.
    if (account.session_string) {
        const dc = (0, tgAuth_1.getSessionDc)(account.session_string);
        if (dc)
            (0, passkeyStore_1.setAccountPasskeyDc)(account.id, dc);
    }
    database_1.db.prepare("UPDATE tg_accounts SET session_string = NULL, auth_status = 'unauthenticated' WHERE id = ?").run(account.id);
    (0, liveClient_1.markSessionExpired)(account.id);
    const row = loadAccount(account.id);
    res.json(toJson(row));
});
// ── Login email management ────────────────────────────────────────────────────
function requireAuth(account, res) {
    if (!account) {
        res.status(404).json({ error: "Not found" });
        return false;
    }
    if (!account.session_string) {
        res.status(400).json({ error: "Account not authenticated" });
        return false;
    }
    return true;
}
// GET /:id/password-info -- returns 2FA status and masked login email pattern (no password needed)
router.get("/:id/password-info", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!requireAuth(account, res))
        return;
    try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxyUrl = resolveProxyUrl(account.proxy_id);
        const proxy = (0, runner_1.parseTgProxy)(proxyUrl);
        const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
        const info = await (0, tgAuth_1.getPasswordInfo)(apiId, apiHash, account.session_string, proxy, deviceParams);
        // Store hasEmail only when a login email is found; drop the flag otherwise.
        (0, accountAttributes_1.patchAttributes)(account.id, { hasEmail: info.loginEmailPattern ? true : undefined });
        res.json(info);
    }
    catch (err) {
        if ((0, liveClient_1.isAuthError)(err?.message ?? ""))
            (0, liveClient_1.markSessionExpired)(account.id);
        internalError(res, err, "password-info");
    }
});
// POST /:id/login-email/send-code -- send a verification code to a new login email
// Telegram has no API to remove the login email from an authorised session; it can only be replaced.
router.post("/:id/login-email/send-code", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!requireAuth(account, res))
        return;
    const { email } = req.body;
    if (!email) {
        res.status(400).json({ error: "email required" });
        return;
    }
    try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxyUrl = resolveProxyUrl(account.proxy_id);
        const proxy = (0, runner_1.parseTgProxy)(proxyUrl);
        const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
        const result = await (0, tgAuth_1.sendLoginEmailCode)(apiId, apiHash, account.session_string, email, proxy, deviceParams);
        res.json(result);
    }
    catch (err) {
        if ((0, liveClient_1.isAuthError)(err?.message ?? ""))
            (0, liveClient_1.markSessionExpired)(account.id);
        if (rpcBadRequest(res, err, "login-email/send-code"))
            return;
        internalError(res, err, "login-email/send-code");
    }
});
// POST /:id/login-email/auto -- set a Gmail plus-address login email and read
// the confirmation code back over IMAP. Gated by BULK_ACCOUNT_MANAGEMENT.
router.post("/:id/login-email/auto", bulkMgmtGuard, async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!requireAuth(account, res))
        return;
    const { gmail, appPassword, tag } = req.body;
    if (!gmail || !gmail.includes("@") || !appPassword) {
        res.status(400).json({ error: "gmail and appPassword are required" });
        return;
    }
    try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxy = (0, runner_1.parseTgProxy)(resolveProxyUrl(account.proxy_id));
        const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
        const result = await (0, bulkLoginEmail_1.changeLoginEmailViaGmail)({
            apiId,
            apiHash,
            sessionString: account.session_string,
            phoneNumber: account.phone_number,
            accountId: account.id,
            proxy,
            deviceParams,
            gmail: gmail.trim(),
            appPassword,
            tag: (tag ?? "").trim(),
        });
        res.json(result);
    }
    catch (err) {
        if ((0, liveClient_1.isAuthError)(err?.message ?? ""))
            (0, liveClient_1.markSessionExpired)(account.id);
        if (rpcBadRequest(res, err, "login-email/auto"))
            return;
        internalError(res, err, "login-email/auto");
    }
});
// POST /:id/login-email/verify -- confirm the new login email with the emailed code
router.post("/:id/login-email/verify", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!requireAuth(account, res))
        return;
    const { code } = req.body;
    if (!code) {
        res.status(400).json({ error: "code required" });
        return;
    }
    try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxyUrl = resolveProxyUrl(account.proxy_id);
        const proxy = (0, runner_1.parseTgProxy)(proxyUrl);
        const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
        const result = await (0, tgAuth_1.verifyLoginEmail)(apiId, apiHash, account.session_string, code, proxy, deviceParams);
        res.json(result);
    }
    catch (err) {
        if ((0, liveClient_1.isAuthError)(err?.message ?? ""))
            (0, liveClient_1.markSessionExpired)(account.id);
        if (rpcBadRequest(res, err, "login-email/verify"))
            return;
        internalError(res, err, "login-email/verify");
    }
});
// ── Passkeys ──────────────────────────────────────────────────────────────────
// GET /:id/passkeys -- list the account's passkeys
router.get("/:id/passkeys", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!requireAuth(account, res))
        return;
    try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxy = (0, runner_1.parseTgProxy)(resolveProxyUrl(account.proxy_id));
        const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
        const passkeys = await (0, tgAuth_1.getPasskeys)(apiId, apiHash, account.session_string, proxy, deviceParams);
        // Telegram is authoritative: drop stored keys for passkeys that no longer
        // exist there (e.g. removed when the 2FA password was changed), so storedIds
        // stay accurate.
        (0, passkeyStore_1.pruneAccountPasskeySecrets)(account.id, passkeys.map((p) => p.id));
        // Record whether the account has ANY passkey (any device/origin) for the list flag.
        (0, accountAttributes_1.patchAttributes)(account.id, { hasPasskey: passkeys.length > 0 });
        res.json({ passkeys, storedIds: (0, passkeyStore_1.storedPasskeyIdsForAccount)(account.id) });
    }
    catch (err) {
        if ((0, liveClient_1.isAuthError)(err?.message ?? ""))
            (0, liveClient_1.markSessionExpired)(account.id);
        if (rpcBadRequest(res, err, "passkeys/list"))
            return;
        internalError(res, err, "passkeys/list");
    }
});
// POST /:id/passkeys -- register a new passkey (experimental; WebAuthn ceremony run server-side)
router.post("/:id/passkeys", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!requireAuth(account, res))
        return;
    try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxy = (0, runner_1.parseTgProxy)(resolveProxyUrl(account.proxy_id));
        const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
        const origin = typeof req.body?.origin === "string" ? req.body.origin : undefined;
        const result = await (0, tgAuth_1.registerPasskey)(apiId, apiHash, account.session_string, origin, proxy, deviceParams);
        // Persist the private key so the passkey can later be used/verified for login.
        const dc = (0, tgAuth_1.getSessionDc)(account.session_string) ?? {};
        (0, passkeyStore_1.savePasskeySecret)({
            accountId: account.id,
            telegramPasskeyId: result.passkey.id,
            credentialId: result.credentialId,
            privateKeyPem: result.privateKeyPem,
            rpId: result.rpId,
            userHandle: result.userHandle,
            createdDate: result.passkey.date,
            ...dc,
        });
        // The account now has a passkey (this one, created by Bemby).
        (0, accountAttributes_1.patchAttributes)(account.id, { hasPasskey: true });
        res.json({ passkey: result.passkey });
    }
    catch (err) {
        if ((0, liveClient_1.isAuthError)(err?.message ?? ""))
            (0, liveClient_1.markSessionExpired)(account.id);
        if (rpcBadRequest(res, err, "passkeys/register"))
            return;
        internalError(res, err, "passkeys/register");
    }
});
// POST /:id/passkeys/:passkeyId/verify -- prove the passkey works via a real login
router.post("/:id/passkeys/:passkeyId/verify", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!requireAuth(account, res))
        return;
    const secret = (0, passkeyStore_1.getPasskeySecret)(req.params.passkeyId);
    if (!secret || secret.accountId !== account.id) {
        res.status(404).json({ error: "no stored key for this passkey" });
        return;
    }
    try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxy = (0, runner_1.parseTgProxy)(resolveProxyUrl(account.proxy_id));
        const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
        const origin = typeof req.body?.origin === "string" ? req.body.origin : undefined;
        const result = await (0, tgAuth_1.verifyPasskeyLogin)(apiId, apiHash, account.session_string, secret, origin, proxy, deviceParams);
        res.json(result);
    }
    catch (err) {
        if (rpcBadRequest(res, err, "passkeys/verify"))
            return;
        internalError(res, err, "passkeys/verify");
    }
});
// DELETE /:id/passkeys/:passkeyId -- revoke a passkey
router.delete("/:id/passkeys/:passkeyId", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!requireAuth(account, res))
        return;
    try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxy = (0, runner_1.parseTgProxy)(resolveProxyUrl(account.proxy_id));
        const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
        const ok = await (0, tgAuth_1.deletePasskey)(apiId, apiHash, account.session_string, req.params.passkeyId, proxy, deviceParams);
        if (ok)
            (0, passkeyStore_1.deletePasskeySecret)(req.params.passkeyId);
        res.json({ ok });
    }
    catch (err) {
        if ((0, liveClient_1.isAuthError)(err?.message ?? ""))
            (0, liveClient_1.markSessionExpired)(account.id);
        if (rpcBadRequest(res, err, "passkeys/delete"))
            return;
        internalError(res, err, "passkeys/delete");
    }
});
// ── Telegram auth flow ──────────────────────────────────────────────────────
router.post("/:id/auth/request", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!account) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    try {
        const { apiId, apiHash } = resolveApiCredentials(account);
        const proxyUrl = resolveProxyUrl(account.proxy_id);
        const proxy = (0, runner_1.parseTgProxy)(proxyUrl);
        const deviceParams = (0, appClient_1.resolveAppClientParams)(account.id, account.app_client_id);
        // Prefer passkey login when we hold a usable (DC-known) stored passkey; fall
        // back to the code flow if none exist or the passkey is rejected.
        const secret = (0, passkeyStore_1.accountPasskeySecrets)(account.id).find((s) => s.dcId != null);
        if (secret) {
            try {
                const result = await (0, tgAuth_1.startPasskeyLogin)(account.id, apiId, apiHash, secret, undefined, proxy);
                if (result.needsPassword) {
                    database_1.db.prepare("UPDATE tg_accounts SET auth_status = 'pending_2fa' WHERE id = ?").run(account.id);
                    res.json({ method: "passkey", step: "2fa" });
                }
                else {
                    database_1.db.prepare("UPDATE tg_accounts SET auth_status = 'authenticated', session_string = ? WHERE id = ?").run((0, secretColumns_1.encryptSecret)(result.session), account.id);
                    res.json({ method: "passkey", step: "done" });
                }
                return;
            }
            catch (err) {
                // Passkey unusable -- fall through to the code flow below.
                console.warn(`[accounts] passkey login failed for ${account.id}, falling back to code:`, err?.errorMessage ?? err?.message ?? err);
            }
        }
        const { isCodeViaApp } = await (0, tgAuth_1.requestCode)(account.id, apiId, apiHash, account.phone_number, proxy, deviceParams);
        database_1.db.prepare("UPDATE tg_accounts SET auth_status = 'pending_code' WHERE id = ?").run(account.id);
        res.json({ method: "code", message: "Verification code sent", isCodeViaApp });
    }
    catch (err) {
        if (rpcBadRequest(res, err, 'auth/request'))
            return;
        internalError(res, err, 'auth/request');
    }
});
router.post("/:id/auth/resend", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!account) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    try {
        await (0, tgAuth_1.resendCodeAsSms)(account.id);
        res.json({ ok: true });
    }
    catch (err) {
        if (rpcBadRequest(res, err, 'auth/resend'))
            return;
        internalError(res, err, 'auth/resend');
    }
});
router.post("/:id/auth/verify", async (req, res) => {
    const account = loadAccount(req.params.id);
    if (!account) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    const { code, password } = req.body;
    try {
        if (account.auth_status === "pending_code" && code) {
            const result = await (0, tgAuth_1.submitCode)(account.id, code);
            if (result.needsPassword) {
                database_1.db.prepare("UPDATE tg_accounts SET auth_status = 'pending_2fa' WHERE id = ?").run(account.id);
                res.json({ step: "2fa" });
            }
            else {
                database_1.db.prepare("UPDATE tg_accounts SET auth_status = 'authenticated', session_string = ? WHERE id = ?").run((0, secretColumns_1.encryptSecret)(result.session), account.id);
                res.json({ step: "done" });
            }
        }
        else if (account.auth_status === "pending_2fa" && password) {
            const session = await (0, tgAuth_1.submitPassword)(account.id, password);
            database_1.db.prepare("UPDATE tg_accounts SET auth_status = 'authenticated', session_string = ? WHERE id = ?").run((0, secretColumns_1.encryptSecret)(session), account.id);
            res.json({ step: "done" });
        }
        else {
            res
                .status(400)
                .json({ error: "Invalid auth state or missing credentials" });
        }
    }
    catch (err) {
        if (rpcBadRequest(res, err, 'auth/verify'))
            return;
        internalError(res, err, 'auth/verify');
    }
});
exports.default = router;
