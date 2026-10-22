"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CustomJobError = void 0;
exports.stepNeedingBot = stepNeedingBot;
exports.runCustom = runCustom;
const telegram_1 = require("telegram");
const Logger_1 = require("telegram/extensions/Logger");
const sessions_1 = require("telegram/sessions");
const events_1 = require("telegram/events");
const checkin_1 = require("./checkin");
const htmlEscape_1 = require("../tg/htmlEscape");
const cloudflare_1 = require("./cloudflare");
const miniApp_1 = require("../tg/miniApp");
const peerTarget_1 = require("../tg/peerTarget");
const proxyProviders_1 = require("../tg/proxyProviders");
const cfTuning_1 = require("./cfTuning");
// Opens a Cloudflare-gated URL (e.g. a "我不是机器人" button/answer) in the installed
// browser to pass the "I am not a bot" check, recording the outcome on the step.
// Returns the final page's visible text for success/fail matching.
async function passCloudflare(url, cfChallenge, step, webProxyUrl, miniApp = false, extra = {}, cfRun = (0, cloudflare_1.newCfRunState)()) {
    if (!cfChallenge) {
        throw new Error('This click opens a Cloudflare-protected page ("I am not a bot"). Enable "Solve Cloudflare challenge" for this action.');
    }
    const host = (() => {
        try {
            return new URL(url).host;
        }
        catch {
            return "";
        }
    })();
    const refused = (0, cloudflare_1.cfRefusedFor)(cfRun, host);
    const candidates = (0, proxyProviders_1.cfProxyCandidatesFor)({ primaryUrl: webProxyUrl, host, exclude: refused });
    if (!candidates.length) {
        throw new Error((0, cloudflare_1.cfNoCandidatesMessage)(cfRun, host));
    }
    const cf = await (0, cloudflare_1.loadCheckinUrl)(url, webProxyUrl, {
        miniApp,
        ...extra,
        // A Mini App runs entirely inside the browser, so keep what it saw
        screenshot: miniApp,
        // Cloudflare refuses some exit IPs outright, so the rest of the pool stands by --
        // minus the ones this run has already had refused
        proxyCandidates: candidates,
    });
    step.cfProxy = cf.proxyLabel;
    step.cfBuild = cf.browserTier;
    step.cfAttempts = cf.attempts;
    for (const id of cf.refusedProxyIds ?? [])
        refused.add(id);
    if (!cf.ok)
        (0, cloudflare_1.cfNoteFailure)(cfRun, cf.finalHost, cf.reason);
    if (cf.ok && cf.proxyId)
        (0, proxyProviders_1.rememberCfProxy)(cf.finalHost, cf.proxyId);
    step.cfHost = cf.finalHost;
    step.cfChallenged = cf.challenged;
    step.cfPassed = cf.ok;
    step.cfMiniApp = miniApp || undefined;
    step.cfMiniAppAction = cf.inAppAction;
    step.cfPageTitle = cf.pageTitle;
    step.cfNavError = cf.navError;
    step.cfTrace = cf.trace;
    step.cfScreenshot = cf.screenshot;
    if (!cf.ok)
        throw new Error(cf.reason ?? (0, cloudflare_1.cfFailureFallback)(cf.challenged, true));
    return cf.text;
}
// A URL or Mini App button opens a page instead of firing a callback; Mini App
// buttons get their signed URL from Telegram first, exactly as a real client does.
// After a callback click the checkin may still hinge on a page: a URL the bot
// answered with, or a follow-up URL / Mini App button in its replies. Returns the
// page text (empty when there is nothing to open).
async function followUpCfText(client, peer, answer, responses, step, webProxyUrl, cfRun = (0, cloudflare_1.newCfRunState)()) {
    const answerUrl = answer?.url;
    if (answerUrl)
        return passCloudflare(answerUrl, true, step, webProxyUrl, false, {}, cfRun);
    const hit = responses.map((r) => ({ msg: r.msg, web: (0, checkin_1.findUrlButton)(r.msg) })).find((h) => h.web);
    if (!hit?.web)
        return '';
    return (await openWebButton(client, hit.web, peer, hit.msg, true, step, webProxyUrl, cfRun)).text;
}
async function openWebButton(client, web, peer, msg, cfChallenge, step, webProxyUrl, cfRun = (0, cloudflare_1.newCfRunState)()) {
    // A `?start=` deep link is followed the way a real client does -- by sending the
    // command to that bot -- not by loading a page. Group bots use these to move a
    // verification into a private chat.
    if (web.startLink) {
        const { botUsername, startParam } = web.startLink;
        const sent = await client.sendMessage(botUsername, { message: `/start ${startParam}` });
        step.result = `Followed deep link: /start ${startParam} to @${botUsername}`;
        return { text: "", deepLinkSent: { botUsername, msg: sent } };
    }
    const { url, signed } = await (0, miniApp_1.openableButtonUrl)(client, web, peer, msg ?? undefined);
    step.cfMiniAppSigned = web.miniApp ? signed : undefined;
    if (web.miniApp && !signed) {
        throw new Error(`Telegram would not sign the Mini App behind "${web.text}"; the app cannot be opened logged in`);
    }
    return {
        text: await passCloudflare(url, cfChallenge, step, webProxyUrl, web.miniApp, {}, cfRun),
    };
}
class CustomJobError extends Error {
    constructor(message, log) {
        super(message);
        this.log = log;
        this.name = "CustomJobError";
    }
}
exports.CustomJobError = CustomJobError;
const hasInlineButtons = (m) => !!m && m.replyMarkup instanceof telegram_1.Api.ReplyInlineMarkup;
const anchorFromSent = (sent) => ({
    msgId: sent.id,
    dateSec: sent.date ?? Math.floor(Date.now() / 1000),
});
const isEditUpdate = (update) => update?.className === "UpdateEditMessage" ||
    update?.className === "UpdateEditChannelMessage";
