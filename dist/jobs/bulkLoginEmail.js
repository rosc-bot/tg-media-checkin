"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_EMAIL_TAG = void 0;
exports.buildPlusAddress = buildPlusAddress;
exports.digitsToLetters = digitsToLetters;
exports.expandEmailTag = expandEmailTag;
exports.extractLoginCode = extractLoginCode;
exports.testGmailImap = testGmailImap;
exports.changeLoginEmailViaGmail = changeLoginEmailViaGmail;
const imapflow_1 = require("imapflow");
const mailparser_1 = require("mailparser");
const tgAuth_1 = require("../auth/tgAuth");
const checkin_1 = require("./checkin");
// Automates a Telegram login-email change against a Gmail inbox: each account
// gets a plus-address (local+{tag}@gmail.com) where {tag} is expanded from a
// user template. Telegram emails a code there, and the code is read back over
// IMAP using a Gmail app password. Nothing is stored; the Gmail credentials
// live only for the request.
exports.DEFAULT_EMAIL_TAG = "{phoneNum}";
// Builds local+{suffix}@domain from a base Gmail address (plus-addressing).
function buildPlusAddress(gmail, suffix) {
    const at = gmail.lastIndexOf("@");
    if (at === -1)
        throw new Error("Invalid Gmail address");
    const local = gmail.slice(0, at);
    const domain = gmail.slice(at + 1);
    return `${local}+${suffix}@${domain}`;
}
// Maps digits to letters (0=a, 1=b, ... 9=j). Telegram rejects login-email
// plus-tags that contain digits, so the whole tag is de-digitised.
function digitsToLetters(s) {
    return s.replace(/[0-9]/g, (d) => String.fromCharCode(97 + Number(d)));
}
// Expands a tag template into a Gmail plus-tag. Named tokens: {phoneNum},
// {tgId}, {id}; random tokens ({word:N}, {alpha:N}, {uuid}) come from
// expandCommand. Digits are mapped to letters (Telegram rejects numeric tags)
// and the result is stripped to address-safe characters.
async function expandEmailTag(template, ctx) {
    const phoneDigits = ctx.phoneNumber.replace(/\D/g, "");
    const context = {
        phoneNum: phoneDigits,
        phone: phoneDigits,
        id: String(ctx.accountId),
    };
    if (/\{tgId\}/.test(template))
        context.tgId = await ctx.getTgId();
    const expanded = digitsToLetters((0, checkin_1.expandCommand)(template, context));
    const tag = expanded.replace(/[^A-Za-z._-]/g, "");
    if (!tag)
        throw new Error("Email tag template produced an empty value");
    return tag;
}
// Pulls the numeric code out of Telegram's login-email message. Prefers a code
// next to the word "code"; otherwise the first 5-7 digit run.
function extractLoginCode(subject, text) {
    const hay = `${subject ?? ""}\n${text ?? ""}`;
    const labelled = hay.match(/code[^0-9]{0,20}(\d{5,7})/i);
    if (labelled)
        return labelled[1];
    const any = hay.match(/\b(\d{5,7})\b/);
    return any ? any[1] : null;
}
// Verifies the Gmail address + app password can log in over IMAP.
async function testGmailImap(gmail, appPassword) {
    const client = new imapflow_1.ImapFlow({
        host: "imap.gmail.com",
        port: 993,
        secure: true,
        auth: { user: gmail, pass: appPassword },
        logger: false,
    });
    try {
        await client.connect();
        await client.logout();
        return { ok: true };
    }
    catch (err) {
        await client.logout().catch(() => undefined);
        return {
            ok: false,
            error: err?.responseText || err?.message || "IMAP login failed",
        };
    }
}
// Polls the Gmail inbox over IMAP for a Telegram code sent to `toAddress`,
// returning the parsed code or null on timeout.
async function fetchTelegramLoginCode(opts) {
    const client = new imapflow_1.ImapFlow({
        host: "imap.gmail.com",
        port: 993,
        secure: true,
        auth: { user: opts.gmail, pass: opts.appPassword },
        logger: false,
    });
    await client.connect();
    // logout is guarded here so a failure to acquire the mailbox lock still
    // closes the connection instead of leaking it.
    try {
        const lock = await client.getMailboxLock("INBOX");
        try {
            const deadline = Date.now() + opts.timeoutMs;
            const since = new Date(opts.sinceMs);
            while (true) {
                let uids = [];
                try {
                    await client.noop();
                    uids = (await client.search({ since, to: opts.toAddress }, { uid: true })) || [];
                }
                catch {
                    uids = [];
                }
                // Newest first
                for (const uid of [...uids].reverse()) {
                    const msg = await client.fetchOne(uid, { source: true }, { uid: true });
                    if (!msg || !msg.source)
                        continue;
                    const parsed = await (0, mailparser_1.simpleParser)(msg.source);
                    const body = parsed.text || parsed.html || "";
                    const code = extractLoginCode(parsed.subject ?? "", body);
                    if (code)
                        return code;
                }
                if (Date.now() >= deadline)
                    return null;
                await new Promise((r) => setTimeout(r, 5000));
            }
        }
        finally {
            lock.release();
        }
    }
    finally {
        await client.logout().catch(() => undefined);
    }
}
// Full flow for one account: expand the tag template into a plus-address, ask
// Telegram to send a code there, read the code from Gmail, then confirm it.
async function changeLoginEmailViaGmail(params) {
    const { apiId, apiHash, sessionString, proxy, deviceParams } = params;
    const tag = await expandEmailTag(params.tag || exports.DEFAULT_EMAIL_TAG, {
        phoneNumber: params.phoneNumber,
        accountId: params.accountId,
        getTgId: () => (0, tgAuth_1.getSelfId)(apiId, apiHash, sessionString, proxy, deviceParams),
    });
    const toAddress = buildPlusAddress(params.gmail, tag);
    // Look a little before "now" to absorb clock skew between hosts
    const sinceMs = Date.now() - 60000;
    await (0, tgAuth_1.sendLoginEmailCode)(apiId, apiHash, sessionString, toAddress, proxy, deviceParams);
    const code = await fetchTelegramLoginCode({
        gmail: params.gmail,
        appPassword: params.appPassword,
        toAddress,
        sinceMs,
        timeoutMs: 60000,
    });
    if (!code)
        throw new Error("No verification code arrived in Gmail within the timeout");
    await (0, tgAuth_1.verifyLoginEmail)(apiId, apiHash, sessionString, code, proxy, deviceParams);
    return { email: toAddress };
}
