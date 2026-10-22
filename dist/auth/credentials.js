"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.legacyHashPassword = legacyHashPassword;
exports.hashPassword = hashPassword;
exports.isArgon2Hash = isArgon2Hash;
exports.verifyPassword = verifyPassword;
exports.timingSafeCompare = timingSafeCompare;
exports.constantTimeStringEquals = constantTimeStringEquals;
exports.getStoredCredentials = getStoredCredentials;
const crypto_1 = __importDefault(require("crypto"));
const argon2_1 = __importDefault(require("argon2"));
const database_1 = require("../db/database");
// Legacy HMAC key -- retained only for verifying existing stored hashes during migration
const LEGACY_HMAC_KEY = 'bemby-pwd-v1';
function legacyHashPassword(password) {
    return crypto_1.default.createHmac('sha256', LEGACY_HMAC_KEY).update(password).digest('hex');
}
async function hashPassword(password) {
    return argon2_1.default.hash(password, { type: argon2_1.default.argon2id });
}
function isArgon2Hash(h) {
    return h.startsWith('$argon2');
}
async function verifyPassword(plaintext, stored) {
    if (isArgon2Hash(stored))
        return argon2_1.default.verify(stored, plaintext);
    // Legacy HMAC path -- constant-time comparison
    return timingSafeCompare(legacyHashPassword(plaintext), stored);
}
function timingSafeCompare(a, b) {
    if (a.length !== b.length)
        return false;
    return crypto_1.default.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
/**
 * Constant-time equality for values of any length. `timingSafeCompare` above returns early
 * when the lengths differ, which is right for two hashes (always the same length) but leaks
 * the length of anything else. Hashing both sides first gives fixed-length inputs, so this
 * suits a username, where the length is part of what an attacker is trying to learn.
 */
function constantTimeStringEquals(a, b) {
    const ha = crypto_1.default.createHash('sha256').update(a, 'utf8').digest();
    const hb = crypto_1.default.createHash('sha256').update(b, 'utf8').digest();
    return crypto_1.default.timingSafeEqual(ha, hb);
}
function getStoredCredentials() {
    const rows = database_1.db.prepare("SELECT key, value FROM settings WHERE key IN ('admin_username', 'admin_password_hash')").all();
    const map = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return {
        username: map['admin_username'] ?? (process.env.ADMIN_USERNAME ?? 'admin'),
        passwordHash: map['admin_password_hash'] ?? null,
    };
}