// Lowest message id an action will accept for a given scope. scope 0 (default)
// admits only messages newer than the anchor -- the reply to what we just sent,
// which stops a stale menu from an earlier turn being clicked. scope -N also
// admits the N most recent incoming messages that predate the anchor, for bots
// whose live menu sits on an earlier message. anchorId 0 (nothing sent yet)
// falls back to accepting everything.
async function resolveScopeFloor(client, target, anchorId, scope) {
    const freshFloor = anchorId + 1;
    if (!scope || scope >= 0)
        return freshFloor;
    const n = -scope;
    const recent = (await client
        .getMessages(target, { limit: n + 20 })
        .catch(() => []));
    const prior = recent
        .filter((m) => m && !m.out && m.id <= anchorId)
        .map((m) => m.id)
        .sort((a, b) => b - a); // newest first
    if (!prior.length)
        return freshFloor;
    return prior[Math.min(n, prior.length) - 1];
}
// Authoritative membership check: GetParticipant throws USER_NOT_PARTICIPANT for pending
// join requests, unlike the Channel.left flag which can lag behind actual state.
async function isChannelMember(client, channel) {
    try {
        const result = await client.invoke(new telegram_1.Api.channels.GetParticipant({ channel, participant: "me" }));
        return !(result.participant instanceof telegram_1.Api.ChannelParticipantLeft);
    }
    catch (err) {
        if (err?.message?.includes("USER_NOT_PARTICIPANT"))
            return false;
        throw err;
    }
}
// Waits for a message carrying inline buttons in a specific chat (e.g. the group we just
// joined). Buttons can arrive on a brand-new message OR via an in-place edit of an
// existing message, so both update paths are watched.
async function waitForButtonsInChat(client, chat, maxMs, signal, minId = 0) {
    const chatPeerId = await client.getPeerId(chat);
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("Job cancelled"));
            return;
        }
        const collected = [];
        const cleanup = () => {
            clearTimeout(timer);
            client.removeEventHandler(handler, new events_1.NewMessage({}));
            client.removeEventHandler(editHandler, new events_1.Raw({}));
            signal?.removeEventListener("abort", onAbort);
        };
        const succeed = (msg) => {
            cleanup();
            if (!collected.includes(msg))
                collected.push(msg);
            resolve(collected);
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`No message with buttons received within ${maxMs}ms`));
        }, maxMs);
        const onAbort = () => {
            cleanup();
            reject(new Error("Job cancelled"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const handler = async (event) => {
            const msg = event.message;
            // Match the chat by id here rather than through NewMessage({ chats }): that filter
            // stringifies an entity object to "[object Object]" and then throws an unhandled
            // rejection while resolving it on the next update -- immediate in a busy group.
            if (!msg.peerId || telegram_1.utils.getPeerId(msg.peerId) !== chatPeerId)
                return;
            collected.push(msg);
            if (hasInlineButtons(msg))
                succeed(msg);
        };
        const editHandler = async (update) => {
            if (!isEditUpdate(update))
                return;
            const msg = update.message;
            if (!msg || msg.out)
                return;
            if (msg.id < minId)
                return; // out of scope (edit of a pre-anchor message)
            if (!msg.peerId || telegram_1.utils.getPeerId(msg.peerId) !== chatPeerId)
                return;
            if (hasInlineButtons(msg))
                succeed(msg);
        };
        client.addEventHandler(handler, new events_1.NewMessage({}));
        client.addEventHandler(editHandler, new events_1.Raw({}));
    });
}
// Waits for the next new message arriving in a specific chat. Never rejects -- resolves null
// on timeout or abort.
async function waitForNewMessageInChat(client, chat, maxMs, signal) {
    // Resolve the chat id up front and match it manually. Passing an entity object into
    // NewMessage({ chats }) breaks GramJS -- its constructor stringifies each filter entry
    // to "[object Object]", then throws an unhandled rejection resolving it on the next update.
    const targetId = await client.getPeerId(chat).catch(() => null);
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(null);
            return;
        }
        const finish = (msg) => {
            clearTimeout(timer);
            client.removeEventHandler(handler, new events_1.NewMessage({}));
            signal?.removeEventListener("abort", onAbort);
            resolve(msg);
        };
        const timer = setTimeout(() => finish(null), maxMs);
        const onAbort = () => finish(null);
        signal?.addEventListener("abort", onAbort, { once: true });
        const handler = async (event) => {
            if (targetId != null &&
                event.message?.chatId?.toString() !== targetId.toString())
                return;
            finish(event.message);
        };
        client.addEventHandler(handler, new events_1.NewMessage({}));
    });
}
// Some groups post an in-group verification message with a button that must be clicked to
// gain real access after joining. Best-effort: waits for that message, clicks the button whose
// text contains buttonMatch (or the sole button), and appends the outcome to step.result.
async function clickGroupVerification(client, chat, buttonMatch, maxMs, step, signal, sinceSec) {
    const findButtonsMsg = (msgs) => [...msgs].reverse().find((m) => hasInlineButtons(m)) ?? null;
    // Waiter catches prompts that arrive (or get edited in) from now on; the scan catches a
    // prompt that landed in the gap before the listener attached. Whichever finds one first wins.
    const waitAbort = new AbortController();
    const forwardAbort = () => waitAbort.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    const waiterPromise = waitForButtonsInChat(client, chat, maxMs, waitAbort.signal)
        .then(findButtonsMsg)
        .catch(() => null);
    const earlyScan = client
        .getMessages(chat, { limit: 10 })
        .then((recent) => recent.find((m) => m &&
        !m.out &&
        hasInlineButtons(m) &&
        (!sinceSec || Math.max(m.editDate ?? 0, m.date ?? 0) >= sinceSec)) ?? null)
        .catch(() => null);
    let buttonsMsg = await Promise.race([
        waiterPromise,
        earlyScan.then((m) => m ?? waiterPromise),
    ]);
    waitAbort.abort();
    signal?.removeEventListener("abort", forwardAbort);
    if (signal?.aborted)
        throw new Error("Job cancelled");
    // Last resort: any recent prompt regardless of age
    if (!buttonsMsg) {
        const recent = (await client.getMessages(chat, { limit: 10 }));
        buttonsMsg = findButtonsMsg(recent);
    }
    if (!buttonsMsg) {
        step.result = `${step.result} (no verification prompt)`;
        return;
    }
    const rows = buttonsMsg.replyMarkup.rows;
    const flat = rows.flatMap((r) => r.buttons);
    const match = buttonMatch.trim();
    let target = match
        ? flat.find((b) => (b.text ?? "").includes(match))
        : undefined;
    // Fall back to the sole button for single-button verifications.
    if (!target && flat.length === 1)
        target = flat[0];
    if (!target) {
        step.result = `${step.result} (verification button not found)`;
        return;
    }
    const data = target.data;
    if (!data) {
        step.result = `${step.result} (verification button not clickable)`;
        return;
    }
    const peer = await client.getInputEntity(chat);
    step.clickedButton = target.text;
    try {
        const answer = (await client.invoke(new telegram_1.Api.messages.GetBotCallbackAnswer({ peer, msgId: buttonsMsg.id, data })));
        if (answer.message)
            step.callbackAnswer = answer.message;
        step.result = `${step.result} + verified`;
    }
    catch (err) {
        // The callback reached the bot but it never answered -- common for verification bots
        // that process the click without calling answerCallbackQuery. The click was delivered,
        // so treat the verification as done rather than failing the whole join.
        if (err?.message?.includes("BOT_RESPONSE_TIMEOUT")) {
            step.result = `${step.result} + verify clicked (no bot confirmation)`;
        }
        else {
            throw err;
        }
    }
}
// Collects messages from the target until one has buttons or timeout fires.
// When successContains/failContains are set, checks message text to resolve or reject early.
// Watches new messages AND in-place edits; when sinceAnchor is given, also scans recent
// history so a reply that landed before the listener attached is not lost.
async function waitForReply(client, fromUsername, maxMs, successContains, failContains, signal, minId = 0) {
    const botPeerId = await client.getPeerId(fromUsername);
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("Job cancelled"));
            return;
        }
        const collected = [];
        const useTextMatch = !!(successContains || failContains);
        let done = false;
        const cleanup = () => {
            done = true;
            clearTimeout(timer);
            client.removeEventHandler(handler, new events_1.NewMessage({}));
            client.removeEventHandler(editHandler, new events_1.Raw({}));
            signal?.removeEventListener("abort", onAbort);
        };
        const timer = setTimeout(() => {
            cleanup();
            if (useTextMatch) {
                reject(new Error(`Expected reply not received within ${maxMs}ms`));
            }
            else if (collected.length > 0) {
                resolve(collected);
            }
            else {
                reject(new Error(`No reply received within ${maxMs}ms`));
            }
        }, maxMs);
        const onAbort = () => {
            cleanup();
            reject(new Error("Job cancelled"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        // Replace an earlier copy on edit, otherwise append
        const upsert = (msg) => {
            const i = collected.findIndex((c) => c.id === msg.id);
            if (i >= 0)
                collected[i] = msg;
            else
                collected.push(msg);
        };
        const consider = (msg) => {
            if (done)
                return;
            upsert(msg);
            const text = msg.message ?? "";
            if (failContains && text.includes(failContains)) {
                cleanup();
                reject(new Error(`Reply indicates failure: "${failContains}" detected`));
                return;
            }
            if (successContains) {
                if (text.includes(successContains)) {
                    cleanup();
                    resolve(collected);
                }
                // Keep waiting for a message that matches the success text
                return;
            }
            // failContains only (no successContains) -- any non-fail message is a success
            if (failContains) {
                cleanup();
                resolve(collected);
                return;
            }
            // No text matching -- original behaviour: resolve immediately on buttons, else rely on timeout
            if (hasInlineButtons(msg)) {
                cleanup();
                resolve(collected);
            }
        };
        const handler = async (event) => consider(event.message);
        const editHandler = async (update) => {
            if (!isEditUpdate(update))
                return;
            const msg = update.message;
            if (!msg || msg.out)
                return;
            if (msg.id < minId)
                return; // out of scope (edit of a pre-anchor message)
            if (!msg.peerId || telegram_1.utils.getPeerId(msg.peerId) !== botPeerId)
                return;
            consider(msg);
        };
        client.addEventHandler(handler, new events_1.NewMessage({ fromUsers: [fromUsername] }));
        client.addEventHandler(editHandler, new events_1.Raw({}));
        // Best-effort: pick up replies delivered in the send-to-listen gap
        if (minId > 1) {
            client
                .getMessages(fromUsername, { limit: 10 })
                .then((recent) => {
                const missed = recent
                    .filter((m) => m &&
                    !m.out &&
                    m.id >= minId &&
                    !collected.some((c) => c.id === m.id))
                    .reverse(); // process oldest first
                for (const m of missed)
                    consider(m);
            })
                .catch(() => {
                /* history scan is best-effort */
            });
        }
    });
}
// Waits specifically for a message with inline buttons from the target. Buttons may show
// up on a brand-new message OR via an in-place edit of an earlier one; when sinceAnchor is
// given, recent history is also scanned to cover the gap before the listeners attached.
// excludeId skips one known message (e.g. the one whose buttons we already tried).
async function waitForButtonsMessage(client, fromUsername, maxMs, signal, minId = 0, excludeId) {
    const botPeerId = await client.getPeerId(fromUsername);
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("Job cancelled"));
            return;
        }
        const collected = [];
        let done = false;
        const cleanup = () => {
            done = true;
            clearTimeout(timer);
            client.removeEventHandler(handler, new events_1.NewMessage({}));
            client.removeEventHandler(editHandler, new events_1.Raw({}));
            signal?.removeEventListener("abort", onAbort);
        };
        const succeed = (msg) => {
            if (done)
                return;
            cleanup();
            if (!collected.some((c) => c.id === msg.id))
                collected.push(msg);
            resolve(collected);
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`No message with buttons received within ${maxMs}ms`));
        }, maxMs);
        const onAbort = () => {
            cleanup();
            reject(new Error("Job cancelled"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        const handler = async (event) => {
            const msg = event.message;
            collected.push(msg);
            if (hasInlineButtons(msg))
                succeed(msg);
        };
        const editHandler = async (update) => {
            if (!isEditUpdate(update))
                return;
            const msg = update.message;
            if (!msg || msg.out)
                return;
            if (msg.id < minId)
                return; // out of scope (edit of a pre-anchor message)
            if (!msg.peerId || telegram_1.utils.getPeerId(msg.peerId) !== botPeerId)
                return;
            if (hasInlineButtons(msg))
                succeed(msg);
        };
        client.addEventHandler(handler, new events_1.NewMessage({ fromUsers: [fromUsername] }));
        client.addEventHandler(editHandler, new events_1.Raw({}));
        // Best-effort: a buttons message may have landed in the send-to-listen gap.
        // getMessages returns newest-first, so this seeds the most recent in-scope
        // match ("last available button").
        if (minId > 1) {
            client
                .getMessages(fromUsername, { limit: 10 })
                .then((recent) => {
                const seed = recent.find((m) => m &&
                    !m.out &&
                    m.id !== excludeId &&
                    m.id >= minId &&
                    hasInlineButtons(m));
                if (seed)
                    succeed(seed);
            })
                .catch(() => {
                /* history scan is best-effort */
            });
        }
    });
}
/**
 * The first step that cannot run without a target bot, or null when the job is fine as it
 * stands. A custom job need not target one: its steps can each name their own contact, or
 * drive a page that never touches Telegram. Checked up front rather than failing later on a
 * peer that cannot be resolved from "".
 *
 * `open_mini_app_url` is deliberately not on the list. It is handed a full address, and one
 * is openable without a bot to sign it -- a `t.me/<bot>/<app>` link names its own bot, an
 * https one may already carry its account data, and an app that signs its own users in
 * needs neither. Naming no bot is the operator saying so; the step opens the address on
 * this account's browser and exit, and says in the log that it went unsigned.
 */
