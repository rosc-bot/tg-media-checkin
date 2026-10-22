"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ENCRYPTED_ACCOUNT_COLUMNS = void 0;
exports.resetSecretKeyCache = resetSecretKeyCache;
exports.isSecretEncryptionEnabled = isSecretEncryptionEnabled;
exports.isEncryptedSecret = isEncryptedSecret;
exports.encryptSecret = encryptSecret;
exports.decryptSecret = decryptSecret;
exports.decryptAccountRow = decryptAccountRow;
const crypto_1 = __importDefault(require("crypto"));
// A Telegram session string is a login. So is an account's api_hash, and a passkey's private
// key more so. All three sat in the SQLite file as plain text, which meant a copy of the
// volume -- a stray backup, a snapshot, a mounted disk -- was every account on the panel.
// A backup taken through the export endpoint is forced to be encrypted; the file those
// exports come from was not, which is the gap this closes.
//
// Encryption is opt-in through BEMBY_DATA_KEY, deliberately:
//
//   * Deriving the key from JWT_SECRET would tie two unrelated rotations together, and
//     rotating the JWT secret (a routine thing to do) would silently destroy every stored
//     session with no way back.
//   * Generating a key and keeping it next to the data would protect nothing at all: whoever
//     has the database file has the file beside it.
//
// So the key comes from the environment or there is no encryption, and the operator is told
// at boot which of the two they have. Values already written stay readable either way:
// anything without the marker below is returned as it is, so turning the key on encrypts
// going forward and the sweep in `encryptExistingSecrets` catches up with the rest.
const MARKER = "enc:v1:";
/** Fixed salt: the key material is already high-entropy, and the salt must survive restarts. */
const KDF_SALT = Buffer.from("bemby-secret-columns-v1");
let cachedKey;
function key() {
    if (cachedKey !== undefined)
        return cachedKey;
    const raw = process.env.BEMBY_DATA_KEY?.trim();
    cachedKey = raw ? crypto_1.default.scryptSync(raw, KDF_SALT, 32) : null;
    return cachedKey;
}
/** Test hook: picks up a BEMBY_DATA_KEY set after this module was first imported. */
function resetSecretKeyCache() {
    cachedKey = undefined;
}
function isSecretEncryptionEnabled() {
    return key() !== null;
}
/** Whether a stored value is already ciphertext. */
function isEncryptedSecret(value) {
    return typeof value === "string" && value.startsWith(MARKER);
}
/**
 * Encrypts a value for storage. Returns it unchanged when no key is configured, so the
 * column keeps working exactly as before on an install that has not opted in.
 */
function encryptSecret(value) {
    const k = key();
    if (!k || !value || isEncryptedSecret(value))
        return value;
    const iv = crypto_1.default.randomBytes(12);
    const cipher = crypto_1.default.createCipheriv("aes-256-gcm", k, iv);
    const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `${MARKER}${iv.toString("base64url")}:${cipher
        .getAuthTag()
        .toString("base64url")}:${ct.toString("base64url")}`;
}
/**
 * Decrypts a stored value. Anything without the marker is plain text from before the key was
 * configured and is passed straight through, which is what lets the two coexist mid-migration.
 *
 * A marked value that will not decrypt means the key has changed or gone missing. That is
 * reported once and the value treated as absent: the account shows as needing re-auth, which
 * is recoverable, rather than the process failing to start.
 */
function decryptSecret(value) {
    if (!isEncryptedSecret(value))
        return value;
    const k = key();
    if (!k) {
        warnUnreadable("BEMBY_DATA_KEY is not set but the database holds encrypted values");
        return null;
    }
    try {
        const [ivB64, tagB64, dataB64] = value.slice(MARKER.length).split(":");
        const decipher = crypto_1.default.createDecipheriv("aes-256-gcm", k, Buffer.from(ivB64, "base64url"));
        decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
        return (decipher.update(Buffer.from(dataB64, "base64url")) +
            decipher.final("utf8"));
    }
    catch {
        warnUnreadable("BEMBY_DATA_KEY does not match the key these values were written with");
        return null;
    }
}
let warned = false;
function warnUnreadable(reason) {
    if (warned)
        return;
    warned = true;
    console.error(`[secrets] Stored credentials cannot be decrypted: ${reason}. Affected accounts will ` +
        "need to be authenticated again. Restore the original key to recover them.");
}
/** The tg_accounts columns held encrypted. */
exports.ENCRYPTED_ACCOUNT_COLUMNS = ["api_hash", "session_string", "passkey"];
/** Decrypts whichever of the secret columns a fetched row actually carries. */
function decryptAccountRow(row) {
    for (const column of exports.ENCRYPTED_ACCOUNT_COLUMNS) {
        if (column in row)
            row[column] = decryptSecret(row[column] ?? null);
    }
    return row;
}
