"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CF_KEYS_SETTING = void 0;
exports.maskKey = maskKey;
exports.cfLicenseKeys = cfLicenseKeys;
exports.cfLicenseKeysForClient = cfLicenseKeysForClient;
exports.saveCfLicenseKeys = saveCfLicenseKeys;
exports.leaseCfLicenseKey = leaseCfLicenseKey;
exports.anyCfLicenseKey = anyCfLicenseKey;
exports.cfLicenseUsage = cfLicenseUsage;
const database_1 = require("../db/database");
// CloakBrowser licence keys. The binary that ships without a key is the old free build,
// which ages as detection moves on; a key -- free, one per GitHub sign-in -- gets the
// current build instead. A free key allows one concurrent session, so several of them are
// kept here and one is leased per running browser: with two keys two jobs can solve at
// once, which is what Bemby's scheduler runs.
//
// Keys are stored in the settings table and never sent back to the client in full.
exports.CF_KEYS_SETTING = "cf_cloak_keys";
function maskKey(key) {
    if (key.length <= 10)
        return "****";
    return `${key.slice(0, 7)}****${key.slice(-4)}`;
}
function readKeys() {
    try {
        const row = database_1.db.prepare("SELECT value FROM settings WHERE key = ?").get(exports.CF_KEYS_SETTING);
        const parsed = JSON.parse(row?.value ?? "[]");
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .map((entry) => ({ label: String(entry?.label ?? ""), key: String(entry?.key ?? "").trim() }))
            .filter((entry) => entry.key);
    }
    catch {
        return [];
    }
}
function cfLicenseKeys() {
    return readKeys();
}
function cfLicenseKeysForClient() {
    return readKeys().map((entry) => ({ label: entry.label, masked: maskKey(entry.key) }));
}
/**
 * Replaces the stored keys. An entry whose key is the masked form the client was given
 * keeps whatever is stored under that label, so editing a label does not require the
 * operator to paste every key again.
 */
function saveCfLicenseKeys(incoming) {
    const existing = readKeys();
    const kept = [];
    const seen = new Set();
    for (const entry of incoming) {
        const label = String(entry?.label ?? "").trim();
        const raw = String(entry?.key ?? "").trim();
        const key = raw.includes("****") ? existing.find((e) => maskKey(e.key) === raw)?.key : raw;
        if (!key || seen.has(key))
            continue;
        seen.add(key);
        kept.push({ label, key });
    }
    database_1.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(exports.CF_KEYS_SETTING, JSON.stringify(kept));
    // The seats belonged to the old list, and anything queued for one was queued for a key
    // that may no longer exist
    leased.clear();
    for (const waiter of waiting.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.resolve(NO_KEY);
    }
    return kept;
}
// Keys handed out to a browser that is still running. A free key is one concurrent
// session, so a key in here is not offered again until its browser closes.
const leased = new Set();
const waiting = [];
const NO_KEY = { release: () => { } };
function handOut(key) {
    let released = false;
    return {
        key,
        release: () => {
            if (released)
                return;
            released = true;
            const next = waiting.shift();
            if (next) {
                // Passed on while still counted as leased: the seat never goes back to the pool
                clearTimeout(next.timer);
                next.resolve(handOut(key));
                return;
            }
            leased.delete(key);
        },
    };
}
/**
 * Takes a key for one browser.
 *
 * A free key is a single concurrent session, so when every key is out this waits for one
 * rather than doubling up -- which the licence server refuses -- for up to `waitMs`.
 * Waiting is the honest answer: it makes how many solvers run at once follow how many keys
 * the operator has, instead of failing the job or quietly running an unlicensed build.
 *
 * Gives up with no key when the wait runs out, or when none is configured at all.
 */
function leaseCfLicenseKey(waitMs = 0) {
    const envKey = process.env.CLOAKBROWSER_LICENSE_KEY?.trim();
    if (envKey)
        return Promise.resolve({ key: envKey, release: () => { } });
    const keys = readKeys();
    const free = keys.find((entry) => !leased.has(entry.key));
    if (free) {
        leased.add(free.key);
        return Promise.resolve(handOut(free.key));
    }
    if (!keys.length || waitMs <= 0)
        return Promise.resolve(NO_KEY);
    return new Promise((resolve) => {
        const waiter = {
            resolve,
            timer: setTimeout(() => {
                const at = waiting.indexOf(waiter);
                if (at >= 0)
                    waiting.splice(at, 1);
                resolve(NO_KEY);
            }, waitMs),
        };
        waiting.push(waiter);
    });
}
/**
 * A key to identify the account with, without taking a seat. Downloading a build is not a
 * browser session, so the installer must not hold one -- and must not be told there is no
 * key just because every seat is currently in a running browser.
 */
function anyCfLicenseKey() {
    return process.env.CLOAKBROWSER_LICENSE_KEY?.trim() || readKeys()[0]?.key;
}
/** How many keys are configured and how many are in use right now, for the settings view. */
function cfLicenseUsage() {
    return { total: readKeys().length, inUse: leased.size };
}