function stepNeedingBot(actions, botUsername) {
    if (botUsername.trim())
        return null;
    const at = actions.findIndex((a) => {
        switch (a.type) {
            // Both need to know whose: one hunts a button in a conversation, the other asks a
            // bot what it pins beside the composer. Neither has anything to work from otherwise.
            case "open_mini_app":
            case "open_bot_menu_app":
                return !a.contact?.trim();
            case "open_mini_app_url":
            case "send_contact_message":
            case "join_group":
            case "subscribe_channel":
            case "open_url":
            case "delay":
                return false;
            default:
                return true;
        }
    });
    return at >= 0 ? { at, type: actions[at].type } : null;
}
async function runCustom(apiId, apiHash, sessionString, botUsername, config, signal, proxy, deviceParams, webProxyUrl, 
// Shared with the runner's outer retries, so an exit refused on an earlier attempt of
// this run is not offered again and an action's browser budget spans its retries
cfRun = (0, cloudflare_1.newCfRunState)()) {
    const log = { steps: [] };
    const jobMaxRetries = config.maxRetries ?? 1;
    const missing = stepNeedingBot(config.actions ?? [], botUsername);
    if (missing) {
        throw new Error(`Step ${missing.at + 1} (${missing.type}) needs a target bot, but this job has none. ` +
            "Set one on the job, or give the step its own contact.");
    }
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 5,
        autoReconnect: false,
        baseLogger: new telegram_1.Logger(Logger_1.LogLevel.NONE),
        ...(proxy ? { proxy } : {}),
        ...(deviceParams ?? {}),
    });
    try {
        await client.connect();
        let lastJobError = null;
        for (let jobAttempt = 1; jobAttempt <= jobMaxRetries; jobAttempt++) {
            if (signal?.aborted)
                throw new Error("Job cancelled");
            // State shared across actions within this job attempt
            let lastMessages = [];
            let lastButtonsMsg = null;
            let sendAnchor = null;
            // Last message we sent to each specific contact, keyed by the trimmed
            // contact handle -- the scope anchor for click_message_button.
            const contactAnchors = new Map();
            let jobAttemptFailed = false;
            for (let i = 0; i < config.actions.length; i++) {
                if (signal?.aborted)
                    throw new Error("Job cancelled");
                const action = config.actions[i];
                const actionMaxRetries = action.type !== "delay" && "maxRetries" in action
                    ? (action.maxRetries ?? 0)
                    : 0;
                let actionSucceeded = false;
                for (let actionAttempt = 1; actionAttempt <= actionMaxRetries + 1 && !actionSucceeded; actionAttempt++) {
                    const step = {
                        step: i + 1,
                        actionType: action.type,
                        label: "",
                        ...(jobMaxRetries > 1 ? { jobAttempt } : {}),
                        ...(actionMaxRetries > 0 ? { actionAttempt } : {}),
                    };
                    log.steps.push(step);
                    const t0 = Date.now();
                    try {
                        switch (action.type) {
                            case "enter_captcha": {
                                const lengthHint = action.captchaLength
                                    ? ` (${action.captchaLength} chars)`
                                    : "";
                                step.label = `Enter captcha${lengthHint}`;
                                let msgs;
                                if (lastMessages.length > 0) {
                                    msgs = lastMessages;
                                }
                                else {
                                    msgs = await waitForReply(client, botUsername, action.maxWaitMs, undefined, undefined, signal, sendAnchor ? sendAnchor.msgId + 1 : 0);
                                    lastMessages = msgs;
                                }
                                const parsed = await (0, checkin_1.parseMessages)(msgs, client, signal);
                                if (parsed.html)
                                    step.preClickHtml = parsed.html;
                                if (parsed.images[0])
                                    step.preClickImage = parsed.images[0];
                                if (parsed.hasMedia)
                                    step.preClickHasMedia = parsed.hasMedia;
                                step.aiPrompt = (0, checkin_1.buildCaptchaPrompt)(action.captchaLength);
                                const aiStart = Date.now();
                                const aiResult = await (0, checkin_1.recognizeCaptchaWithAI)(parsed.images, action.captchaLength)
                                    .then((r) => {
                                    step.aiResponse = r.response;
                                    return r;
                                })
                                    .finally(() => {
                                    step.aiDurationMs = Date.now() - aiStart;
                                });
                                if (action.captchaLength &&
                                    aiResult.text.length !== action.captchaLength) {
                                    throw new Error(`AI returned ${aiResult.text.length} chars ("${aiResult.text}") but expected ${action.captchaLength}`);
                                }
                                const sentCaptcha = await client.sendMessage(botUsername, {
                                    message: aiResult.text,
                                });
                                lastMessages = [];
                                lastButtonsMsg = null;
                                sendAnchor = anchorFromSent(sentCaptcha);
                                step.result = `Sent: "${aiResult.text}"`;
                                break;
                            }
                            case "send_command": {
                                let content = action.content;
                                if ((0, checkin_1.hasAiInput)(content)) {
                                    const length = (0, checkin_1.parseAiInputLength)(content);
                                    const parsed = await (0, checkin_1.parseMessages)(lastMessages, client, signal);
                                    if (parsed.images[0])
                                        step.preClickImage = parsed.images[0];
                                    step.aiPrompt = (0, checkin_1.buildCaptchaPrompt)(length);
                                    const aiStart = Date.now();
                                    const aiResult = await (0, checkin_1.recognizeCaptchaWithAI)(parsed.images, length)
                                        .then((r) => {
                                        step.aiResponse = r.response;
                                        return r;
                                    })
                                        .finally(() => {
                                        step.aiDurationMs = Date.now() - aiStart;
                                    });
                                    if (length && aiResult.text.length !== length) {
                                        throw new Error(`AI returned ${aiResult.text.length} chars ("${aiResult.text}") but expected ${length}`);
                                    }
                                    content = content.replace(/\{aiInput(?::\d+)?\}/, aiResult.text);
                                }
                                const expanded = (0, checkin_1.expandCommand)(content);
                                step.label = `Send: "${expanded}"`;
                                const sentCmd = await client.sendMessage(botUsername, {
                                    message: expanded,
                                });
                                lastMessages = [];
                                lastButtonsMsg = null;
                                sendAnchor = anchorFromSent(sentCmd);
                                step.result = "Sent";
                                break;
                            }
                            case "send_contact_message": {
                                const contact = action.contact.trim();
                                const entity = await (0, peerTarget_1.resolvePeerTarget)(client, contact);
                                let content = action.content;
                                if ((0, checkin_1.hasAiInput)(content)) {
                                    const length = (0, checkin_1.parseAiInputLength)(content);
                                    const parsed = await (0, checkin_1.parseMessages)(lastMessages, client, signal);
                                    if (parsed.images[0])
                                        step.preClickImage = parsed.images[0];
                                    step.aiPrompt = (0, checkin_1.buildCaptchaPrompt)(length);
                                    const aiStart = Date.now();
                                    const aiResult = await (0, checkin_1.recognizeCaptchaWithAI)(parsed.images, length)
                                        .then((r) => {
                                        step.aiResponse = r.response;
                                        return r;
                                    })
                                        .finally(() => {
                                        step.aiDurationMs = Date.now() - aiStart;
                                    });
                                    if (length && aiResult.text.length !== length) {
                                        throw new Error(`AI returned ${aiResult.text.length} chars ("${aiResult.text}") but expected ${length}`);
                                    }
                                    content = content.replace(/\{aiInput(?::\d+)?\}/, aiResult.text);
                                }
                                const expanded = (0, checkin_1.expandCommand)(content);
                                step.label = `Send to ${contact}: "${expanded}"`;
                                const sentContact = await client.sendMessage(entity, {
                                    message: expanded,
                                });
                                contactAnchors.set(contact, anchorFromSent(sentContact));
                                step.result = "Sent";
                                break;
                            }
                            case "wait_reply": {
                                const { successContains, failContains } = action;
                                const hints = [
                                    successContains ? `success: "${successContains}"` : "",
                                    failContains ? `fail: "${failContains}"` : "",
                                ]
                                    .filter(Boolean)
                                    .join(", ");
                                step.label = `Wait reply (max ${action.maxWaitMs}ms)${hints ? ` [${hints}]` : ""}`;
                                const minId = await resolveScopeFloor(client, botUsername, sendAnchor?.msgId ?? 0, action.scope);
                                const msgs = await waitForReply(client, botUsername, action.maxWaitMs, successContains, failContains, signal, minId);
                                lastMessages = msgs;
                                step.msgCount = msgs.length;
                                const btnMsg = [...msgs].reverse().find((m) => hasInlineButtons(m)) ?? null;
                                if (btnMsg)
                                    lastButtonsMsg = btnMsg;
                                const parsed = await (0, checkin_1.parseMessages)(msgs, client, signal);
                                step.responseHtml = parsed.html || undefined;
                                step.responseImage = parsed.images[0];
                                step.responseHasMedia = parsed.hasMedia || undefined;
                                step.responseButtons = parsed.buttons.length
                                    ? parsed.buttons
                                    : undefined;
                                step.result = `Received ${msgs.length} message(s)`;
                                break;
                            }
                            case "delay": {
                                step.label = `Delay ${action.waitMs}ms`;
                                await new Promise((res, rej) => {
                                    if (signal?.aborted) {
                                        rej(new Error("Job cancelled"));
                                        return;
                                    }
                                    const timer = setTimeout(res, action.waitMs);
                                    signal?.addEventListener("abort", () => {
                                        clearTimeout(timer);
                                        rej(new Error("Job cancelled"));
                                    }, { once: true });
                                });
                                step.result = "Done";
                                break;
                            }
                            case "click_button": {
                                step.label = `Click button "${action.button}"`;
                                const minId = await resolveScopeFloor(client, botUsername, sendAnchor?.msgId ?? 0, action.scope);
                                // Ignore a cached buttons message that falls outside the scope
                                // (e.g. a menu from before the command we just sent).
                                let buttonsMsg = lastButtonsMsg && lastButtonsMsg.id >= minId
                                    ? lastButtonsMsg
                                    : null;
                                let preClickImages = [];
                                if (buttonsMsg) {
                                    // The bot may have edited the message since we captured it (swapped or
                                    // added buttons); refresh so we click against the current markup
                                    const currentId = buttonsMsg.id;
                                    const fresh = await client
                                        .getMessages(botUsername, { ids: [currentId] })
                                        .then((r) => r?.[0] ?? null)
                                        .catch(() => null);
                                    if (hasInlineButtons(fresh)) {
                                        buttonsMsg = fresh;
                                        lastButtonsMsg = fresh;
                                    }
                                }
                                if (!buttonsMsg) {
                                    const msgs = await waitForButtonsMessage(client, botUsername, action.maxWaitMs, signal, minId);
                                    lastMessages = msgs;
                                    buttonsMsg =
                                        [...msgs].reverse().find((m) => hasInlineButtons(m)) ??
                                            null;
                                    if (buttonsMsg)
                                        lastButtonsMsg = buttonsMsg;
                                    const preParsed = await (0, checkin_1.parseMessages)(msgs, client, signal);
                                    if (preParsed.html)
                                        step.preClickHtml = preParsed.html;
                                    if (preParsed.images.length) {
                                        step.preClickImage = preParsed.images[0];
                                        preClickImages = preParsed.images;
                                    }
                                    if (preParsed.hasMedia)
                                        step.preClickHasMedia = preParsed.hasMedia;
                                    if (preParsed.buttons.length)
                                        step.preClickButtons = preParsed.buttons;
                                }
                                if (!buttonsMsg)
                                    throw new Error("No message with buttons available");
                                const btnMarkup = buttonsMsg
                                    .replyMarkup;
                                const allBtnRows = btnMarkup.rows;
                                const flat = allBtnRows.flatMap((row) => row.buttons.map((b) => b.text));
                                let targetText;
                                let useExactMatch;
                                if (action.button === "{anyBtn}") {
                                    if (!flat.length)
                                        throw new Error("No buttons available for {anyBtn}");
                                    targetText = flat[Math.floor(Math.random() * flat.length)];
                                    useExactMatch = true;
                                }
                                else if ((0, checkin_1.isAiBtn)(action.button)) {
                                    const buttons = allBtnRows.map((row) => row.buttons.map((b) => b.text));
                                    const hint = (0, checkin_1.parseAiBtnHint)(action.button);
                                    if (!step.preClickHtml && !preClickImages.length) {
                                        const parsed = await (0, checkin_1.parseMessages)([buttonsMsg], client, signal);
                                        if (parsed.html)
                                            step.preClickHtml = parsed.html;
                                        if (parsed.images.length) {
                                            step.preClickImage = parsed.images[0];
                                            preClickImages = parsed.images;
                                        }
                                        if (parsed.hasMedia)
                                            step.preClickHasMedia = parsed.hasMedia;
                                        if (parsed.buttons.length)
                                            step.preClickButtons = parsed.buttons;
                                    }
                                    const aiStart = Date.now();
                                    const aiResult = await (0, checkin_1.selectButtonWithAI)(buttons, step.preClickHtml ?? buttonsMsg.message ?? "", preClickImages, hint, action.maxRetries)
                                        .then((r) => {
                                        step.aiPrompt = r.prompt;
                                        step.aiResponse = r.response;
                                        if (r.retries.length)
                                            step.aiRetries = r.retries;
                                        return r;
                                    })
                                        .finally(() => {
                                        step.aiDurationMs = Date.now() - aiStart;
                                    });
                                    targetText = aiResult.button;
                                    useExactMatch = true;
                                }
                                else {
                                    targetText = action.button;
                                    useExactMatch = false;
                                }
                                const peer = await client.getInputEntity(botUsername);
                                const botPeerId = await client.getPeerId(botUsername);
                                let clicked = false;
                                let retryCount = 0;
                                const markupContainsTarget = (m) => hasInlineButtons(m) &&
                                    m.replyMarkup.rows.some((row) => row.buttons.some((b) => {
                                        const t = (b.text ?? "");
                                        return useExactMatch
                                            ? t === targetText
                                            : t.includes(targetText);
                                    }));
                                for (let attempt = 0; attempt <= action.maxRetries && !clicked; attempt++) {
                                    if (attempt > 0) {
                                        retryCount = attempt;
                                        // Target may have appeared via an in-place edit of the message we
                                        // already have -- refresh it before waiting for a different one
                                        const fresh = await client
                                            .getMessages(botUsername, { ids: [buttonsMsg.id] })
                                            .then((r) => r?.[0] ?? null)
                                            .catch(() => null);
                                        if (hasInlineButtons(fresh)) {
                                            buttonsMsg = fresh;
                                            lastButtonsMsg = fresh;
                                        }
                                        if (!markupContainsTarget(buttonsMsg)) {
                                            const msgs = await waitForButtonsMessage(client, botUsername, action.maxWaitMs, signal, minId, buttonsMsg?.id).catch(() => null);
                                            if (msgs) {
                                                lastMessages = msgs;
                                                const bm = [...msgs]
                                                    .reverse()
                                                    .find((m) => hasInlineButtons(m));
                                                if (bm) {
                                                    buttonsMsg = bm;
                                                    lastButtonsMsg = bm;
                                                }
                                            }
                                        }
                                    }
                                    // The target may already have arrived on an earlier follow-up (e.g.
                                    // a "Verify" prompt sent alongside other messages), so it isn't the
                                    // "current" buttons message. Scan recent history before matching.
                                    if (!markupContainsTarget(buttonsMsg)) {
                                        const recent = (await client
                                            .getMessages(botUsername, { limit: 8 })
                                            .catch(() => []));
                                        const hit = recent.find((m) => markupContainsTarget(m));
                                        if (hit) {
                                            buttonsMsg = hit;
                                            lastButtonsMsg = hit;
                                        }
                                    }
                                    const rows = buttonsMsg.replyMarkup.rows;
                                    for (const row of rows) {
                                        for (const btn of row.buttons) {
                                            const btnText = btn.text;
                                            const matches = useExactMatch
                                                ? btnText === targetText
                                                : btnText.includes(targetText);
                                            if (!matches)
                                                continue;
                                            // A URL button ("我不是机器人") or a Mini App button (FutureEcho's
                                            // "Verify", a "打开小程序签到" app) carries the web address; open it
                                            // in a browser to pass the Cloudflare check.
                                            const web = (0, miniApp_1.webButtonOf)(btn);
                                            if (web) {
                                                const opened = await openWebButton(client, web, botUsername, buttonsMsg, action.cfChallenge, step, webProxyUrl, cfRun);
                                                const cfText = opened.text;
                                                // Following a deep link starts a private chat with that bot;
                                                // re-anchor so a later wait_reply looks past this send
                                                if (opened.deepLinkSent) {
                                                    const { botUsername: linkBot, msg: sentMsg } = opened.deepLinkSent;
                                                    const anchor = anchorFromSent(sentMsg);
                                                    if (linkBot.toLowerCase() === botUsername.replace(/^@/, '').toLowerCase()) {
                                                        sendAnchor = anchor;
                                                    }
                                                    contactAnchors.set(linkBot, anchor);
                                                    contactAnchors.set(`@${linkBot}`, anchor);
                                                }
                                                clicked = true;
                                                step.clickedButton = btnText;
                                                // A deep-link button records its own result inside openWebButton
                                                if (!step.result)
                                                    step.result = `Opened "${btnText}"`;
                                                if (action.failContains && cfText.includes(action.failContains)) {
                                                    throw new Error(`Reply indicates failure: "${action.failContains}" detected`);
                                                }
                                                if (action.successContains && !cfText.includes(action.successContains)) {
                                                    throw new Error(`Expected success indicator "${action.successContains}" not found in response`);
                                                }
                                                break;
                                            }
                                            // Abort controller scoped to this click attempt -- prevents stale listeners
                                            // from interfering with later steps if GetBotCallbackAnswer throws.
                                            const clickAbort = new AbortController();
                                            const forwardAbort = () => clickAbort.abort();
                                            signal?.addEventListener("abort", forwardAbort, {
                                                once: true,
                                            });
                                            const editPromise = (0, checkin_1.waitForBotMessageEdit)(client, buttonsMsg.id, 10000, clickAbort.signal, botPeerId);
                                            const newMsgPromise = (0, checkin_1.waitForNewBotMessage)(client, botUsername, 10000, clickAbort.signal);
                                            const callbackData = btn
                                                .data;
                                            const preClickEditDate = buttonsMsg.editDate;
                                            let answer = null;
                                            let callbackTimedOut = false;
                                            try {
                                                answer = (await client.invoke(new telegram_1.Api.messages.GetBotCallbackAnswer({
                                                    peer,
                                                    msgId: buttonsMsg.id,
                                                    data: callbackData,
                                                })));
                                            }
                                            catch (err) {
                                                // BOT_RESPONSE_TIMEOUT means the click reached the bot but it never
                                                // called answerCallbackQuery -- the action may still have taken effect
                                                // (e.g. the bot edited the message, or acted via a Cloudflare page).
                                                // Fall through and let the edit/new-message watchers below decide.
                                                if (!err?.message?.includes("BOT_RESPONSE_TIMEOUT")) {
                                                    clickAbort.abort();
                                                    signal?.removeEventListener("abort", forwardAbort);
                                                    throw err;
                                                }
                                                callbackTimedOut = true;
                                            }
                                            if (answer?.message)
                                                step.callbackAnswer = answer.message;
                                            clicked = true;
                                            step.retryCount = retryCount;
                                            const taggedEdit = editPromise.then((m) => ({
                                                msg: m,
                                                src: "edit",
                                            }));
                                            const taggedNew = newMsgPromise.then((m) => ({
                                                msg: m,
                                                src: "new_message",
                                            }));
                                            const first = await Promise.race([taggedEdit, taggedNew]);
                                            // Bots often edit the clicked message AND send a follow-up; when the
                                            // first response carries no buttons, give the other source a short
                                            // window -- the next step's buttons are usually there
                                            let second = null;
                                            if (first.msg && !hasInlineButtons(first.msg)) {
                                                const other = first.src === "edit" ? taggedNew : taggedEdit;
                                                second = await Promise.race([
                                                    other,
                                                    new Promise((r) => setTimeout(() => r(null), 1500)),
                                                ]);
                                            }
                                            clickAbort.abort();
                                            signal?.removeEventListener("abort", forwardAbort);
                                            const responses = [first, second].filter((r) => !!r?.msg && !signal?.aborted);
                                            if (responses.length) {
                                                const primary = responses.find((r) => hasInlineButtons(r.msg)) ??
                                                    responses[0];
                                                step.responseSource = primary.src;
                                                lastMessages = responses.map((r) => r.msg);
                                                if (hasInlineButtons(primary.msg))
                                                    lastButtonsMsg = primary.msg;
                                                const parsed = await (0, checkin_1.parseMessages)(lastMessages, client, signal);
                                                step.responseHtml = parsed.html || undefined;
                                                step.responseImage = parsed.images[0];
                                                step.responseHasMedia = parsed.hasMedia || undefined;
                                                step.responseButtons = parsed.buttons.length
                                                    ? parsed.buttons
                                                    : undefined;
                                            }
                                            // A timed-out callback only counts as a failure if the bot never
                                            // reacted. If no edit/new message was seen live, re-fetch the clicked
                                            // message: a changed editDate proves the bot processed the click.
                                            if (callbackTimedOut && !responses.length) {
                                                const fresh = await client
                                                    .getMessages(botUsername, { ids: [buttonsMsg.id] })
                                                    .then((r) => r?.[0] ?? null)
                                                    .catch(() => null);
                                                const freshEditDate = fresh?.editDate;
                                                const wasEdited = !!fresh &&
                                                    !!freshEditDate &&
                                                    freshEditDate !== preClickEditDate;
                                                if (!wasEdited)
                                                    throw new Error(`Button "${btnText}" click timed out (BOT_RESPONSE_TIMEOUT) with no response`);
                                                step.responseSource = "edit";
                                                lastMessages = [fresh];
                                                if (hasInlineButtons(fresh))
                                                    lastButtonsMsg = fresh;
                                                const parsed = await (0, checkin_1.parseMessages)(lastMessages, client, signal);
                                                step.responseHtml = parsed.html || undefined;
                                                step.responseImage = parsed.images[0];
                                                step.responseHasMedia = parsed.hasMedia || undefined;
                                                step.responseButtons = parsed.buttons.length
                                                    ? parsed.buttons
                                                    : undefined;
                                            }
                                            // A URL to open (callback answer or a follow-up "我不是机器人"
                                            // button) completes the checkin only after passing Cloudflare.
                                            let cfText = '';
                                            // Only chase a Cloudflare URL from the response when this action
                                            // opted in; otherwise an incidental URL/WebApp button (e.g. a
                                            // "Verify" the user handles in a later action) must be ignored.
                                            if (action.cfChallenge) {
                                                cfText = await followUpCfText(client, botUsername, answer, responses, step, webProxyUrl, cfRun);
                                            }
                                            // Check success/fail text in callback answer, response, or CF page
                                            if (action.successContains || action.failContains) {
                                                const texts = [answer?.message ?? '', ...responses.map((r) => r.msg.message ?? ''), cfText].filter(Boolean).join('\n');
                                                if (action.failContains && texts.includes(action.failContains)) {
                                                    throw new Error(`Reply indicates failure: "${action.failContains}" detected`);
                                                }
                                                if (action.successContains && !texts.includes(action.successContains)) {
                                                    throw new Error(`Expected success indicator "${action.successContains}" not found in response`);
                                                }
                                            }
                                            step.clickedButton = btnText;
                                            step.result = `Clicked "${btnText}"`;
                                            break;
                                        }
                                        if (clicked)
                                            break;
                                    }
                                }
                                if (!clicked)
                                    throw new Error(`Button "${targetText}" not found after ${action.maxRetries + 1} attempt(s)`);
                                break;
                            }
                            case "click_message_button": {
                                const contact = action.contact.trim();
                                step.label = `Click button "${action.button}" from ${contact}`;
                                const entity = await (0, peerTarget_1.resolvePeerTarget)(client, contact);
                                const peer = await client.getInputEntity(entity);
                                const chatPeerId = await client.getPeerId(entity);
                                const minId = await resolveScopeFloor(client, entity, contactAnchors.get(contact)?.msgId ?? 0, action.scope);
                                const findButtonsMsg = (msgs) => msgs.find((m) => m.id >= minId && hasInlineButtons(m)) ?? null;
                                // Seed from the contact's most recent messages (newest first); otherwise wait
                                // for an incoming message carrying buttons.
                                let buttonsMsg = findButtonsMsg((await client.getMessages(entity, { limit: 10 })));
                                let preClickImages = [];
                                if (!buttonsMsg) {
                                    const msgs = await waitForButtonsInChat(client, entity, action.maxWaitMs, signal, minId);
                                    buttonsMsg =
                                        [...msgs].reverse().find((m) => hasInlineButtons(m)) ??
                                            null;
                                }
                                if (buttonsMsg) {
                                    const preParsed = await (0, checkin_1.parseMessages)([buttonsMsg], client, signal);
                                    if (preParsed.html)
                                        step.preClickHtml = preParsed.html;
                                    if (preParsed.images.length) {
                                        step.preClickImage = preParsed.images[0];
                                        preClickImages = preParsed.images;
                                    }
                                    if (preParsed.hasMedia)
                                        step.preClickHasMedia = preParsed.hasMedia;
                                    if (preParsed.buttons.length)
                                        step.preClickButtons = preParsed.buttons;
                                }
                                if (!buttonsMsg)
                                    throw new Error("No message with buttons available");
                                const btnMarkup = buttonsMsg
                                    .replyMarkup;
                                const allBtnRows = btnMarkup.rows;
                                const flat = allBtnRows.flatMap((row) => row.buttons.map((b) => b.text));
                                let targetText;
                                let useExactMatch;
                                if (action.button === "{anyBtn}") {
                                    if (!flat.length)
                                        throw new Error("No buttons available for {anyBtn}");
                                    targetText = flat[Math.floor(Math.random() * flat.length)];
                                    useExactMatch = true;
                                }
                                else if ((0, checkin_1.isAiBtn)(action.button)) {
                                    const buttons = allBtnRows.map((row) => row.buttons.map((b) => b.text));
                                    const hint = (0, checkin_1.parseAiBtnHint)(action.button);
                                    const aiStart = Date.now();
                                    const aiResult = await (0, checkin_1.selectButtonWithAI)(buttons, step.preClickHtml ?? buttonsMsg.message ?? "", preClickImages, hint, action.maxRetries)
                                        .then((r) => {
                                        step.aiPrompt = r.prompt;
                                        step.aiResponse = r.response;
                                        if (r.retries.length)
                                            step.aiRetries = r.retries;
                                        return r;
                                    })
                                        .finally(() => {
                                        step.aiDurationMs = Date.now() - aiStart;
                                    });
                                    targetText = aiResult.button;
                                    useExactMatch = true;
                                }
                                else {
                                    targetText = action.button;
                                    useExactMatch = false;
                                }
                                let clicked = false;
                                let retryCount = 0;
                                const markupContainsTarget = (m) => hasInlineButtons(m) &&
                                    m.replyMarkup.rows.some((row) => row.buttons.some((b) => {
                                        const t = (b.text ?? "");
                                        return useExactMatch
                                            ? t === targetText
                                            : t.includes(targetText);
                                    }));
                                for (let attempt = 0; attempt <= action.maxRetries && !clicked; attempt++) {
                                    if (attempt > 0) {
                                        retryCount = attempt;
                                        // Target may have appeared via an in-place edit of the message we
                                        // already have -- refresh it before waiting for a different one
                                        const fresh = await client
                                            .getMessages(entity, { ids: [buttonsMsg.id] })
                                            .then((r) => r?.[0] ?? null)
                                            .catch(() => null);
                                        if (hasInlineButtons(fresh))
                                            buttonsMsg = fresh;
                                        if (!markupContainsTarget(buttonsMsg)) {
                                            const msgs = await waitForButtonsInChat(client, entity, action.maxWaitMs, signal, minId).catch(() => null);
                                            if (msgs) {
                                                const bm = [...msgs]
                                                    .reverse()
                                                    .find((m) => hasInlineButtons(m));
                                                if (bm)
                                                    buttonsMsg = bm;
                                            }
                                        }
                                    }
                                    // The target may already have arrived on an earlier follow-up, so it
                                    // isn't the "current" buttons message. Scan recent chat history.
                                    if (!markupContainsTarget(buttonsMsg)) {
                                        const recent = (await client
                                            .getMessages(entity, { limit: 8 })
                                            .catch(() => []));
                                        const hit = recent.find((m) => markupContainsTarget(m));
                                        if (hit)
                                            buttonsMsg = hit;
                                    }
                                    const rows = buttonsMsg.replyMarkup.rows;
                                    for (const row of rows) {
                                        for (const btn of row.buttons) {
                                            const btnText = btn.text;
                                            const matches = useExactMatch
                                                ? btnText === targetText
                                                : btnText.includes(targetText);
                                            if (!matches)
                                                continue;
                                            // A URL button ("我不是机器人") or a Mini App button (FutureEcho's
                                            // "Verify", a "打开小程序签到" app) carries the web address; open it
                                            // in a browser to pass the Cloudflare check.
                                            const web = (0, miniApp_1.webButtonOf)(btn);
                                            if (web) {
                                                const opened = await openWebButton(client, web, entity, buttonsMsg, action.cfChallenge, step, webProxyUrl, cfRun);
                                                const cfText = opened.text;
                                                // Following a deep link starts a private chat with that bot;
                                                // re-anchor so a later wait_reply looks past this send
                                                if (opened.deepLinkSent) {
                                                    const { botUsername: linkBot, msg: sentMsg } = opened.deepLinkSent;
                                                    const anchor = anchorFromSent(sentMsg);
                                                    if (linkBot.toLowerCase() === botUsername.replace(/^@/, '').toLowerCase()) {
                                                        sendAnchor = anchor;
                                                    }
                                                    contactAnchors.set(linkBot, anchor);
                                                    contactAnchors.set(`@${linkBot}`, anchor);
                                                }
                                                clicked = true;
                                                step.clickedButton = btnText;
                                                // A deep-link button records its own result inside openWebButton
                                                if (!step.result)
                                                    step.result = `Opened "${btnText}"`;
                                                if (action.failContains && cfText.includes(action.failContains)) {
                                                    throw new Error(`Reply indicates failure: "${action.failContains}" detected`);
                                                }
                                                if (action.successContains && !cfText.includes(action.successContains)) {
                                                    throw new Error(`Expected success indicator "${action.successContains}" not found in response`);
                                                }
                                                break;
                                            }
                                            const clickAbort = new AbortController();
                                            const forwardAbort = () => clickAbort.abort();
                                            signal?.addEventListener("abort", forwardAbort, {
                                                once: true,
                                            });
                                            const editPromise = (0, checkin_1.waitForBotMessageEdit)(client, buttonsMsg.id, 10000, clickAbort.signal, chatPeerId);
                                            const newMsgPromise = waitForNewMessageInChat(client, entity, 10000, clickAbort.signal);
                                            const callbackData = btn
                                                .data;
                                            const preClickEditDate = buttonsMsg.editDate;
                                            let answer = null;
                                            let callbackTimedOut = false;
                                            try {
                                                answer = (await client.invoke(new telegram_1.Api.messages.GetBotCallbackAnswer({
                                                    peer,
                                                    msgId: buttonsMsg.id,
                                                    data: callbackData,
                                                })));
                                            }
                                            catch (err) {
                                                // BOT_RESPONSE_TIMEOUT means the click reached the bot but it never
                                                // called answerCallbackQuery -- the action may still have taken effect
                                                // (e.g. the bot edited the message, or acted via a Cloudflare page).
                                                // Fall through and let the edit/new-message watchers below decide.
                                                if (!err?.message?.includes("BOT_RESPONSE_TIMEOUT")) {
                                                    clickAbort.abort();
                                                    signal?.removeEventListener("abort", forwardAbort);
                                                    throw err;
                                                }
                                                callbackTimedOut = true;
                                            }
                                            if (answer?.message)
                                                step.callbackAnswer = answer.message;
                                            clicked = true;
                                            step.retryCount = retryCount;
                                            const taggedEdit = editPromise.then((m) => ({
                                                msg: m,
                                                src: "edit",
                                            }));
                                            const taggedNew = newMsgPromise.then((m) => ({
                                                msg: m,
                                                src: "new_message",
                                            }));
                                            const first = await Promise.race([taggedEdit, taggedNew]);
                                            // When the first response carries no buttons, give the other source
                                            // a short window in case it delivers the next step's buttons
                                            let second = null;
                                            if (first.msg && !hasInlineButtons(first.msg)) {
                                                const other = first.src === "edit" ? taggedNew : taggedEdit;
                                                second = await Promise.race([
                                                    other,
                                                    new Promise((r) => setTimeout(() => r(null), 1500)),
                                                ]);
                                            }
                                            clickAbort.abort();
                                            signal?.removeEventListener("abort", forwardAbort);
                                            const responses = [first, second].filter((r) => !!r?.msg && !signal?.aborted);
                                            if (responses.length) {
                                                const primary = responses.find((r) => hasInlineButtons(r.msg)) ??
                                                    responses[0];
                                                step.responseSource = primary.src;
                                                const parsed = await (0, checkin_1.parseMessages)(responses.map((r) => r.msg), client, signal);
                                                step.responseHtml = parsed.html || undefined;
                                                step.responseImage = parsed.images[0];
                                                step.responseHasMedia = parsed.hasMedia || undefined;
                                                step.responseButtons = parsed.buttons.length
                                                    ? parsed.buttons
                                                    : undefined;
                                            }
                                            // A timed-out callback only counts as a failure if the bot never
                                            // reacted. If no edit/new message was seen live, re-fetch the clicked
                                            // message: a changed editDate proves the bot processed the click.
                                            if (callbackTimedOut && !responses.length) {
                                                const fresh = await client
                                                    .getMessages(entity, { ids: [buttonsMsg.id] })
                                                    .then((r) => r?.[0] ?? null)
                                                    .catch(() => null);
                                                const freshEditDate = fresh?.editDate;
                                                const wasEdited = !!fresh &&
                                                    !!freshEditDate &&
                                                    freshEditDate !== preClickEditDate;
                                                if (!wasEdited)
                                                    throw new Error(`Button "${btnText}" click timed out (BOT_RESPONSE_TIMEOUT) with no response`);
                                                step.responseSource = "edit";
                                                const parsed = await (0, checkin_1.parseMessages)([fresh], client, signal);
                                                step.responseHtml = parsed.html || undefined;
                                                step.responseImage = parsed.images[0];
                                                step.responseHasMedia = parsed.hasMedia || undefined;
                                                step.responseButtons = parsed.buttons.length
                                                    ? parsed.buttons
                                                    : undefined;
                                            }
                                            // A URL to open (callback answer or a follow-up "我不是机器人"
                                            // button) completes the checkin only after passing Cloudflare.
                                            let cfText = '';
                                            // Only chase a Cloudflare URL from the response when this action
                                            // opted in; otherwise an incidental URL/WebApp button (e.g. a
                                            // "Verify" the user handles in a later action) must be ignored.
                                            if (action.cfChallenge) {
                                                cfText = await followUpCfText(client, entity, answer, responses, step, webProxyUrl, cfRun);
                                            }
                                            if (action.successContains || action.failContains) {
                                                const texts = [answer?.message ?? '', ...responses.map((r) => r.msg.message ?? ''), cfText].filter(Boolean).join('\n');
                                                if (action.failContains && texts.includes(action.failContains)) {
                                                    throw new Error(`Reply indicates failure: "${action.failContains}" detected`);
                                                }
                                                if (action.successContains && !texts.includes(action.successContains)) {
                                                    throw new Error(`Expected success indicator "${action.successContains}" not found in response`);
                                                }
                                            }
                                            step.clickedButton = btnText;
                                            step.result = `Clicked "${btnText}"`;
                                            break;
                                        }
                                        if (clicked)
                                            break;
                                    }
                                }
                                if (!clicked)
                                    throw new Error(`Button "${targetText}" not found after ${action.maxRetries + 1} attempt(s)`);
                                break;
                            }
                            case "ai_multiple_btn": {
                                const contact = action.contact?.trim() ?? "";
                                const botMode = contact.length === 0;
                                step.label = botMode
                                    ? "AI multi-click buttons"
                                    : `AI multi-click buttons from ${contact}`;
                                // Chat context: the job's bot by default, otherwise a named contact.
                                const target = botMode
                                    ? botUsername
                                    : await (0, peerTarget_1.resolvePeerTarget)(client, contact);
                                const peer = await client.getInputEntity(target);
                                const editPeerId = await client.getPeerId(target);
                                const anchor = botMode
                                    ? sendAnchor
                                    : (contactAnchors.get(contact) ?? null);
                                const minId = await resolveScopeFloor(client, target, anchor?.msgId ?? 0, action.scope);
                                const refetch = (id) => client
                                    .getMessages(target, { ids: [id] })
                                    .then((r) => r?.[0] ?? null)
                                    .catch(() => null);
                                const waitButtons = (excludeId) => botMode
                                    ? waitForButtonsMessage(client, botUsername, action.maxWaitMs, signal, minId, excludeId)
                                    : waitForButtonsInChat(client, target, action.maxWaitMs, signal, minId);
                                const waitNewMsg = (timeoutMs) => botMode
                                    ? (0, checkin_1.waitForNewBotMessage)(client, botUsername, timeoutMs, signal)
                                    : waitForNewMessageInChat(client, target, timeoutMs, signal);
                                // ── Obtain the message carrying the buttons ──
                                let buttonsMsg = null;
                                let preClickImages = [];
                                if (botMode) {
                                    buttonsMsg =
                                        lastButtonsMsg && lastButtonsMsg.id >= minId
                                            ? lastButtonsMsg
                                            : null;
                                    if (buttonsMsg) {
                                        const fresh = await refetch(buttonsMsg.id);
                                        if (hasInlineButtons(fresh)) {
                                            buttonsMsg = fresh;
                                            lastButtonsMsg = fresh;
                                        }
                                    }
                                }
                                else {
                                    const recent = (await client.getMessages(target, {
                                        limit: 10,
                                    }));
                                    buttonsMsg =
                                        recent.find((m) => m.id >= minId && hasInlineButtons(m)) ??
                                            null;
                                }
                                if (!buttonsMsg) {
                                    const msgs = await waitButtons();
                                    if (botMode)
                                        lastMessages = msgs;
                                    buttonsMsg =
                                        [...msgs].reverse().find((m) => hasInlineButtons(m)) ?? null;
                                    if (buttonsMsg && botMode)
                                        lastButtonsMsg = buttonsMsg;
                                }
                                if (!buttonsMsg)
                                    throw new Error("No message with buttons available");
                                const preParsed = await (0, checkin_1.parseMessages)([buttonsMsg], client, signal);
                                if (preParsed.html)
                                    step.preClickHtml = preParsed.html;
                                if (preParsed.images.length) {
                                    step.preClickImage = preParsed.images[0];
                                    preClickImages = preParsed.images;
                                }
                                if (preParsed.hasMedia)
                                    step.preClickHasMedia = preParsed.hasMedia;
                                if (preParsed.buttons.length)
                                    step.preClickButtons = preParsed.buttons;
                                // ── AI picks the ordered list of buttons to click ──
                                const buttonRows = buttonsMsg.replyMarkup.rows.map((row) => row.buttons.map((b) => b.text));
                                const aiStart = Date.now();
                                const aiResult = await (0, checkin_1.selectMultipleButtonsWithAI)(buttonRows, step.preClickHtml ?? buttonsMsg.message ?? "", preClickImages, action.hint, action.maxRetries)
                                    .then((r) => {
                                    step.aiPrompt = r.prompt;
                                    step.aiResponse = r.response;
                                    if (r.retries.length)
                                        step.aiRetries = r.retries;
                                    return r;
                                })
                                    .finally(() => {
                                    step.aiDurationMs = Date.now() - aiStart;
                                });
                                // Clicks one button by exact text against the current message, refreshing the
                                // markup on retry, and advances buttonsMsg to the reply so the next click sees
                                // the updated markup. Throws if the button never clicks (aborts the action).
                                const clickTarget = async (targetText) => {
                                    let clicked = false;
                                    let retryCount = 0;
                                    let clickedText = "";
                                    let responseText = "";
                                    const markupHasTarget = (m) => hasInlineButtons(m) &&
                                        m.replyMarkup.rows.some((row) => row.buttons.some((b) => (b.text ?? "") === targetText));
                                    for (let attempt = 0; attempt <= action.maxRetries && !clicked; attempt++) {
                                        if (attempt > 0) {
                                            retryCount = attempt;
                                            const fresh = await refetch(buttonsMsg.id);
                                            if (hasInlineButtons(fresh)) {
                                                buttonsMsg = fresh;
                                                if (botMode)
                                                    lastButtonsMsg = fresh;
                                            }
                                            if (!markupHasTarget(buttonsMsg)) {
                                                const msgs = await waitButtons(buttonsMsg?.id).catch(() => null);
                                                if (msgs) {
                                                    if (botMode)
                                                        lastMessages = msgs;
                                                    const bm = [...msgs]
                                                        .reverse()
                                                        .find((m) => hasInlineButtons(m));
                                                    if (bm) {
                                                        buttonsMsg = bm;
                                                        if (botMode)
                                                            lastButtonsMsg = bm;
                                                    }
                                                }
                                            }
                                        }
                                        const rows = buttonsMsg.replyMarkup.rows;
                                        for (const row of rows) {
                                            for (const btn of row.buttons) {
                                                const btnText = btn.text;
                                                if (btnText !== targetText)
                                                    continue;
                                                const clickAbort = new AbortController();
                                                const forwardAbort = () => clickAbort.abort();
                                                signal?.addEventListener("abort", forwardAbort, {
                                                    once: true,
                                                });
                                                const editPromise = (0, checkin_1.waitForBotMessageEdit)(client, buttonsMsg.id, 10000, clickAbort.signal, editPeerId);
                                                const newMsgPromise = waitNewMsg(10000);
                                                const callbackData = btn
                                                    .data;
                                                const preClickEditDate = buttonsMsg.editDate;
                                                let answer = null;
                                                let callbackTimedOut = false;
                                                try {
                                                    answer = (await client.invoke(new telegram_1.Api.messages.GetBotCallbackAnswer({
                                                        peer,
                                                        msgId: buttonsMsg.id,
                                                        data: callbackData,
                                                    })));
                                                }
                                                catch (err) {
                                                    if (!err?.message?.includes("BOT_RESPONSE_TIMEOUT")) {
                                                        clickAbort.abort();
                                                        signal?.removeEventListener("abort", forwardAbort);
                                                        throw err;
                                                    }
                                                    callbackTimedOut = true;
                                                }
                                                if (answer?.message)
                                                    step.callbackAnswer = answer.message;
                                                clicked = true;
                                                step.retryCount = retryCount;
                                                const taggedEdit = editPromise.then((m) => ({
                                                    msg: m,
                                                    src: "edit",
                                                }));
                                                const taggedNew = newMsgPromise.then((m) => ({
                                                    msg: m,
                                                    src: "new_message",
                                                }));
                                                const first = await Promise.race([
                                                    taggedEdit,
                                                    taggedNew,
                                                ]);
                                                let second = null;
                                                if (first.msg && !hasInlineButtons(first.msg)) {
                                                    const other = first.src === "edit" ? taggedNew : taggedEdit;
                                                    second = await Promise.race([
                                                        other,
                                                        new Promise((r) => setTimeout(() => r(null), 1500)),
                                                    ]);
                                                }
                                                clickAbort.abort();
                                                signal?.removeEventListener("abort", forwardAbort);
                                                const responses = [first, second].filter((r) => !!r?.msg && !signal?.aborted);
                                                if (responses.length) {
                                                    const primary = responses.find((r) => hasInlineButtons(r.msg)) ??
                                                        responses[0];
                                                    step.responseSource = primary.src;
                                                    if (hasInlineButtons(primary.msg)) {
                                                        buttonsMsg = primary.msg;
                                                        if (botMode)
                                                            lastButtonsMsg = primary.msg;
                                                    }
                                                    if (botMode)
                                                        lastMessages = responses.map((r) => r.msg);
                                                    const parsed = await (0, checkin_1.parseMessages)(responses.map((r) => r.msg), client, signal);
                                                    step.responseHtml = parsed.html || undefined;
                                                    step.responseImage = parsed.images[0];
                                                    step.responseHasMedia = parsed.hasMedia || undefined;
                                                    step.responseButtons = parsed.buttons.length
                                                        ? parsed.buttons
                                                        : undefined;
                                                }
                                                if (callbackTimedOut && !responses.length) {
                                                    const fresh = await refetch(buttonsMsg.id);
                                                    const freshEditDate = fresh?.editDate;
                                                    const wasEdited = !!fresh &&
                                                        !!freshEditDate &&
                                                        freshEditDate !== preClickEditDate;
                                                    if (!wasEdited)
                                                        throw new Error(`Button "${btnText}" click timed out (BOT_RESPONSE_TIMEOUT) with no response`);
                                                    step.responseSource = "edit";
                                                    if (hasInlineButtons(fresh)) {
                                                        buttonsMsg = fresh;
                                                        if (botMode)
                                                            lastButtonsMsg = fresh;
                                                    }
                                                    if (botMode)
                                                        lastMessages = [fresh];
                                                    const parsed = await (0, checkin_1.parseMessages)([fresh], client, signal);
                                                    step.responseHtml = parsed.html || undefined;
                                                    step.responseImage = parsed.images[0];
                                                    step.responseHasMedia = parsed.hasMedia || undefined;
                                                    step.responseButtons = parsed.buttons.length
                                                        ? parsed.buttons
                                                        : undefined;
                                                }
                                                // Success/fail text is judged by the caller: the success indicator
                                                // typically only appears after the whole sequence is clicked.
                                                responseText = [
                                                    answer?.message ?? "",
                                                    ...responses.map((r) => r.msg.message ?? ""),
                                                ]
                                                    .filter(Boolean)
                                                    .join("\n");
                                                clickedText = btnText;
                                                step.clickedButton = btnText;
                                                break;
                                            }
                                            if (clicked)
                                                break;
                                        }
                                    }
                                    if (!clicked)
                                        throw new Error(`Button "${targetText}" not found after ${action.maxRetries + 1} attempt(s)`);
                                    return { clickedText, responseText };
                                };
                                // ── Click each selected button in order, gap between clicks ──
                                const clickedButtons = [];
                                step.clickedButtons = clickedButtons;
                                for (let k = 0; k < aiResult.buttons.length; k++) {
                                    if (k > 0 && action.gapMs > 0) {
                                        await new Promise((res, rej) => {
                                            if (signal?.aborted) {
                                                rej(new Error("Job cancelled"));
                                                return;
                                            }
                                            const timer = setTimeout(res, action.gapMs);
                                            signal?.addEventListener("abort", () => {
                                                clearTimeout(timer);
                                                rej(new Error("Job cancelled"));
                                            }, { once: true });
                                        });
                                    }
                                    const { clickedText, responseText } = await clickTarget(aiResult.buttons[k]);
                                    clickedButtons.push(clickedText);
                                    // failContains aborts as soon as any reply signals failure; successContains
                                    // is only required on the final reply, since bots usually confirm success
                                    // once the whole sequence is done.
                                    if (action.failContains &&
                                        responseText.includes(action.failContains)) {
                                        throw new Error(`Reply indicates failure: "${action.failContains}" detected`);
                                    }
                                    const isLast = k === aiResult.buttons.length - 1;
                                    if (isLast &&
                                        action.successContains &&
                                        !responseText.includes(action.successContains)) {
                                        throw new Error(`Expected success indicator "${action.successContains}" not found in response`);
                                    }
                                }
                                step.result = `Clicked ${clickedButtons.length} button(s): ${clickedButtons
                                    .map((b) => `"${b}"`)
                                    .join(", ")}`;
                                break;
                            }
                            case "join_group": {
                                const raw = action.groupId.trim();
                                step.label = `Join group: ${raw}`;
                                // Detect invite link: https://t.me/+HASH or https://t.me/joinchat/HASH
                                const inviteMatch = raw.match(/(?:t\.me\/(?:joinchat\/|\+))([A-Za-z0-9_-]+)/);
                                if (inviteMatch) {
                                    const hash = inviteMatch[1];
                                    if (action.checkMembership) {
                                        // CheckChatInvite returns ChatInviteAlready when the user is already a member
                                        const check = await client.invoke(new telegram_1.Api.messages.CheckChatInvite({ hash }));
                                        if (check instanceof telegram_1.Api.ChatInviteAlready || check instanceof telegram_1.Api.ChatInvitePeek) {
                                            step.result = "Already a member (verified)";
                                            break;
                                        }
                                    }
                                    let pendingApproval = false;
                                    try {
                                        await client.invoke(new telegram_1.Api.messages.ImportChatInvite({ hash }));
                                        step.result = "Joined via invite link";
                                    }
                                    catch (err) {
                                        if (err?.message?.includes("ALREADY_PARTICIPANT")) {
                                            step.result = "Already a member";
                                        }
                                        else if (err?.message?.includes("INVITE_REQUEST_SENT")) {
                                            step.result = "Join request sent (pending approval)";
                                            pendingApproval = true;
                                        }
                                        else {
                                            throw err;
                                        }
                                    }
                                    if (action.checkMembership && !pendingApproval) {
                                        const check = await client.invoke(new telegram_1.Api.messages.CheckChatInvite({ hash }));
                                        if (!(check instanceof telegram_1.Api.ChatInviteAlready || check instanceof telegram_1.Api.ChatInvitePeek)) {
                                            step.result = "Join request sent (pending approval)";
                                            pendingApproval = true;
                                        }
                                    }
                                    if (pendingApproval && action.checkMembership)
                                        throw new Error("Join not confirmed: request is still pending approval");
                                }
                                else {
                                    // A username, or an ID naming a group the account is already in
                                    const entity = await (0, peerTarget_1.resolvePeerTarget)(client, raw);
                                    if (action.checkMembership && entity instanceof telegram_1.Api.Channel) {
                                        if (await isChannelMember(client, entity)) {
                                            step.result = "Already a member (verified)";
                                            break;
                                        }
                                    }
                                    // A basic group cannot be joined by ID or name; being in the chat list is
                                    // the only way one was reachable in the first place
                                    if (entity instanceof telegram_1.Api.Chat) {
                                        step.result = "Already a member";
                                        break;
                                    }
                                    let pendingApproval = false;
                                    let freshlyJoined = false;
                                    // Small tolerance for clock skew against Telegram server time
                                    const joinStartSec = Math.floor(Date.now() / 1000) - 10;
                                    try {
                                        await client.invoke(new telegram_1.Api.channels.JoinChannel({ channel: entity }));
                                        step.result = "Joined";
                                        freshlyJoined = true;
                                    }
                                    catch (err) {
                                        if (err?.message?.includes("ALREADY_PARTICIPANT")) {
                                            step.result = "Already a member";
                                        }
                                        else if (err?.message?.includes("INVITE_REQUEST_SENT")) {
                                            step.result = "Join request sent (pending approval)";
                                            pendingApproval = true;
                                        }
                                        else {
                                            throw err;
                                        }
                                    }
                                    if (action.checkMembership && !pendingApproval && entity instanceof telegram_1.Api.Channel) {
                                        if (!(await isChannelMember(client, entity))) {
                                            step.result = "Join request sent (pending approval)";
                                            pendingApproval = true;
                                        }
                                    }
                                    if (pendingApproval && action.checkMembership)
                                        throw new Error("Join not confirmed: request is still pending approval");
                                    // Only wait for the in-group verification prompt on a genuine fresh join --
                                    // an already-joined account won't get a new prompt, so don't stall on it.
                                    if (action.verifyButton && freshlyJoined && entity instanceof telegram_1.Api.Channel) {
                                        await clickGroupVerification(client, entity, action.verifyButton, action.verifyWaitMs ?? 30000, step, signal, joinStartSec);
                                    }
                                }
                                break;
                            }
                            case "subscribe_channel": {
                                const raw = action.channelId.trim();
                                step.label = `Subscribe to channel: ${raw}`;
                                // Detect invite link: https://t.me/+HASH or https://t.me/joinchat/HASH
                                const inviteMatch = raw.match(/(?:t\.me\/(?:joinchat\/|\+))([A-Za-z0-9_-]+)/);
                                if (inviteMatch) {
                                    const hash = inviteMatch[1];
                                    if (action.checkMembership) {
                                        // CheckChatInvite returns ChatInviteAlready when the user is already subscribed
                                        const check = await client.invoke(new telegram_1.Api.messages.CheckChatInvite({ hash }));
                                        if (check instanceof telegram_1.Api.ChatInviteAlready || check instanceof telegram_1.Api.ChatInvitePeek) {
                                            step.result = "Already subscribed (verified)";
                                            break;
                                        }
                                    }
                                    let pendingApproval = false;
                                    try {
                                        await client.invoke(new telegram_1.Api.messages.ImportChatInvite({ hash }));
                                        step.result = "Subscribed via invite link";
                                    }
                                    catch (err) {
                                        if (err?.message?.includes("ALREADY_PARTICIPANT")) {
                                            step.result = "Already subscribed";
                                        }
                                        else if (err?.message?.includes("INVITE_REQUEST_SENT")) {
                                            step.result = "Join request sent (pending approval)";
                                            pendingApproval = true;
                                        }
                                        else {
                                            throw err;
                                        }
                                    }
                                    if (action.checkMembership && !pendingApproval) {
                                        const check = await client.invoke(new telegram_1.Api.messages.CheckChatInvite({ hash }));
                                        if (!(check instanceof telegram_1.Api.ChatInviteAlready || check instanceof telegram_1.Api.ChatInvitePeek)) {
                                            step.result = "Join request sent (pending approval)";
                                            pendingApproval = true;
                                        }
                                    }
                                    if (pendingApproval && action.checkMembership)
                                        throw new Error("Subscription not confirmed: request is still pending approval");
                                }
                                else {
                                    // A username, or an ID naming a channel the account is already in
                                    const entity = await (0, peerTarget_1.resolvePeerTarget)(client, raw);
                                    if (action.checkMembership && entity instanceof telegram_1.Api.Channel) {
                                        if (await isChannelMember(client, entity)) {
                                            step.result = "Already subscribed (verified)";
                                            break;
                                        }
                                    }
                                    let pendingApproval = false;
                                    try {
                                        await client.invoke(new telegram_1.Api.channels.JoinChannel({ channel: entity }));
                                        step.result = "Subscribed";
                                    }
                                    catch (err) {
                                        if (err?.message?.includes("ALREADY_PARTICIPANT")) {
                                            step.result = "Already subscribed";
                                        }
                                        else if (err?.message?.includes("INVITE_REQUEST_SENT")) {
                                            step.result = "Join request sent (pending approval)";
                                            pendingApproval = true;
                                        }
                                        else {
                                            throw err;
                                        }
                                    }
                                    if (action.checkMembership && !pendingApproval && entity instanceof telegram_1.Api.Channel) {
                                        if (!(await isChannelMember(client, entity))) {
                                            step.result = "Join request sent (pending approval)";
                                            pendingApproval = true;
                                        }
                                    }
                                    if (pendingApproval && action.checkMembership)
                                        throw new Error("Subscription not confirmed: request is still pending approval");
                                }
                                break;
                            }
                            case "open_mini_app": {
                                const target = action.contact?.trim() || botUsername;
                                const wantBtn = action.button?.trim();
                                step.label = `Open Mini App${wantBtn ? ` "${wantBtn}"` : ""} from ${target}`;
                                // Pass `target` through rather than pre-resolving it: GramJS resolves
                                // and caches the peer itself, and the extra ResolveUsername round-trip
                                // is what tends to time out here.
                                const msgs = (await client.getMessages(target, { limit: 10 }));
                                let hit;
                                for (const m of msgs) {
                                    const web = (0, checkin_1.findUrlButton)(m, wantBtn);
                                    if (web?.miniApp) {
                                        hit = { web, msg: m };
                                        break;
                                    }
                                }
                                if (!hit) {
                                    throw new Error(`No Mini App button${wantBtn ? ` matching "${wantBtn}"` : ""} in the last 10 messages from ${target}`);
                                }
                                step.clickedButton = hit.web.text;
                                const { url, signed } = await (0, miniApp_1.openableButtonUrl)(client, hit.web, target, hit.msg);
                                step.cfMiniApp = true;
                                step.cfMiniAppSigned = signed;
                                if (!signed) {
                                    throw new Error(`Telegram would not sign the Mini App behind "${hit.web.text}"; it cannot be opened logged in`);
                                }
                                const cfHost = (() => {
                                    try {
                                        return new URL(url).host;
                                    }
                                    catch {
                                        return "";
                                    }
                                })();
                                // The budget covers this action's whole browser life, retries included
                                const tune = (0, cfTuning_1.cfTuning)();
                                const budgetMs = action.maxWaitMs && action.maxWaitMs > 0 ? action.maxWaitMs : tune.budgetMs;
                                const budgetKey = `mini:${i}`;
                                const actionDeadline = cfRun.deadlines.get(budgetKey) ?? Date.now() + budgetMs;
                                cfRun.deadlines.set(budgetKey, actionDeadline);
                                const budgetLeft = actionDeadline - Date.now();
                                if (budgetLeft < tune.minActionMs) {
                                    throw new Error(`Browser time for this action is spent (${Math.round(budgetMs / 1000)}s budget)`);
                                }
                                const refused = (0, cloudflare_1.cfRefusedFor)(cfRun, cfHost);
                                const candidates = (0, proxyProviders_1.cfProxyCandidatesFor)({
                                    primaryUrl: webProxyUrl,
                                    host: cfHost,
                                    proxyId: action.proxyId,
                                    tryAll: action.tryAllProxies ?? true,
                                    // An exit that was already refused this run is not offered again, so a
                                    // retry moves further into the pool instead of replaying the same few
                                    exclude: refused,
                                    max: action.tryAllProxies === false ? 1 : (0, proxyProviders_1.cfMaxCandidates)(),
                                });
                                if (!candidates.length) {
                                    throw new Error((0, cloudflare_1.cfNoCandidatesMessage)(cfRun, cfHost));
                                }
                                const cf = await (0, cloudflare_1.loadCheckinUrl)(url, webProxyUrl, {
                                    miniApp: true,
                                    inAppClicks: (action.appButtons ?? []).map((b) => b.trim()).filter(Boolean),
                                    maxWaitMs: budgetLeft,
                                    // The browser side is invisible from here, so keep what it saw
                                    screenshot: true,
                                    solveQuestion: async (question) => {
                                        const prompt = `A Telegram Mini App is asking a verification question before it will ` +
                                            `complete a checkin. The screen reads:\n\n${question}\n\n` +
                                            `Reply with ONLY the answer to type into the input, nothing else.`;
                                        const { response } = await (0, checkin_1.callAI)([], prompt, 512);
                                        step.aiPrompt = prompt;
                                        step.aiResponse = response;
                                        return response;
                                    },
                                    // Backs the {aiBtn} in-app step: the model is shown the marked-up app
                                    // page and names the control to press
                                    aiLocate: async (image, prompt) => {
                                        const { response } = await (0, checkin_1.callAI)([image], prompt, 512);
                                        step.aiPrompt = prompt;
                                        step.aiResponse = response;
                                        return response;
                                    },
                                    // Cloudflare judges the exit IP too, so the action can pin an exit of
                                    // its own and decide whether the rest of the pool stands by
                                    proxyCandidates: candidates,
                                    // Init data ages, so each attempt gets a freshly signed URL
                                    refreshUrl: async () => (await (0, miniApp_1.openableButtonUrl)(client, hit.web, target, hit.msg)).url,
                                });
                                step.cfHost = cf.finalHost;
                                step.cfChallenged = cf.challenged;
                                step.cfPassed = cf.ok;
                                step.cfMiniAppAction = cf.inAppAction;
                                step.cfProxy = cf.proxyLabel;
                                step.cfBuild = cf.browserTier;
                                step.cfAttempts = cf.attempts;
                                step.cfPageTitle = cf.pageTitle;
                                step.cfNavError = cf.navError;
                                step.cfTrace = cf.trace;
                                step.cfScreenshot = cf.screenshot;
                                for (const id of cf.refusedProxyIds ?? [])
                                    refused.add(id);
                                if (!cf.ok)
                                    (0, cloudflare_1.cfNoteFailure)(cfRun, cf.finalHost, cf.reason);
                                if (cf.ok && cf.proxyId)
                                    (0, proxyProviders_1.rememberCfProxy)(cf.finalHost, cf.proxyId);
                                step.responseHtml = (0, htmlEscape_1.escapeHtml)(cf.text.slice(0, 2000)).replace(/\n/g, "<br>");
                                if (!cf.ok) {
                                    throw new Error(cf.reason ?? (0, cloudflare_1.cfFailureFallback)(cf.challenged, true));
                                }
                                step.result = cf.inAppAction
                                    ? `Opened "${hit.web.text}", pressed "${cf.inAppAction}"`
                                    : `Opened "${hit.web.text}" (nothing pressed inside the app)`;
                                if (action.failContains && cf.text.includes(action.failContains)) {
                                    throw new Error(`Page indicates failure: "${action.failContains}" detected`);
                                }
                                if (action.successContains && !cf.text.includes(action.successContains)) {
                                    throw new Error(`Expected success indicator "${action.successContains}" not found in the Mini App page`);
                                }
                                break;
                            }
                            case "open_bot_menu_app":
                            case "open_mini_app_url": {
                                // Both open a signed Mini App in the browser and differ only in where the
                                // address comes from -- one is typed, the other asked of the bot -- so the
                                // resolution is per type and everything past it is shared.
                                let url;
                                let unsigned = false;
                                // Init data ages, so each browser attempt is signed afresh
                                let refresh;
                                if (action.type === "open_bot_menu_app") {
                                    const owner = action.contact?.trim() || botUsername.trim();
                                    if (!owner) {
                                        throw new Error("This action needs the bot whose menu button to open. Set one on the " +
                                            "job, or give the step its own contact.");
                                    }
                                    const app = await (0, miniApp_1.openableBotMenuApp)(client, owner);
                                    if (!app) {
                                        throw new Error(`${owner} pins no Mini App beside the composer, so it has no menu ` +
                                            "button to open. Use “Open Mini App by URL” with its address instead.");
                                    }
                                    step.label = `Open "${app.text}" (${owner} menu button)`;
                                    step.cfMiniApp = true;
                                    step.cfMiniAppSigned = app.signed;
                                    if (!app.signed) {
                                        throw new Error(`Telegram would not sign ${owner}'s menu Mini App, so it cannot be ` +
                                            "opened logged in.");
                                    }
                                    url = app.url;
                                    refresh = async () => (await (0, miniApp_1.openableBotMenuApp)(client, owner))?.url ?? app.url;
                                }
                                else {
                                    // Placeholders expand as they do for a command, so one template URL can
                                    // still carry a per-run value
                                    const rawUrl = (0, checkin_1.expandCommand)(action.url ?? "").trim();
                                    if (!rawUrl)
                                        throw new Error("This action needs a Mini App URL");
                                    // Blank names the job's own bot, which is the common case: a template set
                                    // up for one bot works for every account linked to it
                                    const owner = action.contact?.trim() || botUsername.trim();
                                    step.label = `Open Mini App ${rawUrl}`;
                                    // An address that already carries its account data needs no signing: it
                                    // is what Telegram would have handed back anyway
                                    const carriesAccount = /[#&]tgWebAppData=/.test(rawUrl);
                                    const resolved = await (0, miniApp_1.openableMiniAppUrl)(client, rawUrl, owner || undefined);
                                    step.cfMiniApp = true;
                                    step.cfMiniAppSigned = resolved.signed || carriesAccount;
                                    // Naming a bot and being refused by it is a misconfiguration worth
                                    // stopping for. Naming none is a deliberate choice -- the page is opened
                                    // on this account's browser and exit as it stands, which some apps need.
                                    if (!resolved.signed && owner) {
                                        throw new Error(`Telegram would not sign this Mini App URL through ${owner}, so it cannot be ` +
                                            "opened logged in. Check the bot owns the app, use its t.me/<bot>/<app> link, " +
                                            "or clear the contact to open the address as it stands.");
                                    }
                                    url = resolved.url;
                                    unsigned = !resolved.signed && !carriesAccount;
                                    refresh = async () => (await (0, miniApp_1.openableMiniAppUrl)(client, rawUrl, owner || undefined)).url;
                                }
                                const cfHost = (() => {
                                    try {
                                        return new URL(url).host;
                                    }
                                    catch {
                                        return "";
                                    }
                                })();
                                const tune = (0, cfTuning_1.cfTuning)();
                                const budgetMs = action.maxWaitMs && action.maxWaitMs > 0 ? action.maxWaitMs : tune.budgetMs;
                                const budgetKey = `mini:${i}`;
                                const actionDeadline = cfRun.deadlines.get(budgetKey) ?? Date.now() + budgetMs;
                                cfRun.deadlines.set(budgetKey, actionDeadline);
                                const budgetLeft = actionDeadline - Date.now();
                                if (budgetLeft < tune.minActionMs) {
                                    throw new Error(`Browser time for this action is spent (${Math.round(budgetMs / 1000)}s budget)`);
                                }
                                const refused = (0, cloudflare_1.cfRefusedFor)(cfRun, cfHost);
                                const candidates = (0, proxyProviders_1.cfProxyCandidatesFor)({
                                    primaryUrl: webProxyUrl,
                                    host: cfHost,
                                    proxyId: action.proxyId,
                                    tryAll: action.tryAllProxies ?? true,
                                    exclude: refused,
                                    max: action.tryAllProxies === false ? 1 : (0, proxyProviders_1.cfMaxCandidates)(),
                                });
                                if (!candidates.length) {
                                    throw new Error((0, cloudflare_1.cfNoCandidatesMessage)(cfRun, cfHost));
                                }
                                const cf = await (0, cloudflare_1.loadCheckinUrl)(url, webProxyUrl, {
                                    miniApp: true,
                                    inAppClicks: (action.appButtons ?? []).map((b) => b.trim()).filter(Boolean),
                                    maxWaitMs: budgetLeft,
                                    screenshot: true,
                                    solveQuestion: async (question) => {
                                        const prompt = `A Telegram Mini App is asking a verification question before it will ` +
                                            `complete a checkin. The screen reads:\n\n${question}\n\n` +
                                            `Reply with ONLY the answer to type into the input, nothing else.`;
                                        const { response } = await (0, checkin_1.callAI)([], prompt, 512);
                                        step.aiPrompt = prompt;
                                        step.aiResponse = response;
                                        return response;
                                    },
                                    aiLocate: async (image, prompt) => {
                                        const { response } = await (0, checkin_1.callAI)([image], prompt, 512);
                                        step.aiPrompt = prompt;
                                        step.aiResponse = response;
                                        return response;
                                    },
                                    proxyCandidates: candidates,
                                    refreshUrl: refresh,
                                });
                                step.cfHost = cf.finalHost;
                                step.cfChallenged = cf.challenged;
                                step.cfPassed = cf.ok;
                                step.cfMiniAppAction = cf.inAppAction;
                                step.cfProxy = cf.proxyLabel;
                                step.cfBuild = cf.browserTier;
                                step.cfAttempts = cf.attempts;
                                step.cfPageTitle = cf.pageTitle;
                                step.cfNavError = cf.navError;
                                step.cfTrace = cf.trace;
                                step.cfScreenshot = cf.screenshot;
                                for (const id of cf.refusedProxyIds ?? [])
                                    refused.add(id);
                                if (!cf.ok)
                                    (0, cloudflare_1.cfNoteFailure)(cfRun, cf.finalHost, cf.reason);
                                if (cf.ok && cf.proxyId)
                                    (0, proxyProviders_1.rememberCfProxy)(cf.finalHost, cf.proxyId);
                                step.responseHtml = (0, htmlEscape_1.escapeHtml)(cf.text.slice(0, 2000)).replace(/\n/g, "<br>");
                                if (!cf.ok) {
                                    throw new Error(cf.reason ?? (0, cloudflare_1.cfFailureFallback)(cf.challenged, true));
                                }
                                // Said plainly: an app that turns out to need an account will fail inside
                                // the page, and "opened, nothing pressed" alone would not explain why
                                const how = unsigned ? " (no bot named, so opened without account data)" : "";
                                step.result = cf.inAppAction
                                    ? `Opened the Mini App, pressed "${cf.inAppAction}"${how}`
                                    : `Opened the Mini App (nothing pressed inside it)${how}`;
                                if (action.failContains && cf.text.includes(action.failContains)) {
                                    throw new Error(`Page indicates failure: "${action.failContains}" detected`);
                                }
                                if (action.successContains && !cf.text.includes(action.successContains)) {
                                    throw new Error(`Expected success indicator "${action.successContains}" not found in the Mini App page`);
                                }
                                break;
                            }
                            case "open_url": {
                                // Placeholders are expanded the same way a command's are, so a URL can carry
                                // a random query value per run
                                const url = (0, checkin_1.expandCommand)(action.url ?? "").trim();
                                const webSteps = action.steps ?? [];
                                const cfHost = (() => {
                                    try {
                                        return new URL(url).host;
                                    }
                                    catch {
                                        return "";
                                    }
                                })();
                                // Named before the checks below, so a misconfigured URL still logs a step
                                // that says which one it was
                                step.label = `Open ${cfHost || url || "(no URL)"}${webSteps.length ? ` (${webSteps.length} page step${webSteps.length > 1 ? "s" : ""})` : ""}`;
                                if (!url)
                                    throw new Error("No URL configured for this step");
                                if (!/^https?:\/\//i.test(url))
                                    throw new Error(`URL must start with http:// or https:// (got "${url}")`);
                                // The budget covers this action's whole browser life, retries included
                                const tune = (0, cfTuning_1.cfTuning)();
                                const budgetMs = action.maxWaitMs && action.maxWaitMs > 0 ? action.maxWaitMs : tune.budgetMs;
                                const budgetKey = `url:${i}`;
                                const actionDeadline = cfRun.deadlines.get(budgetKey) ?? Date.now() + budgetMs;
                                cfRun.deadlines.set(budgetKey, actionDeadline);
                                const budgetLeft = actionDeadline - Date.now();
                                if (budgetLeft < tune.minActionMs) {
                                    throw new Error(`Browser time for this action is spent (${Math.round(budgetMs / 1000)}s budget)`);
                                }
                                const refused = (0, cloudflare_1.cfRefusedFor)(cfRun, cfHost);
                                const candidates = (0, proxyProviders_1.cfProxyCandidatesFor)({
                                    primaryUrl: webProxyUrl,
                                    host: cfHost,
                                    proxyId: action.proxyId,
                                    tryAll: action.tryAllProxies ?? true,
                                    exclude: refused,
                                    max: action.tryAllProxies === false ? 1 : (0, proxyProviders_1.cfMaxCandidates)(),
                                });
                                if (!candidates.length) {
                                    throw new Error((0, cloudflare_1.cfNoCandidatesMessage)(cfRun, cfHost));
                                }
                                const cf = await (0, cloudflare_1.loadCheckinUrl)(url, webProxyUrl, {
                                    webSteps,
                                    maxWaitMs: budgetLeft,
                                    screenshot: true,
                                    proxyCandidates: candidates,
                                    // The vision model lives on this side of the browser, so the page steps
                                    // reach it through a callback rather than the solver importing it
                                    aiLocate: async (image, prompt) => {
                                        const { response } = await (0, checkin_1.callAI)([image], prompt, 512);
                                        return response;
                                    },
                                });
                                step.cfHost = cf.finalHost;
                                step.cfChallenged = cf.challenged;
                                step.cfPassed = cf.ok;
                                step.cfProxy = cf.proxyLabel;
                                step.cfBuild = cf.browserTier;
                                step.cfAttempts = cf.attempts;
                                step.cfPageTitle = cf.pageTitle;
                                step.cfNavError = cf.navError;
                                step.cfTrace = cf.trace;
                                step.cfScreenshot = cf.screenshot;
                                step.webSteps = cf.webSteps;
                                for (const id of cf.refusedProxyIds ?? [])
                                    refused.add(id);
                                if (!cf.ok)
                                    (0, cloudflare_1.cfNoteFailure)(cfRun, cf.finalHost, cf.reason);
                                if (cf.ok && cf.proxyId)
                                    (0, proxyProviders_1.rememberCfProxy)(cf.finalHost, cf.proxyId);
                                step.responseHtml = (0, htmlEscape_1.escapeHtml)(cf.text.slice(0, 2000)).replace(/\n/g, "<br>");
                                if (!cf.ok) {
                                    throw new Error(cf.reason ?? (0, cloudflare_1.cfFailureFallback)(cf.challenged, true));
                                }
                                const ran = (cf.webSteps ?? []).filter((s) => s.outcome).length;
                                step.result = webSteps.length
                                    ? `Opened ${cf.finalHost}, ran ${ran}/${webSteps.length} page step(s)`
                                    : `Opened ${cf.finalHost}`;
                                if (action.failContains && cf.text.includes(action.failContains)) {
                                    throw new Error(`Page indicates failure: "${action.failContains}" detected`);
                                }
                                if (action.successContains && !cf.text.includes(action.successContains)) {
                                    throw new Error(`Expected success indicator "${action.successContains}" not found on the page`);
                                }
                                break;
                            }
                        }
                        actionSucceeded = true;
                    }
                    catch (err) {
                        // Cancellation is never retried
                        if (err?.message === "Job cancelled")
                            throw err;
                        step.error = err?.message ?? String(err);
                        step.errorName = err?.name ?? err?.constructor?.name;
                        if (Array.isArray(err?.aiRetries) && err.aiRetries.length)
                            step.aiRetries = err.aiRetries;
                        if (err?.aiPrompt != null && step.aiPrompt == null)
                            step.aiPrompt = err.aiPrompt;
                        if (err?.aiResponse != null && step.aiResponse == null)
                            step.aiResponse = err.aiResponse;
                        if (actionAttempt > actionMaxRetries) {
                            // All action retries exhausted -- fail this job attempt
                            jobAttemptFailed = true;
                            lastJobError = err;
                        }
                    }
                    finally {
                        step.durationMs = Date.now() - t0;
                    }
                }
                if (jobAttemptFailed)
                    break;
            }
            if (!jobAttemptFailed) {
                lastJobError = null;
                break;
            }
        }
        if (lastJobError)
            throw lastJobError;
    }
    catch (err) {
        if (err?.message === "Job cancelled")
            throw err;
        throw new CustomJobError(err?.message ?? String(err), log);
    }
    finally {
        // destroy, not disconnect -- only destroy stops the GramJS ping loop (issue #14)
        try {
            await client.destroy();
        }
        catch {
            /* ignore */
        }
    }
    return log;
}
