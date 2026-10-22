"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.sweepPendingAuth = sweepPendingAuth;
exports.requestCode = requestCode;
exports.resendCodeAsSms = resendCodeAsSms;
exports.cancelPendingAuth = cancelPendingAuth;
exports.submitCode = submitCode;
exports.checkAccountStatus = checkAccountStatus;
exports.updateTwoFa = updateTwoFa;
exports.getProfile = getProfile;
exports.updateProfile = updateProfile;
exports.getSessions = getSessions;
exports.terminateSession = terminateSession;
exports.terminateOtherSessions = terminateOtherSessions;
exports.submitPassword = submitPassword;
exports.getSelfId = getSelfId;
exports.getPasswordInfo = getPasswordInfo;
exports.sendLoginEmailCode = sendLoginEmailCode;
exports.verifyLoginEmail = verifyLoginEmail;
exports.getPasskeys = getPasskeys;
exports.deletePasskey = deletePasskey;
exports.registerPasskey = registerPasskey;
exports.verifyPasskeyLogin = verifyPasskeyLogin;
exports.getSessionDc = getSessionDc;
exports.startPasskeyLogin = startPasskeyLogin;
const telegram_1 = require("telegram");
const Logger_1 = require("telegram/extensions/Logger");
const sessions_1 = require("telegram/sessions");
const passkeys_1 = require("../tg/passkeys");
// In-memory pending auth sessions keyed by account ID
const pending = new Map();
// Each entry holds a connected TelegramClient, so an auth nobody finishes (the
// browser tab closed at the code prompt, a bulk add that moved on) would pin a
// live connection for the life of the process. Telegram expires login codes in
// minutes, so anything older than this is certainly dead.
const PENDING_AUTH_TTL_MS = 15 * 60000;
const PENDING_SWEEP_INTERVAL_MS = 5 * 60000;
function sweepPendingAuth(now = Date.now()) {
    let dropped = 0;
    for (const [accountId, entry] of pending) {
        if (now - entry.startedAt < PENDING_AUTH_TTL_MS)
            continue;
        pending.delete(accountId);
        entry.client.destroy().catch(() => undefined);
        dropped++;
    }
    if (dropped)
        console.log(`[tgAuth] Dropped ${dropped} abandoned auth session(s)`);
    return dropped;
}
// unref() so the sweep never keeps the process (or test runner) alive
setInterval(() => sweepPendingAuth(), PENDING_SWEEP_INTERVAL_MS).unref();
// Bound on the connect+sendCode round trip. GramJS's connectionRetries limits
// reconnect attempts but not total wall-clock time, so a dead/slow proxy or an
// unresponsive DC can leave the await pending forever -- which stalls the
// sequential bulk-add loop on that account. Turning the stall into a rejection
// lets callers fail the account and move on.
const REQUEST_CODE_TIMEOUT_MS = 180000;
async function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    try {
        return await Promise.race([promise, timeout]);
    }
    finally {
        clearTimeout(timer);
    }
}
async function requestCode(accountId, apiId, apiHash, phoneNumber, proxy, deviceParams) {
    const existing = pending.get(accountId);
    if (existing) {
        await existing.client.destroy().catch(() => undefined);
        pending.delete(accountId);
    }
    // Do not pass deviceParams during auth -- desktop profiles (PC 64bit / tdesktop)
    // cause Telegram to route the code to a non-existent desktop session.
    // GramJS defaults (Android-like) have reliable SMS/app fallback.
    // The configured device profile is applied only in the live session (getLiveClient).
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(""), apiId, apiHash, {
        connectionRetries: 3,
        baseLogger: new telegram_1.Logger(Logger_1.LogLevel.NONE),
        ...(proxy ? { proxy } : {}),
    });
    try {
        await withTimeout(client.connect(), REQUEST_CODE_TIMEOUT_MS, "connect");
        const sent = await withTimeout(client.sendCode({ apiId, apiHash }, phoneNumber), REQUEST_CODE_TIMEOUT_MS, "sendCode");
        const isCodeViaApp = sent.type?.className === "auth.SentCodeTypeApp";
        pending.set(accountId, {
            client,
            phoneNumber,
            phoneCodeHash: sent.phoneCodeHash,
            step: "code",
            startedAt: Date.now(),
        });
        return { isCodeViaApp };
    }
    catch (err) {
        // Nothing holds a reference to this client yet — destroy it so a failed
        // send (bad/blocked number, flood-wait) doesn't leak a connected session.
        await client.destroy().catch(() => undefined);
        throw err;
    }
}
async function resendCodeAsSms(accountId) {
    const entry = pending.get(accountId);
    if (!entry || entry.step !== "code")
        throw new Error("No pending code auth for this account");
    const result = await entry.client.invoke(new telegram_1.Api.auth.ResendCode({
        phoneNumber: entry.phoneNumber,
        phoneCodeHash: entry.phoneCodeHash,
    }));
    // Update the hash from the resend response
    entry.phoneCodeHash = result.phoneCodeHash ?? entry.phoneCodeHash;
}
// Destroy and drop a parked pending-auth client. Callers that abandon an
// auth flow mid-way (e.g. bulk-add moving on after a failure) must call this,
// or the connected client leaks -- nothing else evicts it unless requestCode
// is retried for the same account id.
async function cancelPendingAuth(accountId) {
    const entry = pending.get(accountId);
    if (!entry)
        return;
    pending.delete(accountId);
    await entry.client.destroy().catch(() => undefined);
}
async function submitCode(accountId, code) {
    const entry = pending.get(accountId);
    if (!entry || entry.step !== "code")
        throw new Error("No pending code auth for this account");
    try {
        await entry.client.invoke(new telegram_1.Api.auth.SignIn({
            phoneNumber: entry.phoneNumber,
            phoneCodeHash: entry.phoneCodeHash,
            phoneCode: code,
        }));
        const session = entry.client.session.save();
        await entry.client.destroy().catch(() => undefined);
        pending.delete(accountId);
        return { needsPassword: false, session };
    }
    catch (err) {
        if (err?.errorMessage === "SESSION_PASSWORD_NEEDED") {
            entry.step = "2fa";
            // Reaching the password prompt restarts the clock, so a slow 2FA entry
            // isn't swept out from under the user
            entry.startedAt = Date.now();
            return { needsPassword: true };
        }
        throw err;
    }
}
// Telegram error codes that indicate a permanently banned / deactivated account
const BANNED_CODES = [
    "USER_DEACTIVATED",
    "USER_DEACTIVATED_BAN",
    "PHONE_NUMBER_BANNED",
];
// Telegram error codes that indicate a frozen or revoked session
const FROZEN_CODES = [
    "ACCOUNT_FROZEN",
    "AUTH_KEY_UNREGISTERED",
    "SESSION_REVOKED",
    "AUTH_KEY_DUPLICATED",
];
const FROZEN_TEXT = {
    ACCOUNT_FROZEN: "Account is frozen by Telegram",
    AUTH_KEY_UNREGISTERED: "Session revoked — account may have been banned or logged out everywhere",
    SESSION_REVOKED: "Session was explicitly revoked",
    AUTH_KEY_DUPLICATED: "Auth key duplicated — session is no longer valid",
};
async function checkAccountStatus(apiId, apiHash, sessionString, proxy, deviceParams) {
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 3,
        baseLogger: new telegram_1.Logger(Logger_1.LogLevel.NONE),
        ...(proxy ? { proxy } : {}),
        ...(deviceParams ?? {}),
    });
    try {
        await client.connect();
        const me = await client.getMe();
        // UserEmpty or null — account deleted / inaccessible
        if (!me || me.className === "UserEmpty") {
            return {
                isActive: false,
                isDeleted: true,
                isRestricted: false,
                restrictions: [],
                firstName: "",
            };
        }
        const user = me;
        const isDeleted = Boolean(user.deleted);
        const isRestricted = Boolean(user.restricted);
        return {
            isActive: !isDeleted && !isRestricted,
            isDeleted,
            isRestricted,
            restrictions: (user.restrictionReason ?? []).map((r) => ({
                platform: r.platform,
                reason: r.reason,
                text: r.text,
            })),
            firstName: user.firstName ?? "",
            lastName: user.lastName,
            username: user.username,
            phone: user.phone,
        };
    }
    catch (err) {
        const code = err?.errorMessage ?? "";
        if (BANNED_CODES.includes(code)) {
            return {
                isActive: false,
                isDeleted: true,
                isRestricted: false,
                restrictions: [
                    {
                        platform: "all",
                        reason: "banned",
                        text: `Account banned by Telegram (${code})`,
                    },
                ],
                firstName: "",
            };
        }
        if (FROZEN_CODES.includes(code)) {
            return {
                isActive: false,
                isDeleted: false,
                isRestricted: true,
                restrictions: [
                    {
                        platform: "all",
                        reason: code.toLowerCase(),
                        text: FROZEN_TEXT[code] ?? code,
                    },
                ],
                firstName: "",
            };
        }
        throw err;
    }
    finally {
        await client.destroy().catch(() => undefined);
    }
}
async function updateTwoFa(apiId, apiHash, sessionString, opts, proxy, deviceParams) {
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 3,
        baseLogger: new telegram_1.Logger(Logger_1.LogLevel.NONE),
        ...(proxy ? { proxy } : {}),
        ...(deviceParams ?? {}),
    });
    try {
        await client.connect();
        await client.updateTwoFaSettings({
            currentPassword: opts.currentPassword || undefined,
            newPassword: opts.newPassword || undefined,
            hint: opts.hint ?? "",
        });
    }
    finally {
        await client.destroy().catch(() => undefined);
    }
}
// Read the account's own Telegram profile (first/last name + bio).
async function getProfile(apiId, apiHash, sessionString, proxy, deviceParams) {
    const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
    try {
        await client.connect();
        const me = (await client.getMe());
        const full = await client.invoke(new telegram_1.Api.users.GetFullUser({ id: new telegram_1.Api.InputUserSelf() }));
        return {
            firstName: me?.firstName ?? "",
            lastName: me?.lastName ?? "",
            about: full.fullUser.about ?? "",
        };
    }
    finally {
        await client.destroy().catch(() => undefined);
    }
}
// Update the account's own Telegram profile. Empty strings clear the field.
async function updateProfile(apiId, apiHash, sessionString, opts, proxy, deviceParams) {
    const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
    try {
        await client.connect();
        await client.invoke(new telegram_1.Api.account.UpdateProfile({
            firstName: opts.firstName,
            lastName: opts.lastName ?? "",
            about: opts.about ?? "",
        }));
        const me = (await client.getMe());
        return {
            firstName: me?.firstName ?? "",
            lastName: me?.lastName ?? "",
            about: opts.about ?? "",
        };
    }
    finally {
        await client.destroy().catch(() => undefined);
    }
}
async function getSessions(apiId, apiHash, sessionString, proxy, deviceParams) {
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 3,
        baseLogger: new telegram_1.Logger(Logger_1.LogLevel.NONE),
        ...(proxy ? { proxy } : {}),
        ...(deviceParams ?? {}),
    });
    try {
        await client.connect();
        const result = await client.invoke(new telegram_1.Api.account.GetAuthorizations());
        return result.authorizations.map((a) => ({
            hash: a.hash.toString(),
            current: Boolean(a.current),
            deviceModel: a.deviceModel,
            platform: a.platform,
            systemVersion: a.systemVersion,
            appName: a.appName,
            appVersion: a.appVersion,
            dateCreated: a.dateCreated,
            dateActive: a.dateActive,
            ip: a.ip,
            country: a.country,
            region: a.region,
        }));
    }
    finally {
        await client.destroy().catch(() => undefined);
    }
}
async function terminateSession(apiId, apiHash, sessionString, hash, proxy, deviceParams) {
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 3,
        baseLogger: new telegram_1.Logger(Logger_1.LogLevel.NONE),
        ...(proxy ? { proxy } : {}),
        ...(deviceParams ?? {}),
    });
    try {
        await client.connect();
        await client.invoke(new telegram_1.Api.account.ResetAuthorization({ hash: BigInt(hash) }));
    }
    finally {
        await client.destroy().catch(() => undefined);
    }
}
async function terminateOtherSessions(apiId, apiHash, sessionString, proxy, deviceParams) {
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 3,
        baseLogger: new telegram_1.Logger(Logger_1.LogLevel.NONE),
        ...(proxy ? { proxy } : {}),
        ...(deviceParams ?? {}),
    });
    try {
        await client.connect();
        await client.invoke(new telegram_1.Api.auth.ResetAuthorizations());
    }
    finally {
        await client.destroy().catch(() => undefined);
    }
}
async function submitPassword(accountId, password) {
    const entry = pending.get(accountId);
    if (!entry || entry.step !== "2fa")
        throw new Error("No pending 2FA for this account");
    // Dynamic import to avoid issues with module resolution
    const { computeCheck } = await Promise.resolve().then(() => __importStar(require("telegram/Password")));
    const passwordInfo = await entry.client.invoke(new telegram_1.Api.account.GetPassword());
    const passwordSrp = await computeCheck(passwordInfo, password);
    await entry.client.invoke(new telegram_1.Api.auth.CheckPassword({ password: passwordSrp }));
    const session = entry.client.session.save();
    await entry.client.destroy().catch(() => undefined);
    pending.delete(accountId);
    return session;
}
function makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams) {
    return new telegram_1.TelegramClient(new sessions_1.StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 3,
        baseLogger: new telegram_1.Logger(Logger_1.LogLevel.NONE),
        ...(proxy ? { proxy } : {}),
        ...(deviceParams ?? {}),
    });
}
/** Returns the account's own Telegram numeric user id as a string. */
async function getSelfId(apiId, apiHash, sessionString, proxy, deviceParams) {
    const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
    try {
        await client.connect();
        const me = await client.getMe();
        const id = me?.id;
        if (id === undefined || id === null)
            throw new Error("Could not resolve Telegram user id");
        return String(id);
    }
    finally {
        await client.destroy().catch(() => undefined);
    }
}
async function getPasswordInfo(apiId, apiHash, sessionString, proxy, deviceParams) {
    const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
    try {
        await client.connect();
        const pwd = await client.invoke(new telegram_1.Api.account.GetPassword());
        return {
            hasPassword: Boolean(pwd.hasPassword),
            hasRecovery: Boolean(pwd.hasRecovery),
            hint: pwd.hint ?? null,
            emailUnconfirmedPattern: pwd.emailUnconfirmedPattern ?? null,
            loginEmailPattern: pwd.loginEmailPattern ?? null,
        };
    }
    finally {
        await client.destroy().catch(() => undefined);
    }
}
// ── Login email management ────────────────────────────────────────────────────
// The masked pattern comes from account.getPassword (loginEmailPattern).
// Setting or replacing uses SendVerifyEmailCode + VerifyEmail with the
// emailVerifyPurposeLoginChange purpose. Telegram provides no method to remove
// a login email from an authorised session -- it can only be replaced.
/** Send a verification code to a new login email address. */
async function sendLoginEmailCode(apiId, apiHash, sessionString, email, proxy, deviceParams) {
    const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
    try {
        await client.connect();
        // GramJS bug: EntityCache.add treats any response with a numeric `length`
        // field as array-like, and account.SentEmailCode has one (the code length),
        // so invoke() crashes with "entities is not iterable" after a successful RPC.
        // The response carries no entities, so disable caching on this throwaway client.
        client
            ._entityCache.add = () => undefined;
        const sent = await client.invoke(new telegram_1.Api.account.SendVerifyEmailCode({
            purpose: new telegram_1.Api.EmailVerifyPurposeLoginChange(),
            email,
        }));
        return { emailPattern: sent.emailPattern, codeLength: sent.length };
    }
    finally {
        await client.destroy().catch(() => undefined);
    }
}
/** Verify the code sent by sendLoginEmailCode, committing the new login email. */
async function verifyLoginEmail(apiId, apiHash, sessionString, code, proxy, deviceParams) {
    const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
    try {
        await client.connect();
        const verified = await client.invoke(new telegram_1.Api.account.VerifyEmail({
            purpose: new telegram_1.Api.EmailVerifyPurposeLoginChange(),
            verification: new telegram_1.Api.EmailVerificationCode({ code }),
        }));
        return { email: "email" in verified ? (verified.email ?? null) : null };
    }
    finally {
        await client.destroy().catch(() => undefined);
    }
}
// ── Passkeys ──────────────────────────────────────────────────────────────────
// Uses raw TL requests (see tg/passkeys.ts) since GramJS lacks passkey types.
async function getPasskeys(apiId, apiHash, sessionString, proxy, deviceParams) {
    const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
    try {
        await client.connect();
        return await (0, passkeys_1.invokeGetPasskeys)(client);
    }
    finally {
        await client.destroy().catch(() => undefined);
    }
}
async function deletePasskey(apiId, apiHash, sessionString, passkeyId, proxy, deviceParams) {
    const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
    try {
        await client.connect();
        return await (0, passkeys_1.invokeDeletePasskey)(client, passkeyId);
    }
    finally {
        await client.destroy().catch(() => undefined);
    }
}
// Experimental: registers a new passkey by running the WebAuthn ceremony in Node
// (no browser). Returns the private key material for a possible future login.
async function registerPasskey(apiId, apiHash, sessionString, originOverride, proxy, deviceParams) {
    const client = makeTgClient(sessionString, apiId, apiHash, proxy, deviceParams);
    try {
        await client.connect();
        return await (0, passkeys_1.invokeRegisterPasskey)(client, originOverride);
    }
    finally {
        await client.destroy().catch(() => undefined);
    }
}
// Verifies a stored passkey by logging in with it on a fresh (empty) session.
// Passkey login is DC-specific: it must run on the DC where the account lives, so
// we pin the fresh session to the authorised session's DC (avoids the cross-DC
// finishPasskeyLogin path, which otherwise fails as PASSKEY_CHALLENGE_EXPIRED).
async function verifyPasskeyLogin(apiId, apiHash, accountSessionString, secret, originOverride, proxy, deviceParams) {
    const authed = new sessions_1.StringSession(accountSessionString);
    const fresh = new sessions_1.StringSession("");
    fresh.setDC(authed.dcId, authed.serverAddress, authed.port);
    const client = new telegram_1.TelegramClient(fresh, apiId, apiHash, {
        connectionRetries: 3,
        baseLogger: new telegram_1.Logger(Logger_1.LogLevel.NONE),
        ...(proxy ? { proxy } : {}),
        ...(deviceParams ?? {}),
    });
    try {
        await client.connect();
        return await (0, passkeys_1.invokeVerifyPasskeyLogin)(client, apiId, apiHash, secret, originOverride);
    }
    finally {
        await client.destroy().catch(() => undefined);
    }
}
// Reads the account's home DC out of an authorised session string.
function getSessionDc(sessionString) {
    if (!sessionString)
        return null;
    try {
        const s = new sessions_1.StringSession(sessionString);
        if (s.dcId == null || !s.serverAddress || s.port == null)
            return null;
        return { dcId: s.dcId, serverAddress: s.serverAddress, port: s.port };
    }
    catch {
        return null;
    }
}
// Logs in using a stored passkey as the first factor. On success without 2FA the
// session is returned; when the account has a cloud password, the connected client
// is parked in `pending` (step "2fa") so submitPassword() finishes it exactly like
// the code flow. Throws (caller falls back to code login) if the passkey is rejected.
async function startPasskeyLogin(accountId, apiId, apiHash, secret, originOverride, proxy) {
    const existing = pending.get(accountId);
    if (existing) {
        await existing.client.destroy().catch(() => undefined);
        pending.delete(accountId);
    }
    const fresh = new sessions_1.StringSession("");
    if (secret.dcId != null && secret.serverAddress && secret.port != null) {
        fresh.setDC(secret.dcId, secret.serverAddress, secret.port);
    }
    // No deviceParams during auth (same rationale as requestCode).
    const client = new telegram_1.TelegramClient(fresh, apiId, apiHash, {
        connectionRetries: 3,
        baseLogger: new telegram_1.Logger(Logger_1.LogLevel.NONE),
        ...(proxy ? { proxy } : {}),
    });
    try {
        await client.connect();
        try {
            await (0, passkeys_1.invokePasskeyLogin)(client, apiId, apiHash, secret, originOverride);
        }
        catch (err) {
            const msg = err?.errorMessage ?? err?.message ?? "";
            if (msg.includes("SESSION_PASSWORD_NEEDED")) {
                // Keep the client alive for the 2FA step.
                pending.set(accountId, {
                    client,
                    phoneNumber: "",
                    phoneCodeHash: "",
                    step: "2fa",
                    startedAt: Date.now(),
                });
                return { needsPassword: true };
            }
            throw err;
        }
        const session = client.session.save();
        await client.destroy().catch(() => undefined);
        return { needsPassword: false, session };
    }
    catch (err) {
        await client.destroy().catch(() => undefined);
        throw err;
    }
}
