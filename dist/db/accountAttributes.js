"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LEGACY_PASSKEY_STORE_KEY = void 0;
exports.parseAttributes = parseAttributes;
exports.getAttributes = getAttributes;
exports.writeAttributes = writeAttributes;
exports.patchAttributes = patchAttributes;
exports.publicAttributes = publicAttributes;
exports.foldImportedAttributes = foldImportedAttributes;
const database_1 = require("./database");
// Legacy settings key where passkeys lived before they moved onto the account row.
// Retained so old backups can still be recognised (and skipped) on import.
exports.LEGACY_PASSKEY_STORE_KEY = "tg_passkey_secrets";
function parseAttributes(raw) {
    if (!raw)
        return {};
    try {
        const value = JSON.parse(raw);
        return value && typeof value === "object" ? value : {};
    }
    catch {
        return {};
    }
}
function getAttributes(accountId) {
    const row = database_1.db
        .prepare("SELECT additional_attributes FROM tg_accounts WHERE id = ?")
        .get(accountId);
    return parseAttributes(row?.additional_attributes);
}
function writeAttributes(accountId, attrs) {
    const empty = !attrs || Object.keys(attrs).length === 0;
    database_1.db.prepare("UPDATE tg_accounts SET additional_attributes = ? WHERE id = ?").run(empty ? null : JSON.stringify(attrs), accountId);
}
// Merge a partial patch into the bag; a key set to undefined is removed.
function patchAttributes(accountId, patch) {
    const next = { ...getAttributes(accountId) };
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined)
            delete next[key];
        else
            next[key] = value;
    }
    writeAttributes(accountId, next);
}
// The bag as safe to expose to the UI. Defence in depth: strips a `passkey` key in case
// a legacy row still has the secret embedded (it belongs in the dedicated passkey column).
function publicAttributes(attrs) {
    const { passkey: _passkey, ...rest } = attrs;
    return rest;
}
// The attributes bag to store for an imported account (null when absent/empty).
function foldImportedAttributes(item) {
    const bag = item?.additionalAttributes;
    if (bag && typeof bag === "object" && Object.keys(bag).length) {
        return bag;
    }
    return null;
}
