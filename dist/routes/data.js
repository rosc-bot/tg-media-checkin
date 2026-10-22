"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SENSITIVE_SETTING_KEYS = exports.EXPORT_EXCLUDED_SETTINGS = void 0;
exports.exportRequiresEncryption = exportRequiresEncryption;
exports.clearDanglingProxyRefs = clearDanglingProxyRefs;
const express_1 = require("express");
const database_1 = require("../db/database");
const exportCrypto_1 = require("../db/exportCrypto");
const secretColumns_1 = require("../db/secretColumns");
const scheduler_1 = require("../scheduler");
const credentials_1 = require("../auth/credentials");
const passkeyStore_1 = require("../tg/passkeyStore");
const accountAttributes_1 = require("../db/accountAttributes");
// Admin/JWT secrets are instance-local and must never travel in a backup.
exports.EXPORT_EXCLUDED_SETTINGS = new Set([
    'admin_password_hash',
    'admin_username',
    'jwt_secret',
    // References an instance-local ai_models row id; meaningless after import
    'ai_default_model_id',
]);
// Settings whose presence forces the export to be encrypted. Proxy entries carry their
// credentials in the URL, and a provider entry carries the seller's API token.
exports.SENSITIVE_SETTING_KEYS = [
    'default_tg_api_hash',
    'proxies',
    'proxy_providers',
    'webshare_api_key',
    // Whoever holds the notification bot's token can act as that bot
    'notify_bot_token',
];
// Config keys that carry a credential (e.g. Emby login) inside a job/template config blob.
const SENSITIVE_CONFIG_KEYS = ['password', 'username'];
/** True if a job/template config JSON string carries a credential field. */
function configHasSecret(config) {
    if (!config)
        return false;
    try {
        const parsed = JSON.parse(config);
        return SENSITIVE_CONFIG_KEYS.some((k) => Boolean(parsed?.[k]));
    }
    catch {
        return false;
    }
}
// Encryption is mandatory when the payload carries any credential-bearing field:
// session strings, API keys, per-account API hashes, sensitive settings, or an
// Emby username/password embedded in a job/template config.
function exportRequiresEncryption(payload) {
    return (payload.accounts.some((a) => a.sessionString || a.apiHash || a.passkey?.privateKeyPem) ||
        (payload.aiSuppliers ?? []).some((s) => s.apiKey) ||
        exports.SENSITIVE_SETTING_KEYS.some((k) => Boolean(payload.settings?.[k])) ||
        (payload.jobs ?? []).some((j) => configHasSecret(j.config)) ||
        (payload.templates ?? []).some((t) => configHasSecret(t.config)));
}
const router = (0, express_1.Router)();
/** Ids of the proxies currently configured, for validating references against. */
function configuredProxyIds() {
    const row = database_1.db.prepare("SELECT value FROM settings WHERE key = 'proxies'").get();
    try {
        const list = JSON.parse(row?.value ?? '[]');
        return new Set(list.map((p) => p.id).filter((id) => !!id));
    }
    catch {
        return new Set();
    }
}
/**
 * Drops proxy references that point at proxies this instance does not have: the account
 * column, and the `proxyId` inside job and template configs. Returns how many were
 * cleared. A dangling reference is worse than none, because it silently resolves to no
 * proxy at all instead of the one the job was set up with.
 */
