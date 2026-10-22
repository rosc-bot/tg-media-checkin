"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseStoredPasskey = parseStoredPasskey;
exports.getAccountPasskey = getAccountPasskey;
exports.savePasskeySecret = savePasskeySecret;
exports.getPasskeySecret = getPasskeySecret;
exports.deletePasskeySecret = deletePasskeySecret;
exports.pruneAccountPasskeySecrets = pruneAccountPasskeySecrets;
exports.storedPasskeyIdsForAccount = storedPasskeyIdsForAccount;
exports.accountPasskeySecrets = accountPasskeySecrets;
exports.setAccountPasskeyDc = setAccountPasskeyDc;
exports.importedPasskeyFor = importedPasskeyFor;
const database_1 = require("../db/database");
const secretColumns_1 = require("../db/secretColumns");
/**
 * Reads the stored passkey. The column is encrypted at rest when a data key is configured
 * (see db/secretColumns), so decryption happens here, at the one place the raw column value
 * is turned into an object, rather than at every caller.
 */
function parseStoredPasskey(raw) {
    const plain = (0, secretColumns_1.decryptSecret)(raw ?? null);
    if (!plain)
        return null;
    try {
        const value = JSON.parse(plain);
        return value && typeof value === "object" ? value : null;
    }
    catch {
        return null;
    }
}
function getAccountPasskey(accountId) {
    const row = database_1.db
        .prepare("SELECT passkey FROM tg_accounts WHERE id = ?")
        .get(accountId);
    const stored = parseStoredPasskey(row?.passkey);
    return stored ? { accountId, ...stored } : null;
}
function savePasskeySecret(secret) {
    const { accountId, ...stored } = secret;
    database_1.db.prepare("UPDATE tg_accounts SET passkey = ? WHERE id = ?").run((0, secretColumns_1.encryptSecret)(JSON.stringify(stored)), accountId);
}
function getPasskeySecret(telegramPasskeyId) {
    const rows = database_1.db
        .prepare("SELECT id, passkey FROM tg_accounts WHERE passkey IS NOT NULL")
        .all();
    for (const r of rows) {
        const stored = parseStoredPasskey(r.passkey);
        if (stored?.telegramPasskeyId === telegramPasskeyId)
            return { accountId: r.id, ...stored };
    }
    return undefined;
}
function clearPasskey(accountId) {
    database_1.db.prepare("UPDATE tg_accounts SET passkey = NULL WHERE id = ?").run(accountId);
}
function deletePasskeySecret(telegramPasskeyId) {
    const secret = getPasskeySecret(telegramPasskeyId);
    if (secret)
        clearPasskey(secret.accountId);
}
// Drop the stored secret when its passkey no longer exists on Telegram.
function pruneAccountPasskeySecrets(accountId, liveIds) {
    const secret = getAccountPasskey(accountId);
    if (secret && !liveIds.includes(secret.telegramPasskeyId))
        clearPasskey(accountId);
}
// Telegram passkey ids we hold the private key for (0 or 1 for a given account).
function storedPasskeyIdsForAccount(accountId) {
    const secret = getAccountPasskey(accountId);
    return secret ? [secret.telegramPasskeyId] : [];
}
// Kept returning an array so existing callers (export, .find(dcId)) are unchanged.
function accountPasskeySecrets(accountId) {
    const secret = getAccountPasskey(accountId);
    return secret ? [secret] : [];
}
// Backfill/refresh the account's home DC on the stored secret.
function setAccountPasskeyDc(accountId, dc) {
    const secret = getAccountPasskey(accountId);
    if (!secret)
        return;
    savePasskeySecret({ ...secret, ...dc });
}
// Resolves the passkey to store for an imported account, tolerating older export shapes:
// a single `passkey` object (current), or a `passkeys` array (interim builds).
function importedPasskeyFor(item) {
    const raw = item?.passkey && typeof item.passkey === "object"
        ? item.passkey
        : Array.isArray(item?.passkeys)
            ? item.passkeys.find((p) => p?.dcId != null) ?? item.passkeys[0]
            : null;
    if (!raw || typeof raw !== "object")
        return null;
    const { accountId: _omit, ...stored } = raw;
    return stored;
}