function clearDanglingProxyRefs() {
    const known = configuredProxyIds();
    let cleared = 0;
    const accounts = database_1.db
        .prepare("SELECT id, proxy_id FROM tg_accounts WHERE proxy_id IS NOT NULL AND proxy_id != ''")
        .all();
    for (const a of accounts) {
        if (known.has(a.proxy_id))
            continue;
        database_1.db.prepare('UPDATE tg_accounts SET proxy_id = NULL WHERE id = ?').run(a.id);
        cleared++;
    }
    for (const table of ['jobs', 'job_templates']) {
        const rows = database_1.db
            .prepare(`SELECT id, config FROM ${table} WHERE config IS NOT NULL AND config LIKE '%proxyId%'`)
            .all();
        for (const row of rows) {
            let cfg;
            try {
                const parsed = JSON.parse(row.config);
                cfg = typeof parsed === 'string' ? JSON.parse(parsed) : parsed;
            }
            catch {
                continue;
            }
            const proxyId = cfg?.proxyId;
            if (typeof proxyId !== 'string' || !proxyId || known.has(proxyId))
                continue;
            delete cfg.proxyId;
            database_1.db.prepare(`UPDATE ${table} SET config = ? WHERE id = ?`).run(JSON.stringify(cfg), row.id);
            cleared++;
        }
    }
    return cleared;
}
router.post('/export', (req, res) => {
    const { secret } = req.body;
    const accounts = database_1.db.prepare('SELECT * FROM tg_accounts ORDER BY id').all()
        // The backup has its own encryption; the at-rest key must not be needed to restore it
        .map(secretColumns_1.decryptAccountRow);
    const templates = database_1.db.prepare('SELECT * FROM job_templates ORDER BY id').all();
    const jobs = database_1.db.prepare('SELECT * FROM jobs ORDER BY id').all();
    const aiSuppliers = database_1.db.prepare('SELECT * FROM ai_suppliers ORDER BY id').all();
    const aiModels = database_1.db.prepare('SELECT * FROM ai_models ORDER BY id').all();
    const settings = database_1.db.prepare('SELECT key, value FROM settings').all();
    const accountIdToIndex = new Map(accounts.map((a, i) => [a.id, i]));
    const templateIdToIndex = new Map(templates.map((t, i) => [t.id, i]));
    const supplierIdToIndex = new Map(aiSuppliers.map((s, i) => [s.id, i]));
    const payload = {
        version: '1',
        exportedAt: new Date().toISOString(),
        accounts: accounts.map(a => ({
            name: a.name,
            phoneNumber: a.phone_number,
            apiId: a.api_id,
            apiHash: a.api_hash,
            sessionString: a.session_string,
            authStatus: a.auth_status,
            proxyId: a.proxy_id ?? null,
            passkey: (0, passkeyStore_1.parseStoredPasskey)(a.passkey),
            additionalAttributes: (0, accountAttributes_1.parseAttributes)(a.additional_attributes),
        })),
        templates: templates.map(t => ({
            name: t.name,
            jobType: t.job_type,
            botUsername: t.bot_username,
            timezone: t.timezone,
            replyTimeoutMs: t.reply_timeout_ms,
            retryMax: t.retry_max,
            config: t.config,
            startCommand: t.start_command,
            checkinButton: t.checkin_button,
        })),
        jobs: jobs.map(j => ({
            accountIndex: j.account_id != null ? (accountIdToIndex.get(j.account_id) ?? null) : null,
            templateIndex: j.template_id != null ? (templateIdToIndex.get(j.template_id) ?? null) : null,
            name: j.name,
            jobType: j.job_type,
            botUsername: j.bot_username,
            scheduleWindowStart: j.schedule_window_start,
            scheduleWindowEnd: j.schedule_window_end,
            timezone: j.timezone,
            replyTimeoutMs: j.reply_timeout_ms,
            retryMax: j.retry_max,
            enabled: j.enabled === 1,
            config: j.config,
            startCommand: j.start_command,
            checkinButton: j.checkin_button,
        })),
        aiSuppliers: aiSuppliers.map(s => ({
            name: s.name,
            baseUrl: s.base_url,
            apiKey: s.api_key,
            timeoutMs: s.timeout_ms,
        })),
        aiModels: aiModels
            .filter(m => supplierIdToIndex.has(m.supplier_id))
            .map(m => ({
            supplierIndex: supplierIdToIndex.get(m.supplier_id),
            modelId: m.model_id,
            label: m.label,
        })),
        settings: Object.fromEntries(settings
            // Passkeys now live on the account row (exported per-account above), never as a
            // setting. Exclude the legacy blob in case an un-migrated DB still holds it.
            .filter(s => !exports.EXPORT_EXCLUDED_SETTINGS.has(s.key) && s.key !== accountAttributes_1.LEGACY_PASSKEY_STORE_KEY)
            .map(s => [s.key, s.value])),
    };
    const hasSecrets = exportRequiresEncryption(payload);
    if (hasSecrets && !secret) {
        res.status(400).json({
            error: 'This export contains sensitive credentials (session strings or API keys). Provide an encryption secret.',
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
router.post('/import', async (req, res) => {
    let { data, mode, secret, forceReauth = true, confirmPassword } = req.body;
    if (data && data.encrypted === true) {
        if (!secret) {
            res.status(400).json({ error: 'This backup is encrypted. Please provide the secret to decrypt it.' });
            return;
        }
        try {
            data = JSON.parse((0, exportCrypto_1.decryptPayload)(data, secret));
        }
        catch {
            res.status(400).json({ error: 'Incorrect secret or corrupted backup file', code: 'WRONG_SECRET' });
            return;
        }
    }
    const payload = data;
    if (!payload || payload.version !== '1') {
        res.status(400).json({ error: 'Invalid or unsupported export file' });
        return;
    }
    if (!Array.isArray(payload.accounts) || !Array.isArray(payload.jobs)) {
        res.status(400).json({ error: 'Malformed export file: missing accounts or jobs' });
        return;
    }
    if (mode === 'replace') {
        if (!confirmPassword) {
            res.status(400).json({ error: 'Current password confirmation is required for replace-mode import.', code: 'CONFIRM_REQUIRED' });
            return;
        }
        const stored = (0, credentials_1.getStoredCredentials)();
        // With no stored hash and no ADMIN_PASSWORD, the old fallback compared the input against
        // the hash of the empty string, so an empty confirmPassword passed. Refuse outright
        // instead: there is nothing to check against, and a wipe is not the place to fail open.
        const envPassword = process.env.ADMIN_PASSWORD;
        const valid = stored.passwordHash
            ? await (0, credentials_1.verifyPassword)(confirmPassword, stored.passwordHash)
            : envPassword
                ? (0, credentials_1.timingSafeCompare)((0, credentials_1.legacyHashPassword)(confirmPassword), (0, credentials_1.legacyHashPassword)(envPassword))
                : false;
        if (!valid) {
            res.status(401).json({ error: 'Incorrect password', code: 'WRONG_PASSWORD' });
            return;
        }
    }
    const results = { accountsImported: 0, accountsSkipped: 0, templatesImported: 0, jobsImported: 0, aiSuppliersImported: 0, aiModelsImported: 0, settingsUpdated: 0, proxyRefsCleared: 0 };
    try {
        database_1.db.transaction(() => {
            if (mode === 'replace') {
                // FK order: models -> suppliers, jobs -> templates/accounts
                database_1.db.prepare('DELETE FROM ai_models').run();
                database_1.db.prepare('DELETE FROM ai_suppliers').run();
                database_1.db.prepare('DELETE FROM jobs').run();
                database_1.db.prepare('DELETE FROM job_templates').run();
                database_1.db.prepare('DELETE FROM tg_accounts').run();
                // The pinned default references a wiped ai_models row id
                database_1.db.prepare("DELETE FROM settings WHERE key = 'ai_default_model_id'").run();
            }
            // Import accounts and build accountIndex -> new db id mapping
            const accountIndexToId = new Map();
            for (let i = 0; i < payload.accounts.length; i++) {
                const a = payload.accounts[i];
                if (mode === 'merge') {
                    const existing = database_1.db.prepare('SELECT id FROM tg_accounts WHERE phone_number = ?').get(a.phoneNumber);
                    if (existing) {
                        accountIndexToId.set(i, existing.id);
                        results.accountsSkipped++;
                        continue;
                    }
                }
                const result = database_1.db.prepare(`INSERT INTO tg_accounts (name, phone_number, api_id, api_hash, session_string, auth_status, proxy_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`).run(a.name, a.phoneNumber, a.apiId, (0, secretColumns_1.encryptSecret)(a.apiHash), (0, secretColumns_1.encryptSecret)(forceReauth ? null : (a.sessionString ?? null)), forceReauth ? 'unauthenticated' : (a.authStatus ?? 'unauthenticated'), a.proxyId ?? null);
                const newAccountId = result.lastInsertRowid;
                accountIndexToId.set(i, newAccountId);
                // Restore the passkey secret under the new account id so passkey login still works
                // after import (even when force-reauth clears the session string).
                const pk = (0, passkeyStore_1.importedPasskeyFor)(a);
                if (pk)
                    (0, passkeyStore_1.savePasskeySecret)({ ...pk, accountId: newAccountId });
                // Restore the generic attributes bag.
                const attrs = (0, accountAttributes_1.foldImportedAttributes)(a);
                if (attrs)
                    (0, accountAttributes_1.writeAttributes)(newAccountId, attrs);
                results.accountsImported++;
            }
            // Import templates and build templateIndex -> new db id mapping
            const templateIndexToId = new Map();
            if (Array.isArray(payload.templates)) {
                for (let i = 0; i < payload.templates.length; i++) {
                    const t = payload.templates[i];
                    if (mode === 'merge') {
                        const existing = database_1.db.prepare('SELECT id FROM job_templates WHERE name = ?').get(t.name);
                        if (existing) {
                            templateIndexToId.set(i, existing.id);
                            continue;
                        }
                    }
                    const result = database_1.db.prepare(`INSERT INTO job_templates
             (name, job_type, bot_username, timezone, reply_timeout_ms, retry_max, config, start_command, checkin_button)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(t.name, t.jobType ?? 'checkin', t.botUsername ?? '', t.timezone ?? '', t.replyTimeoutMs ?? 40000, t.retryMax ?? 5, t.config ?? null, t.startCommand ?? '/start', t.checkinButton ?? '签到');
                    templateIndexToId.set(i, result.lastInsertRowid);
                    results.templatesImported++;
                }
            }
            // Import jobs
            for (const j of payload.jobs) {
                const resolvedAccountId = j.accountIndex != null ? (accountIndexToId.get(j.accountIndex) ?? null) : null;
                const resolvedTemplateId = j.templateIndex != null ? (templateIndexToId.get(j.templateIndex) ?? null) : null;
                database_1.db.prepare(`INSERT INTO jobs
           (account_id, template_id, name, job_type, bot_username, schedule_window_start, schedule_window_end,
            timezone, reply_timeout_ms, retry_max, enabled, config, start_command, checkin_button)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(resolvedAccountId, resolvedTemplateId, j.name, j.jobType ?? 'checkin', j.botUsername, j.scheduleWindowStart ?? 1400, j.scheduleWindowEnd ?? 1600, j.timezone ?? '', j.replyTimeoutMs ?? 40000, j.retryMax ?? 5, j.enabled ? 1 : 0, j.config ?? null, j.startCommand ?? '/start', j.checkinButton ?? '签到');
                results.jobsImported++;
            }
            // Import AI suppliers and build supplierIndex -> new db id mapping
            const supplierIndexToId = new Map();
            if (Array.isArray(payload.aiSuppliers)) {
                for (let i = 0; i < payload.aiSuppliers.length; i++) {
                    const s = payload.aiSuppliers[i];
                    if (mode === 'merge') {
                        const existing = database_1.db.prepare('SELECT id FROM ai_suppliers WHERE name = ?').get(s.name);
                        if (existing) {
                            supplierIndexToId.set(i, existing.id);
                            continue;
                        }
                    }
                    const result = database_1.db.prepare('INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)').run(s.name, s.baseUrl, s.apiKey, s.timeoutMs ?? 25000);
                    supplierIndexToId.set(i, result.lastInsertRowid);
                    results.aiSuppliersImported++;
                }
            }
            // Import AI models
            if (Array.isArray(payload.aiModels)) {
                for (const m of payload.aiModels) {
                    const resolvedSupplierId = supplierIndexToId.get(m.supplierIndex);
                    if (resolvedSupplierId == null)
                        continue;
                    database_1.db.prepare('INSERT INTO ai_models (supplier_id, model_id, label) VALUES (?, ?, ?)').run(resolvedSupplierId, m.modelId, m.label ?? null);
                    results.aiModelsImported++;
                }
            }
            // Merge settings -- never let a backup overwrite instance-local admin/JWT secrets
            if (payload.settings && typeof payload.settings === 'object') {
                const stmt = database_1.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
                for (const [key, value] of Object.entries(payload.settings)) {
                    if (exports.EXPORT_EXCLUDED_SETTINGS.has(key))
                        continue;
                    // Never merge a legacy raw passkey blob: passkeys live on the account row now,
                    // and an older backup's blob carries stale account ids.
                    if (key === accountAttributes_1.LEGACY_PASSKEY_STORE_KEY)
                        continue;
                    if (typeof value === 'string') {
                        stmt.run(key, value);
                        results.settingsUpdated++;
                    }
                }
            }
            // A proxy reference is an id that only means something next to the proxy list it came
            // from: a backup taken without proxies, or one imported into an instance with its own,
            // leaves accounts and jobs pointing at nothing. That reads as "no proxy" at run time
            // rather than as an error, so the dangling references are cleared here and counted.
            results.proxyRefsCleared = clearDanglingProxyRefs();
        })();
    }
    catch (err) {
        // A malformed backup can throw inside the transaction (bad bind value,
        // constraint violation). Roll back and respond, rather than letting the
        // rejection escape the async handler and hang the request.
        res.status(400).json({
            error: `Import failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
    }
    (0, scheduler_1.refreshScheduler)();
    res.json({ message: 'Import complete', ...results });
});
exports.default = router;
