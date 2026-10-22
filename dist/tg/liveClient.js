"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseMiniAppLink = void 0;
exports.sweepLiveClients = sweepLiveClients;
exports.entityToChatId = entityToChatId;
exports.peerToChatId = peerToChatId;
exports.reconnectClient = reconnectClient;
exports.isAuthError = isAuthError;
exports.markSessionExpired = markSessionExpired;
exports.getLiveClient = getLiveClient;
exports.loadDialogs = loadDialogs;
exports.ensureEntityCached = ensureEntityCached;
exports.getMessages = getMessages;
exports.getPinnedMessage = getPinnedMessage;
exports.sendMessage = sendMessage;
exports.sendFile = sendFile;
exports.getContacts = getContacts;
exports.addContact = addContact;
exports.editContact = editContact;
exports.searchPeers = searchPeers;
exports.fetchPhoto = fetchPhoto;
exports.fetchAvatar = fetchAvatar;
exports.fetchAvatarsBatch = fetchAvatarsBatch;
exports.getEntityDetails = getEntityDetails;
exports.setBlocked = setBlocked;
exports.reportPeer = reportPeer;
exports.deleteHistory = deleteHistory;
exports.deleteMessages = deleteMessages;
exports.editMessage = editMessage;
exports.sendTyping = sendTyping;
exports.forwardMessages = forwardMessages;
exports.muteDialog = muteDialog;
exports.pinDialog = pinDialog;
exports.getFolders = getFolders;
exports.addChatToFolder = addChatToFolder;
exports.clickButton = clickButton;
exports.sendReaction = sendReaction;
exports.getThreadMessages = getThreadMessages;
exports.getBotInfo = getBotInfo;
exports.resolvePeer = resolvePeer;
exports.startBot = startBot;
exports.resolveWebApp = resolveWebApp;
exports.checkMembership = checkMembership;
exports.joinChannel = joinChannel;
exports.leaveChat = leaveChat;
exports.markRead = markRead;
exports.checkInvite = checkInvite;
exports.joinInvite = joinInvite;
exports.getReadOutboxMaxId = getReadOutboxMaxId;
exports.subscribeToReadOutbox = subscribeToReadOutbox;
exports.subscribeToMessages = subscribeToMessages;
exports.subscribeToDialogs = subscribeToDialogs;
exports.subscribeToTyping = subscribeToTyping;
exports.getCachedMessages = getCachedMessages;
exports.cacheMessages = cacheMessages;
exports.updateCachedMessageText = updateCachedMessageText;
exports.removeCachedMessages = removeCachedMessages;
exports.clearCachedMessages = clearCachedMessages;
exports.syncMessagesInBackground = syncMessagesInBackground;
exports.getCachedDialogs = getCachedDialogs;
exports.cacheDialogs = cacheDialogs;
exports.clearAccountCache = clearAccountCache;
exports.removeCachedDialog = removeCachedDialog;
exports.syncDialogsInBackground = syncDialogsInBackground;
exports.cleanAccount = cleanAccount;
const telegram_1 = require("telegram");
const uploads_1 = require("telegram/client/uploads");
const Logger_1 = require("telegram/extensions/Logger");
const sessions_1 = require("telegram/sessions");
const events_1 = require("telegram/events");
const database_1 = require("../db/database");
const secretColumns_1 = require("../db/secretColumns");
const htmlEscape_1 = require("./htmlEscape");
const runner_1 = require("../jobs/runner");
const appClient_1 = require("./appClient");
const miniApp_1 = require("./miniApp");
Object.defineProperty(exports, "parseMiniAppLink", { enumerable: true, get: function () { return miniApp_1.parseMiniAppLink; } });
const peerTarget_1 = require("./peerTarget");
const liveClients = new Map();
// --- Idle eviction and cache bounds (issue #14) ---
// A connected client receives every update for its account and GramJS's
// internal entity cache grows for as long as the client lives, so memory
// climbs steadily on long-running deployments. Evict clients nobody is
// watching and keep the per-entry caches bounded.
const IDLE_DISCONNECT_MS = 30 * 60000;
const SWEEP_INTERVAL_MS = 5 * 60000;
const ENTITY_CACHE_MAX = 1000;
const AVATAR_CACHE_MAX = 300;
const READ_OUTBOX_CACHE_MAX = 1000;
// A live client per account is several MB of GramJS state plus a connection, so on a
// small host the account count, not idle time, is what runs memory out. Evict the
// least recently used client nobody is watching once past this many.
const LIVE_CLIENT_MAX = Number(process.env.TG_LIVE_CLIENT_MAX ?? 8);
// Inline media is buffered whole to serve it, so a large video would spike the heap by
// its full size. Anything bigger is refused rather than risking the process.
const MEDIA_MAX_BYTES = Number(process.env.TG_MEDIA_MAX_MB ?? 25) * 1024 * 1024;
function hasSubscribers(entry) {
    return (entry.subscribers.size > 0 ||
        entry.dialogSubscribers.size > 0 ||
        entry.readSubscribers.size > 0 ||
        entry.typingSubscribers.size > 0);
}
// Maps iterate in insertion order, so this drops the oldest entries first
function trimCache(cache, max) {
    for (const key of cache.keys()) {
        if (cache.size <= max)
            return;
        cache.delete(key);
    }
}
/**
 * Drops the least recently used clients once the registry is over LIVE_CLIENT_MAX.
 * Entries with subscribers (someone is watching that account) and `keepId` (the one
 * just handed out) are never evicted, so the cap can be exceeded when more accounts
 * than that are genuinely being watched at once.
 */
function evictSurplusClients(keepId) {
    if (liveClients.size <= LIVE_CLIENT_MAX)
        return;
    const candidates = [...liveClients.entries()]
        .filter(([id, e]) => id !== keepId && !hasSubscribers(e))
        .sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt);
    for (const [accountId, entry] of candidates) {
        if (liveClients.size <= LIVE_CLIENT_MAX)
            return;
        liveClients.delete(accountId);
        entry.client.destroy().catch(() => { });
        console.log(`[tg] Evicted idle live client for account ${accountId} (over LIVE_CLIENT_MAX)`);
    }
}
function sweepLiveClients(now = Date.now()) {
    for (const [accountId, entry] of liveClients) {
        if (hasSubscribers(entry))
            entry.lastActiveAt = now;
        if (now - entry.lastActiveAt >= IDLE_DISCONNECT_MS) {
            liveClients.delete(accountId);
            // destroy() tears down the update loop and senders; disconnect() alone
            // keeps the client reusable and holding its internal caches
            entry.client.destroy().catch(() => { });
            continue;
        }
        trimCache(entry.entityCache, ENTITY_CACHE_MAX);
        trimCache(entry.avatarCache, AVATAR_CACHE_MAX);
        trimCache(entry.readOutboxCache, READ_OUTBOX_CACHE_MAX);
    }
    // A client whose subscribers have gone becomes evictable, so re-check the cap here
    // rather than only when a new one is created.
    evictSurplusClients();
}
// unref() so the sweep never keeps the process (or test runner) alive
setInterval(() => sweepLiveClients(), SWEEP_INTERVAL_MS).unref();
// Derive a stable chatId string from an entity
function entityToChatId(entity) {
    const id = entity.id.toString();
    if (entity instanceof telegram_1.Api.User)
        return `u${id}`;
    if (entity instanceof telegram_1.Api.Channel)
        return `c${id}`;
    return `g${id}`;
}
// Build chatId from a peer reference
function peerToChatId(peer) {
    if (peer instanceof telegram_1.Api.PeerUser)
        return `u${peer.userId.toString()}`;
    if (peer instanceof telegram_1.Api.PeerChannel)
        return `c${peer.channelId.toString()}`;
    if (peer instanceof telegram_1.Api.PeerChat)
        return `g${peer.chatId.toString()}`;
    return "";
}
// Reverse of peerToChatId -- used as a fallback entity lookup key
function chatIdToPeer(chatId) {
    try {
        if (chatId.startsWith("u"))
            return new telegram_1.Api.PeerUser({ userId: BigInt(chatId.slice(1)) });
        if (chatId.startsWith("c"))
            return new telegram_1.Api.PeerChannel({ channelId: BigInt(chatId.slice(1)) });
        if (chatId.startsWith("g"))
            return new telegram_1.Api.PeerChat({ chatId: BigInt(chatId.slice(1)) });
    }
    catch {
        /* ignore malformed ids */
    }
    return null;
}
// Converts Telegram message entities to safe HTML. Returns null when there are
// no formatting entities (plain text can be rendered directly).
function entitiesToHtml(text, entities) {
    if (!entities?.length)
        return null;
    const spans = [];
    for (const e of entities) {
        const end = e.offset + e.length;
        if (e instanceof telegram_1.Api.MessageEntityTextUrl) {
            const safe = (0, htmlEscape_1.safeHref)(e.url ?? "");
            if (safe) {
                spans.push({
                    offset: e.offset,
                    end,
                    open: `<a href="${(0, htmlEscape_1.escapeHtml)(safe)}" class="tgc-link" data-tgurl>`,
                    close: "</a>",
                });
            }
        }
        else if (e instanceof telegram_1.Api.MessageEntityUrl) {
            const url = text.slice(e.offset, end);
            const safe = (0, htmlEscape_1.safeHref)(url);
            if (safe) {
                spans.push({
                    offset: e.offset,
                    end,
                    open: `<a href="${(0, htmlEscape_1.escapeHtml)(safe)}" class="tgc-link" data-tgurl>`,
                    close: "</a>",
                });
            }
        }
        else if (e instanceof telegram_1.Api.MessageEntityMention) {
            const handle = text.slice(e.offset + 1, end); // strip leading @
            spans.push({
                offset: e.offset,
                end,
                open: `<a href="https://t.me/${(0, htmlEscape_1.escapeHtml)(handle)}" class="tgc-link" data-tgurl>`,
                close: "</a>",
            });
        }
        else if (e instanceof telegram_1.Api.MessageEntityBold) {
            spans.push({
                offset: e.offset,
                end,
                open: "<strong>",
                close: "</strong>",
            });
        }
        else if (e instanceof telegram_1.Api.MessageEntityItalic) {
            spans.push({ offset: e.offset, end, open: "<em>", close: "</em>" });
        }
        else if (e instanceof telegram_1.Api.MessageEntityUnderline) {
            spans.push({ offset: e.offset, end, open: "<u>", close: "</u>" });
        }
        else if (e instanceof telegram_1.Api.MessageEntityStrike) {
            spans.push({ offset: e.offset, end, open: "<s>", close: "</s>" });
        }
        else if (e instanceof telegram_1.Api.MessageEntityCode) {
            spans.push({ offset: e.offset, end, open: "<code>", close: "</code>" });
        }
        else if (e instanceof telegram_1.Api.MessageEntityPre) {
            spans.push({ offset: e.offset, end, open: "<pre>", close: "</pre>" });
        }
    }
    if (!spans.length)
        return null;
    // Sort by offset ascending; longer spans first at same offset
    spans.sort((a, b) => a.offset - b.offset || b.end - a.end);
    let html = "";
    let pos = 0;
    for (const span of spans) {
        if (span.offset < pos)
            continue; // skip overlapping spans
        if (span.offset > pos)
            html += (0, htmlEscape_1.escapeHtml)(text.slice(pos, span.offset)).replace(/\n/g, "<br>");
        html += span.open + (0, htmlEscape_1.escapeHtml)(text.slice(span.offset, span.end)) + span.close;
        pos = span.end;
    }
    if (pos < text.length)
        html += (0, htmlEscape_1.escapeHtml)(text.slice(pos)).replace(/\n/g, "<br>");
    return html;
}
function entityName(entity) {
    if (entity instanceof telegram_1.Api.User) {
        return ([entity.firstName, entity.lastName].filter(Boolean).join(" ") ||
            entity.username ||
            "Unknown");
    }
    return entity.title ?? entity.username ?? "Unknown";
}
function extractButtons(msg) {
    if (!msg.replyMarkup)
        return null;
    if (msg.replyMarkup instanceof telegram_1.Api.ReplyInlineMarkup) {
        return msg.replyMarkup.rows.map((row) => row.buttons.map((btn) => ({
            text: btn.text ?? "",
            data: btn.data ? Buffer.from(btn.data).toString("base64") : null,
            url: btn.url ?? null,
            webApp: btn instanceof telegram_1.Api.KeyboardButtonWebView ||
                btn instanceof telegram_1.Api.KeyboardButtonSimpleWebView,
            send: false,
        })));
    }
    // Reply keyboards (e.g. @SpamBot's "This is a mistake"): plain buttons whose
    // text is sent back as a message when tapped.
    if (msg.replyMarkup instanceof telegram_1.Api.ReplyKeyboardMarkup) {
        const rows = msg.replyMarkup.rows.map((row) => row.buttons.map((btn) => ({
            text: btn.text ?? "",
            data: null,
            url: btn.url ?? null,
            webApp: btn instanceof telegram_1.Api.KeyboardButtonWebView ||
                btn instanceof telegram_1.Api.KeyboardButtonSimpleWebView,
            // Only plain text buttons can be fulfilled by sending their text;
            // request-phone/location/poll/webview variants can't, so leave them inert.
            send: btn instanceof telegram_1.Api.KeyboardButton,
        })));
        return rows.length ? rows : null;
    }
    return null;
}
function extractReactions(msg) {
    const r = msg.reactions;
    if (!r?.results?.length)
        return null;
    const out = r.results
        .filter((rc) => rc.reaction?.emoticon)
        .map((rc) => ({
        emoji: rc.reaction.emoticon,
        count: rc.count,
        mine: rc.chosenOrder !== undefined && rc.chosenOrder !== null,
    }));
    return out.length ? out : null;
}
function isStickerDoc(media) {
    if (!(media instanceof telegram_1.Api.MessageMediaDocument))
        return false;
    const doc = media.document;
    if (!(doc instanceof telegram_1.Api.Document))
        return false;
    return doc.attributes.some((a) => a instanceof telegram_1.Api.DocumentAttributeSticker);
}
// Filename of a document attachment, if the sender provided one.
function docFileName(media) {
    if (!(media instanceof telegram_1.Api.MessageMediaDocument))
        return null;
    const doc = media.document;
    if (!(doc instanceof telegram_1.Api.Document))
        return null;
    const attr = doc.attributes.find((a) => a instanceof telegram_1.Api.DocumentAttributeFilename);
    return attr?.fileName ?? null;
}
function resolveProxy(proxyId) {
    if (!proxyId)
        return undefined;
    try {
        const row = database_1.db
            .prepare("SELECT value FROM settings WHERE key = ?")
            .get("proxies");
        if (!row?.value)
            return undefined;
        const list = JSON.parse(row.value);
        return (0, runner_1.parseTgProxy)(list.find((p) => p.id === proxyId)?.url);
    }
    catch {
        return undefined;
    }
}
async function reconnectClient(accountId) {
    const entry = liveClients.get(accountId);
    if (entry) {
        try {
            // destroy, not disconnect -- the old client is discarded for good
            await entry.client.destroy();
        }
        catch {
            /* ignore */
        }
        liveClients.delete(accountId);
    }
    await getLiveClient(accountId);
}
const AUTH_ERROR_CODES = [
    "AUTH_KEY_DUPLICATED",
    "AUTH_KEY_INVALID",
    "SESSION_REVOKED",
    "SESSION_EXPIRED",
    "USER_DEACTIVATED",
    "USER_DEACTIVATED_BAN",
];
function isAuthError(msg) {
    return AUTH_ERROR_CODES.some((code) => msg.includes(code));
}
function markSessionExpired(accountId) {
    database_1.db.prepare("UPDATE tg_accounts SET auth_status = 'session_expired' WHERE id = ?").run(accountId);
    const entry = liveClients.get(accountId);
    if (entry) {
        entry.client.destroy().catch(() => { });
        liveClients.delete(accountId);
    }
}
/**
 * Connections in progress, so two callers asking for the same idle account share one.
 *
 * Without this there was a gap between the map lookup above and the `set` at the end: both
 * callers saw no entry, both built and connected a TelegramClient, and the second overwrote
 * the first in `liveClients`. The first was then live, connected and unreachable, running
 * its update loop against Telegram until the process restarted.
 */
const connecting = new Map();
async function getLiveClient(accountId) {
    const existing = liveClients.get(accountId);
    if (existing) {
        existing.lastActiveAt = Date.now();
        if (!existing.client.connected)
            await existing.client.connect();
        return existing;
    }
    const inFlight = connecting.get(accountId);
    if (inFlight)
        return inFlight;
    const pending = connectLiveClient(accountId);
    connecting.set(accountId, pending);
    try {
        return await pending;
    }
    finally {
        // Cleared whether it resolved or threw, so a failed connect does not wedge the account
        connecting.delete(accountId);
    }
}
async function connectLiveClient(accountId) {
    let entry;
    const account = database_1.db
        .prepare("SELECT api_id, api_hash, session_string, proxy_id, app_client_id FROM tg_accounts WHERE id = ?")
        .get(accountId);
    if (account)
        (0, secretColumns_1.decryptAccountRow)(account);
    if (!account?.session_string)
        throw new Error("Account not found or not authenticated");
    const ownCredentials = account.api_id && account.api_hash
        ? { apiId: account.api_id, apiHash: account.api_hash }
        : null;
    const credentials = ownCredentials ?? (0, database_1.getDefaultTgApiCredentials)();
    const apiId = credentials?.apiId;
    const apiHash = credentials?.apiHash;
    if (!apiId || !apiHash)
        throw new Error("No API credentials available for this account");
    const proxy = resolveProxy(account.proxy_id);
    const deviceParams = (0, appClient_1.resolveAppClientParams)(accountId, account.app_client_id);
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(account.session_string), apiId, apiHash, {
        connectionRetries: 5,
        baseLogger: new telegram_1.Logger(Logger_1.LogLevel.NONE),
        ...(proxy ? { proxy } : {}),
        ...(deviceParams ?? {}),
    });
    try {
        await client.connect();
    }
    catch (err) {
        if (isAuthError(err?.message ?? "")) {
            database_1.db.prepare("UPDATE tg_accounts SET auth_status = 'session_expired' WHERE id = ?").run(accountId);
        }
        throw err;
    }
    // Invoke GetState so Telegram knows this session is active and starts pushing updates.
    // Fire-and-forget -- we don't want to block the first HTTP request.
    client.invoke(new telegram_1.Api.updates.GetState()).catch(() => { });
    entry = {
        client,
        entityCache: new Map(),
        subscribers: new Set(),
        dialogSubscribers: new Set(),
        avatarCache: new Map(),
        readOutboxCache: new Map(),
        readSubscribers: new Set(),
        typingSubscribers: new Set(),
        lastActiveAt: Date.now(),
    };
    liveClients.set(accountId, entry);
    evictSurplusClients(accountId);
    client.addEventHandler((event) => {
        const msg = event.message;
        if (!msg?.peerId)
            return;
        const chatId = peerToChatId(msg.peerId);
        if (!chatId)
            return;
        let fromName = null;
        if (msg.fromId) {
            const fid = peerToChatId(msg.fromId);
            const sender = entry.entityCache.get(fid);
            if (sender)
                fromName = entityName(sender);
        }
        const liveMsg = {
            chatId,
            message: {
                id: msg.id,
                text: msg.message ?? "",
                html: entitiesToHtml(msg.message ?? "", msg.entities),
                date: msg.date,
                fromMe: Boolean(msg.out),
                isRead: false, // freshly received -- recipient hasn't read it yet
                fromId: msg.fromId ? peerToChatId(msg.fromId) : null,
                fromName,
                hasPhoto: msg.media instanceof telegram_1.Api.MessageMediaPhoto,
                hasDocument: msg.media instanceof telegram_1.Api.MessageMediaDocument &&
                    !isStickerDoc(msg.media),
                hasSticker: isStickerDoc(msg.media),
                fileName: docFileName(msg.media),
                buttons: extractButtons(msg),
                reactions: extractReactions(msg),
                replyToId: msg.replyTo?.replyToMsgId ?? null,
                replyToText: null,
                replyToName: null,
                replyCount: msg.replies?.replies ?? null,
            },
        };
        cacheMessages(accountId, chatId, [liveMsg.message]);
        entry.subscribers.forEach((sub) => sub(liveMsg));
    }, new events_1.NewMessage({}));
    // Update read status when the recipient reads our outgoing messages (1-to-1 / group chats)
    client.addEventHandler((update) => {
        const chatId = peerToChatId(update.peer);
        if (!chatId)
            return;
        entry.readOutboxCache.set(chatId, update.maxId);
        entry.readSubscribers.forEach((sub) => sub(chatId, update.maxId));
    }, new events_1.Raw({ types: [telegram_1.Api.UpdateReadHistoryOutbox] }));
    // Update read status for channel outbox reads
    client.addEventHandler((update) => {
        const chatId = `c${update.channelId.toString()}`;
        entry.readOutboxCache.set(chatId, update.maxId);
        entry.readSubscribers.forEach((sub) => sub(chatId, update.maxId));
    }, new events_1.Raw({ types: [telegram_1.Api.UpdateReadChannelOutbox] }));
    // Typing notifications for private chats, basic groups and supergroups
    const emitTyping = (chatId, fromId, action) => {
        let userName = null;
        if (fromId) {
            const sender = entry.entityCache.get(fromId);
            if (sender)
                userName = entityName(sender);
        }
        entry.typingSubscribers.forEach((sub) => sub({
            chatId,
            userId: fromId,
            userName,
            cancelled: action instanceof telegram_1.Api.SendMessageCancelAction,
        }));
    };
    client.addEventHandler((update) => {
        const uid = `u${update.userId.toString()}`;
        emitTyping(uid, uid, update.action);
    }, new events_1.Raw({ types: [telegram_1.Api.UpdateUserTyping] }));
    client.addEventHandler((update) => {
        emitTyping(`g${update.chatId.toString()}`, update.fromId ? peerToChatId(update.fromId) : null, update.action);
    }, new events_1.Raw({ types: [telegram_1.Api.UpdateChatUserTyping] }));
    client.addEventHandler((update) => {
        emitTyping(`c${update.channelId.toString()}`, update.fromId ? peerToChatId(update.fromId) : null, update.action);
    }, new events_1.Raw({ types: [telegram_1.Api.UpdateChannelUserTyping] }));
    return entry;
}
// Load all dialogs into the entity cache
async function loadDialogs(entry, limit = 200) {
    const dialogs = await entry.client.getDialogs({ limit });
    const result = [];
    for (const d of dialogs) {
        if (!d.entity)
            continue;
        const entity = d.entity;
        const chatId = entityToChatId(entity);
        entry.entityCache.set(chatId, entity);
        const roMaxId = d.dialog.readOutboxMaxId;
        if (roMaxId)
            entry.readOutboxCache.set(chatId, roMaxId);
        const type = entity instanceof telegram_1.Api.User
            ? entity.bot
                ? "bot"
                : "user"
            : entity instanceof telegram_1.Api.Channel
                ? entity.megagroup
                    ? "group"
                    : "channel"
                : "group";
        const lastMsg = d.message;
        const muteUntil = d.dialog.notifySettings?.muteUntil ?? 0;
        const muted = muteUntil > 0 && muteUntil > Math.floor(Date.now() / 1000);
        const pinned = Boolean(d.dialog.pinned);
        result.push({
            chatId,
            name: d.name ?? entityName(entity),
            type,
            username: entity.username ?? null,
            unreadCount: d.dialog.unreadCount ?? 0,
            lastMessage: lastMsg
                ? {
                    text: lastMsg.message ?? "",
                    date: lastMsg.date,
                    fromMe: Boolean(lastMsg.out),
                }
                : null,
            muted,
            pinned,
        });
    }
    return result;
}
async function ensureEntityCached(entry, chatId) {
    if (entry.entityCache.has(chatId))
        return;
    await loadDialogs(entry);
    if (entry.entityCache.has(chatId))
        return;
    // Fallback for group members not in the user's dialogs (e.g. other participants).
    // GramJS keeps these in its internal session store after messages are fetched,
    // so getEntity resolves them without an extra network round-trip in most cases.
    try {
        const peer = chatIdToPeer(chatId);
        if (peer) {
            const entity = (await entry.client.getEntity(peer));
            if (entity)
                entry.entityCache.set(chatId, entity);
        }
    }
    catch {
        /* not resolvable -- fetchAvatar will cache null and won't retry */
    }
}
async function getMessages(entry, chatId, limit, offsetId, search) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Chat not found -- open the dialogs list first");
    // Service messages (join/leave/pin announcements) are dropped, so keep fetching
    // until a full page of real messages is collected. Returning a short page would
    // make the frontend believe history is exhausted and stop paginating.
    const msgs = [];
    let cursor = offsetId;
    for (let hop = 0; hop < 5 && msgs.length < limit; hop++) {
        const batch = await entry.client.getMessages(entity, {
            limit,
            ...(cursor ? { offsetId: cursor } : {}),
            ...(search ? { search } : {}),
        });
        if (!batch.length)
            break;
        for (const m of batch) {
            if (m instanceof telegram_1.Api.Message && msgs.length < limit)
                msgs.push(m);
        }
        cursor = batch[batch.length - 1].id;
        if (batch.length < limit)
            break; // genuine end of history
    }
    // Batch-fetch reply-to message texts for quote display
    const replyIdSet = new Set();
    for (const msg of msgs) {
        const rt = msg.replyTo;
        if (rt?.className === "MessageReplyHeader" && rt.replyToMsgId) {
            replyIdSet.add(rt.replyToMsgId);
        }
    }
    const replyMap = new Map();
    if (replyIdSet.size > 0) {
        try {
            const replyMsgs = await entry.client.getMessages(entity, {
                ids: [...replyIdSet],
            });
            for (const rm of replyMsgs) {
                if (!rm?.id)
                    continue;
                let rname = null;
                if (rm.fromId) {
                    const rfid = peerToChatId(rm.fromId);
                    const rsender = entry.entityCache.get(rfid);
                    if (rsender)
                        rname = entityName(rsender);
                }
                replyMap.set(rm.id, { text: rm.message ?? "", name: rname });
            }
        }
        catch {
            // Best effort -- reply quotes may be missing
        }
    }
    return msgs.map((msg) => {
        let fromName = null;
        if (msg.fromId) {
            const fid = peerToChatId(msg.fromId);
            const sender = entry.entityCache.get(fid);
            if (sender)
                fromName = entityName(sender);
        }
        const rt = msg.replyTo;
        const replyToId = rt?.className === "MessageReplyHeader" ? (rt.replyToMsgId ?? null) : null;
        const replyInfo = replyToId ? replyMap.get(replyToId) : undefined;
        const readMaxId = entry.readOutboxCache.get(chatId) ?? 0;
        return {
            id: msg.id,
            text: msg.message ?? "",
            html: entitiesToHtml(msg.message ?? "", msg.entities),
            date: msg.date,
            fromMe: Boolean(msg.out),
            isRead: Boolean(msg.out) && msg.id <= readMaxId,
            fromId: msg.fromId ? peerToChatId(msg.fromId) : null,
            fromName,
            hasPhoto: msg.media instanceof telegram_1.Api.MessageMediaPhoto,
            hasDocument: msg.media instanceof telegram_1.Api.MessageMediaDocument &&
                !isStickerDoc(msg.media),
            hasSticker: isStickerDoc(msg.media),
            fileName: docFileName(msg.media),
            buttons: extractButtons(msg),
            reactions: extractReactions(msg),
            replyToId,
            replyToText: replyInfo?.text ?? null,
            replyToName: replyInfo?.name ?? null,
            replyCount: msg.replies?.replies ?? null,
        };
    });
}
async function getPinnedMessage(entry, chatId) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Chat not found");
    let pinnedMsgId = null;
    if (entity instanceof telegram_1.Api.Channel) {
        const result = await entry.client.invoke(new telegram_1.Api.channels.GetFullChannel({ channel: entity }));
        pinnedMsgId = result.fullChat.pinnedMsgId ?? null;
    }
    else if (entity instanceof telegram_1.Api.Chat) {
        const result = await entry.client.invoke(new telegram_1.Api.messages.GetFullChat({ chatId: entity.id }));
        pinnedMsgId = result.fullChat.pinnedMsgId ?? null;
    }
    if (!pinnedMsgId)
        return null;
    const msgs = await entry.client.getMessages(entity, { ids: [pinnedMsgId] });
    if (!msgs.length || !msgs[0])
        return null;
    const msg = msgs[0];
    const readMaxId = entry.readOutboxCache.get(chatId) ?? 0;
    return {
        id: msg.id,
        text: msg.message ?? "",
        html: entitiesToHtml(msg.message ?? "", msg.entities),
        date: msg.date,
        fromMe: Boolean(msg.out),
        isRead: Boolean(msg.out) && msg.id <= readMaxId,
        fromId: msg.fromId ? peerToChatId(msg.fromId) : null,
        fromName: null,
        hasPhoto: msg.media instanceof telegram_1.Api.MessageMediaPhoto,
        hasDocument: msg.media instanceof telegram_1.Api.MessageMediaDocument && !isStickerDoc(msg.media),
        hasSticker: isStickerDoc(msg.media),
        fileName: docFileName(msg.media),
        buttons: extractButtons(msg),
        reactions: null,
        replyToId: null,
        replyToText: null,
        replyToName: null,
        replyCount: null,
    };
}
async function sendMessage(entry, chatId, text, replyToMsgId) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Chat not found");
    const result = await entry.client.sendMessage(entity, {
        message: text,
        parseMode: false, // disable markdown so characters like __ are sent verbatim
        ...(replyToMsgId ? { replyTo: replyToMsgId } : {}),
    });
    return { id: result.id, date: result.date };
}
async function sendFile(entry, chatId, opts) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Chat not found");
    const toUpload = new uploads_1.CustomFile(opts.filename, opts.buffer.length, "", opts.buffer);
    const result = await entry.client.sendFile(entity, {
        file: toUpload,
        caption: opts.caption,
        forceDocument: opts.forceDocument,
        ...(opts.replyToMsgId ? { replyTo: opts.replyToMsgId } : {}),
    });
    // Telegram sends images without forceDocument as photos, everything else as documents.
    const hasPhoto = result.photo != null;
    return {
        id: result.id,
        date: result.date,
        hasPhoto,
        hasDocument: !hasPhoto,
    };
}
async function getContacts(entry) {
    const result = await entry.client.invoke(new telegram_1.Api.contacts.GetContacts({ hash: BigInt(0) }));
    if (!("users" in result))
        return [];
    return result.users
        .filter((u) => !u.deleted)
        .map((u) => {
        const chatId = entityToChatId(u);
        entry.entityCache.set(chatId, u);
        return {
            chatId,
            firstName: u.firstName ?? "",
            lastName: u.lastName ?? "",
            username: u.username ?? null,
            phone: u.phone ?? null,
        };
    });
}
async function addContact(entry, phone, firstName, lastName = "") {
    const result = await entry.client.invoke(new telegram_1.Api.contacts.ImportContacts({
        contacts: [
            new telegram_1.Api.InputPhoneContact({
                clientId: BigInt(Date.now() % 1000000),
                phone,
                firstName,
                lastName,
            }),
        ],
    }));
    const user = result.users[0];
    if (!user)
        return null;
    const chatId = entityToChatId(user);
    entry.entityCache.set(chatId, user);
    return {
        chatId,
        firstName: user.firstName ?? "",
        lastName: user.lastName ?? "",
        username: user.username ?? null,
        phone: user.phone ?? null,
    };
}
async function editContact(entry, chatId, firstName, lastName = "") {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!(entity instanceof telegram_1.Api.User))
        return null;
    // ImportContacts updates an existing contact when the user is already known
    const result = await entry.client.invoke(new telegram_1.Api.contacts.ImportContacts({
        contacts: [
            new telegram_1.Api.InputPhoneContact({
                clientId: BigInt(Date.now() % 1000000),
                phone: entity.phone ?? "",
                firstName,
                lastName,
            }),
        ],
    }));
    const updated = result.users[0] ?? entity;
    entry.entityCache.set(chatId, updated);
    return {
        chatId,
        firstName: updated.firstName ?? "",
        lastName: updated.lastName ?? "",
        username: updated.username ?? null,
        phone: updated.phone ?? null,
    };
}
// Full dialog list for name matching. Telegram's contacts.Search only matches
// username substrings reliably (titles, especially CJK ones, are often missed),
// so own chats must be matched locally the way official clients do. Cached for
// 60s per account to keep per-keystroke searches off the network.
const DIALOG_SEARCH_CACHE_MS = 60000;
const DIALOG_SEARCH_LIMIT = 1000;
async function searchableDialogs(entry) {
    const cached = entry.dialogSearchCache;
    if (cached && Date.now() - cached.ts < DIALOG_SEARCH_CACHE_MS) {
        return cached.items;
    }
    const items = await loadDialogs(entry, DIALOG_SEARCH_LIMIT);
    entry.dialogSearchCache = { ts: Date.now(), items };
    return items;
}
function entityToDialogItem(entity) {
    if (entity instanceof telegram_1.Api.User) {
        return {
            chatId: entityToChatId(entity),
            name: entityName(entity),
            type: entity.bot ? "bot" : "user",
            username: entity.username ?? null,
            unreadCount: 0,
            lastMessage: null,
        };
    }
    return {
        chatId: entityToChatId(entity),
        name: entityName(entity),
        type: entity instanceof telegram_1.Api.Channel
            ? entity.megagroup
                ? "group"
                : "channel"
            : "group",
        username: entity.username ?? null,
        unreadCount: 0,
        lastMessage: null,
        left: entity instanceof telegram_1.Api.Channel ? Boolean(entity.left) : false,
    };
}
async function searchPeers(entry, query) {
    const q = query.toLowerCase();
    const seen = new Set();
    const dialogMatches = [];
    const titleMatches = [];
    const globalMatches = [];
    const messageMatches = [];
    // The server matches strictly, so a query with extra trailing tokens (e.g.
    // "... v3") can return nothing while a shorter prefix matches -- retry with
    // trailing words dropped when a search comes back empty.
    const words = query.split(/\s+/).filter(Boolean);
    const attempts = [query];
    for (let n = words.length - 1; n >= 1 && attempts.length < 3; n--) {
        const sub = words.slice(0, n).join(" ");
        if (sub && sub !== query)
            attempts.push(sub);
    }
    // 1. Own chats by title/username substring across the full dialog list --
    // covers private groups and CJK titles the server-side search cannot find
    try {
        for (const d of await searchableDialogs(entry)) {
            if (d.name.toLowerCase().includes(q) ||
                d.username?.toLowerCase().includes(q)) {
                if (!seen.has(d.chatId)) {
                    seen.add(d.chatId);
                    dialogMatches.push(d);
                }
            }
        }
    }
    catch {
        // Dialog fetch failed (e.g. flood wait) -- server searches below still run
    }
    // 2. Global message search -- the server also matches chats by TITLE here,
    // which is how official clients find member chats that are no longer in the
    // dialog list (e.g. removed/archived) and have no username
    for (const attempt of attempts) {
        let result;
        try {
            result = await entry.client.invoke(new telegram_1.Api.messages.SearchGlobal({
                q: attempt,
                filter: new telegram_1.Api.InputMessagesFilterEmpty(),
                minDate: 0,
                maxDate: 0,
                offsetRate: 0,
                offsetPeer: new telegram_1.Api.InputPeerEmpty(),
                offsetId: 0,
                limit: 20,
            }));
        }
        catch {
            continue;
        }
        const msgs = (result.messages ?? []);
        const entities = new Map();
        for (const c of (result.chats ?? [])) {
            entities.set(entityToChatId(c), c);
        }
        for (const u of (result.users ?? [])) {
            entities.set(entityToChatId(u), u);
        }
        // The server title-matches chats and returns them in the entity list even
        // when none of the matched messages belong to them (e.g. a group the user
        // left) -- surface those first, they are what the user is looking for
        const attemptLc = attempt.toLowerCase();
        for (const [chatId, ent] of entities) {
            if (seen.has(chatId) || ent instanceof telegram_1.Api.User)
                continue;
            if (ent.deactivated || ent.forbidden)
                continue;
            const item = entityToDialogItem(ent);
            const name = item.name.toLowerCase();
            if (name.includes(q) || name.includes(attemptLc)) {
                seen.add(chatId);
                entry.entityCache.set(chatId, ent);
                titleMatches.push(item);
            }
        }
        for (const m of msgs) {
            if (!(m instanceof telegram_1.Api.Message) || !m.peerId)
                continue;
            const chatId = peerToChatId(m.peerId);
            if (seen.has(chatId))
                continue;
            const ent = entities.get(chatId);
            if (!ent)
                continue;
            if (ent.deactivated || ent.forbidden)
                continue;
            seen.add(chatId);
            entry.entityCache.set(chatId, ent);
            const item = entityToDialogItem(ent);
            item.lastMessage = {
                text: m.message ?? "",
                date: m.date,
                fromMe: Boolean(m.out),
            };
            // A mere mention in some message text ranks last
            messageMatches.push(item);
        }
        if (msgs.length > 0 || titleMatches.length > 0)
            break;
    }
    // 3. Global search for public chats/users by username
    for (const attempt of attempts) {
        let result;
        try {
            result = await entry.client.invoke(new telegram_1.Api.contacts.Search({ q: attempt, limit: 20 }));
        }
        catch {
            continue; // e.g. QUERY_TOO_SHORT on a shortened attempt
        }
        let found = false;
        for (const u of result.users) {
            if (u.deleted)
                continue;
            found = true;
            const chatId = entityToChatId(u);
            if (seen.has(chatId))
                continue;
            seen.add(chatId);
            entry.entityCache.set(chatId, u);
            globalMatches.push(entityToDialogItem(u));
        }
        for (const c of result.chats) {
            if (c.deactivated || c.forbidden)
                continue;
            found = true;
            const chatId = entityToChatId(c);
            if (seen.has(chatId))
                continue;
            seen.add(chatId);
            entry.entityCache.set(chatId, c);
            globalMatches.push(entityToDialogItem(c));
        }
        if (found)
            break;
    }
    return [
        ...dialogMatches,
        ...titleMatches,
        ...globalMatches,
        ...messageMatches,
    ];
}
async function fetchPhoto(entry, chatId, msgId) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        return null;
    const [msg] = await entry.client.getMessages(entity, { ids: [msgId] });
    if (!msg?.media)
        return null;
    let mimeType = "image/jpeg";
    if (msg.media instanceof telegram_1.Api.MessageMediaDocument) {
        const doc = msg.media.document;
        if (doc instanceof telegram_1.Api.Document) {
            if (doc.mimeType)
                mimeType = doc.mimeType;
            const size = Number(doc.size ?? 0);
            if (size > MEDIA_MAX_BYTES) {
                console.warn(`[tg] Refusing ${(size / 1048576).toFixed(0)}MB media in ${chatId}: over the ${(MEDIA_MAX_BYTES / 1048576).toFixed(0)}MB inline limit (TG_MEDIA_MAX_MB)`);
                return null;
            }
        }
    }
    const data = await entry.client.downloadMedia(msg, {});
    if (!data)
        return null;
    let buf;
    if (Buffer.isBuffer(data))
        buf = data;
    else if (typeof data === "string")
        buf = Buffer.from(data, "binary");
    else
        buf = Buffer.from(data);
    return { buf, mimeType };
}
async function fetchAvatar(entry, chatId) {
    if (entry.avatarCache.has(chatId))
        return entry.avatarCache.get(chatId);
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity) {
        entry.avatarCache.set(chatId, null);
        return null;
    }
    try {
        // isBig must be provided -- GramJS throws TypeError if fileParams is undefined
        const data = await entry.client.downloadProfilePhoto(entity, { isBig: false });
        if (!data || (Buffer.isBuffer(data) && data.length === 0)) {
            entry.avatarCache.set(chatId, null);
            return null;
        }
        const buf = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
        entry.avatarCache.set(chatId, buf);
        return buf;
    }
    catch {
        entry.avatarCache.set(chatId, null);
        return null;
    }
}
// Fetch multiple avatars with bounded concurrency (10 at a time).
// Returns a map of chatId -> base64 jpeg string for chats that have an avatar.
async function fetchAvatarsBatch(entry, chatIds) {
    const result = {};
    const CONCURRENCY = 10;
    for (let i = 0; i < chatIds.length; i += CONCURRENCY) {
        await Promise.all(chatIds.slice(i, i + CONCURRENCY).map(async (chatId) => {
            const buf = await fetchAvatar(entry, chatId);
            if (buf)
                result[chatId] = buf.toString("base64");
        }));
    }
    return result;
}
async function getEntityDetails(entry, chatId) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Entity not found");
    const type = entity instanceof telegram_1.Api.User
        ? entity.bot
            ? "bot"
            : "user"
        : entity instanceof telegram_1.Api.Channel
            ? entity.megagroup
                ? "group"
                : "channel"
            : "group";
    let bio = null;
    let memberCount = null;
    let blocked = null;
    try {
        if (entity instanceof telegram_1.Api.User) {
            const full = await entry.client.invoke(new telegram_1.Api.users.GetFullUser({ id: entity }));
            bio = full.fullUser?.about ?? null;
            blocked = Boolean(full.fullUser?.blocked);
        }
        else if (entity instanceof telegram_1.Api.Channel) {
            const full = await entry.client.invoke(new telegram_1.Api.channels.GetFullChannel({ channel: entity }));
            bio = full.fullChat?.about ?? null;
            memberCount = full.fullChat?.participantsCount ?? null;
        }
        else {
            const full = await entry.client.invoke(new telegram_1.Api.messages.GetFullChat({ chatId: entity.id }));
            bio = full.fullChat?.about ?? null;
            memberCount =
                full.fullChat?.participants?.participants?.length ?? null;
        }
    }
    catch {
        // Full details unavailable -- basic info from entity cache is still returned
    }
    const isUser = entity instanceof telegram_1.Api.User;
    return {
        chatId,
        peerId: (0, peerTarget_1.displayPeerId)(chatId),
        name: entityName(entity),
        type,
        username: entity.username ?? null,
        phone: entity.phone ?? null,
        bio,
        memberCount,
        firstName: isUser ? (entity.firstName ?? null) : null,
        lastName: isUser ? (entity.lastName ?? null) : null,
        blocked,
    };
}
// Block or unblock a user (contacts.Block / contacts.Unblock)
async function setBlocked(entry, chatId, blocked) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!(entity instanceof telegram_1.Api.User))
        throw new Error("Only users and bots can be blocked");
    if (blocked) {
        await entry.client.invoke(new telegram_1.Api.contacts.Block({ id: entity }));
    }
    else {
        await entry.client.invoke(new telegram_1.Api.contacts.Unblock({ id: entity }));
    }
}
const REPORT_REASON_MAP = {
    spam: () => new telegram_1.Api.InputReportReasonSpam(),
    violence: () => new telegram_1.Api.InputReportReasonViolence(),
    pornography: () => new telegram_1.Api.InputReportReasonPornography(),
    childAbuse: () => new telegram_1.Api.InputReportReasonChildAbuse(),
    illegalDrugs: () => new telegram_1.Api.InputReportReasonIllegalDrugs(),
    personalDetails: () => new telegram_1.Api.InputReportReasonPersonalDetails(),
    fake: () => new telegram_1.Api.InputReportReasonFake(),
    copyright: () => new telegram_1.Api.InputReportReasonCopyright(),
    other: () => new telegram_1.Api.InputReportReasonOther(),
};
// Report a user, group or channel to Telegram
async function reportPeer(entry, chatId, reason, comment = "") {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Chat not found");
    const makeReason = REPORT_REASON_MAP[reason];
    if (!makeReason)
        throw new Error("Unknown report reason");
    await entry.client.invoke(new telegram_1.Api.account.ReportPeer({
        peer: entity,
        reason: makeReason(),
        message: comment,
    }));
}
// Delete chat history. revoke=true also removes it for the other side
// (private chats only). Channels/supergroups clear the local copy only.
async function deleteHistory(entry, chatId, revoke) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Chat not found");
    if (entity instanceof telegram_1.Api.Channel) {
        await entry.client.invoke(new telegram_1.Api.channels.DeleteHistory({ channel: entity, maxId: 0 }));
    }
    else {
        await entry.client.invoke(new telegram_1.Api.messages.DeleteHistory({
            peer: entity,
            maxId: 0,
            revoke,
        }));
    }
}
// Delete specific messages. revoke=true deletes for everyone
// (channel/supergroup deletes are always for everyone).
async function deleteMessages(entry, chatId, ids, revoke) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Chat not found");
    if (entity instanceof telegram_1.Api.Channel) {
        await entry.client.invoke(new telegram_1.Api.channels.DeleteMessages({ channel: entity, id: ids }));
    }
    else {
        await entry.client.invoke(new telegram_1.Api.messages.DeleteMessages({ id: ids, revoke }));
    }
}
// Edit the text of an own message
async function editMessage(entry, chatId, msgId, text) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Chat not found");
    await entry.client.invoke(new telegram_1.Api.messages.EditMessage({
        peer: entity,
        id: msgId,
        message: text,
    }));
}
// Broadcast that this account is typing in a chat (auto-expires after ~6s)
async function sendTyping(entry, chatId) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Chat not found");
    await entry.client.invoke(new telegram_1.Api.messages.SetTyping({
        peer: entity,
        action: new telegram_1.Api.SendMessageTypingAction(),
    }));
}
// Forward messages to another chat
async function forwardMessages(entry, fromChatId, toChatId, ids) {
    await ensureEntityCached(entry, fromChatId);
    await ensureEntityCached(entry, toChatId);
    const fromEntity = entry.entityCache.get(fromChatId);
    const toEntity = entry.entityCache.get(toChatId);
    if (!fromEntity || !toEntity)
        throw new Error("Chat not found");
    await entry.client.forwardMessages(toEntity, {
        messages: ids,
        fromPeer: fromEntity,
    });
}
// Convert an InputPeer (from DialogFilter peer lists) to chatId format
function inputPeerToChatId(peer) {
    if (!peer)
        return "";
    if (peer.userId !== undefined)
        return `u${peer.userId}`;
    if (peer.channelId !== undefined)
        return `c${peer.channelId}`;
    if (peer.chatId !== undefined)
        return `g${peer.chatId}`;
    return "";
}
// Mute a dialog -- pass muteSecs=0 to unmute
async function muteDialog(entry, chatId, muteSecs) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Entity not found");
    let peer;
    if (entity instanceof telegram_1.Api.User) {
        peer = new telegram_1.Api.InputNotifyPeer({
            peer: new telegram_1.Api.InputPeerUser({
                userId: entity.id,
                accessHash: entity.accessHash ?? BigInt(0),
            }),
        });
    }
    else if (entity instanceof telegram_1.Api.Channel) {
        peer = new telegram_1.Api.InputNotifyPeer({
            peer: new telegram_1.Api.InputPeerChannel({
                channelId: entity.id,
                accessHash: entity.accessHash ?? BigInt(0),
            }),
        });
    }
    else {
        peer = new telegram_1.Api.InputNotifyPeer({
            peer: new telegram_1.Api.InputPeerChat({ chatId: entity.id }),
        });
    }
    await entry.client.invoke(new telegram_1.Api.account.UpdateNotifySettings({
        peer,
        settings: new telegram_1.Api.InputPeerNotifySettings({
            muteUntil: muteSecs === 0 ? 0 : Math.floor(Date.now() / 1000) + muteSecs,
        }),
    }));
}
// Pin or unpin a dialog in the user's dialog list
async function pinDialog(entry, chatId, pinned) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Entity not found");
    let peer;
    if (entity instanceof telegram_1.Api.User) {
        peer = new telegram_1.Api.InputDialogPeer({
            peer: new telegram_1.Api.InputPeerUser({
                userId: entity.id,
                accessHash: entity.accessHash ?? BigInt(0),
            }),
        });
    }
    else if (entity instanceof telegram_1.Api.Channel) {
        peer = new telegram_1.Api.InputDialogPeer({
            peer: new telegram_1.Api.InputPeerChannel({
                channelId: entity.id,
                accessHash: entity.accessHash ?? BigInt(0),
            }),
        });
    }
    else {
        peer = new telegram_1.Api.InputDialogPeer({
            peer: new telegram_1.Api.InputPeerChat({ chatId: entity.id }),
        });
    }
    await entry.client.invoke(new telegram_1.Api.messages.ToggleDialogPin({ peer, pinned }));
}
async function getFolders(entry) {
    try {
        const raw = await entry.client.invoke(new telegram_1.Api.messages.GetDialogFilters());
        // Older layers return a plain array; newer layers wrap in { filters: [...] }
        const filters = Array.isArray(raw)
            ? raw
            : (raw?.filters ?? []);
        return filters
            .filter((f) => f.id && f.title !== undefined)
            .map((f) => ({
            id: f.id,
            title: typeof f.title === "string" ? f.title : (f.title?.text ?? "Folder"),
            emoticon: f.emoticon ?? null,
            includeGroups: Boolean(f.groups),
            includeBroadcasts: Boolean(f.broadcasts),
            includeBots: Boolean(f.bots),
            includeContacts: Boolean(f.contacts),
            includeNonContacts: Boolean(f.nonContacts),
            pinnedChatIds: (f.pinnedPeers ?? [])
                .map(inputPeerToChatId)
                .filter(Boolean),
            includedChatIds: (f.includePeers ?? [])
                .map(inputPeerToChatId)
                .filter(Boolean),
            excludedChatIds: (f.excludePeers ?? [])
                .map(inputPeerToChatId)
                .filter(Boolean),
        }));
    }
    catch {
        return [];
    }
}
async function addChatToFolder(entry, folderId, chatId) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Entity not found");
    let inputPeer;
    if (entity instanceof telegram_1.Api.User) {
        inputPeer = new telegram_1.Api.InputPeerUser({
            userId: entity.id,
            accessHash: entity.accessHash ?? BigInt(0),
        });
    }
    else if (entity instanceof telegram_1.Api.Channel) {
        inputPeer = new telegram_1.Api.InputPeerChannel({
            channelId: entity.id,
            accessHash: entity.accessHash ?? BigInt(0),
        });
    }
    else {
        inputPeer = new telegram_1.Api.InputPeerChat({ chatId: entity.id });
    }
    const raw = await entry.client.invoke(new telegram_1.Api.messages.GetDialogFilters());
    const filters = Array.isArray(raw)
        ? raw
        : (raw?.filters ?? []);
    const filter = filters.find((f) => f.id === folderId);
    if (!filter)
        throw new Error("Folder not found");
    // Avoid duplicates
    const alreadyIncluded = (filter.includePeers ?? []).some((p) => inputPeerToChatId(p) === chatId);
    if (!alreadyIncluded) {
        filter.includePeers = [...(filter.includePeers ?? []), inputPeer];
        // Remove from excludedPeers if present
        filter.excludePeers = (filter.excludePeers ?? []).filter((p) => inputPeerToChatId(p) !== chatId);
    }
    await entry.client.invoke(new telegram_1.Api.messages.UpdateDialogFilter({ id: folderId, filter }));
}
async function clickButton(entry, chatId, msgId, data) {
    const { client } = entry;
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Chat not found");
    const dataBytes = Buffer.from(data, "base64");
    if (process.env.DEBUG === '1') {
        console.log(`[button] chatId=${chatId} msgId=${msgId} data_hex=${dataBytes.toString('hex')}`);
    }
    const result = await client.invoke(new telegram_1.Api.messages.GetBotCallbackAnswer({
        peer: entity,
        msgId,
        data: dataBytes,
        game: false,
    }));
    if (process.env.DEBUG === '1') {
        const safeUrl = result.url
            ? result.url.replace(/([?&](?:token|hash|tgaddr)=)[^&]*/gi, '$1[REDACTED]')
            : 'null';
        console.log(`[button] alert=${result.alert} msg=${JSON.stringify(result.message)} url=${safeUrl}`);
    }
    return {
        alert: result.alert ?? false,
        message: result.message ?? null,
        url: result.url ?? null,
    };
}
async function sendReaction(entry, chatId, msgId, emoji) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Chat not found");
    await entry.client.invoke(new telegram_1.Api.messages.SendReaction({
        peer: entity,
        msgId,
        reaction: emoji ? [new telegram_1.Api.ReactionEmoji({ emoticon: emoji })] : [],
    }));
}
async function getThreadMessages(entry, chatId, msgId, limit, offsetId) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Chat not found");
    const result = await entry.client.invoke(new telegram_1.Api.messages.GetReplies({
        peer: entity,
        msgId,
        offsetId,
        offsetDate: 0,
        addOffset: 0,
        limit,
        maxId: 0,
        minId: 0,
        hash: BigInt(0),
    }));
    const msgs = (result.messages ?? []);
    const readMaxId = entry.readOutboxCache.get(chatId) ?? 0;
    return msgs.map((msg) => {
        let fromName = null;
        if (msg.fromId) {
            const fid = peerToChatId(msg.fromId);
            const sender = entry.entityCache.get(fid);
            if (sender)
                fromName = entityName(sender);
        }
        return {
            id: msg.id,
            text: msg.message ?? "",
            html: entitiesToHtml(msg.message ?? "", msg.entities),
            date: msg.date,
            fromMe: Boolean(msg.out),
            isRead: Boolean(msg.out) && msg.id <= readMaxId,
            fromId: msg.fromId ? peerToChatId(msg.fromId) : null,
            fromName,
            hasPhoto: msg.media instanceof telegram_1.Api.MessageMediaPhoto,
            hasDocument: msg.media instanceof telegram_1.Api.MessageMediaDocument &&
                !isStickerDoc(msg.media),
            hasSticker: isStickerDoc(msg.media),
            fileName: docFileName(msg.media),
            buttons: extractButtons(msg),
            reactions: extractReactions(msg),
            replyToId: null,
            replyToText: null,
            replyToName: null,
            replyCount: null,
        };
    });
}
/**
 * What a bot offers beside the composer: its command list, and its menu button.
 *
 * The menu button is the Mini App a bot pins next to the input ("Misaya Media" and the
 * like). It is a property of the bot rather than of any message, so it appears nowhere in
 * the chat history -- without asking for it here there is nothing to render.
 *
 * Both come from the one GetFullUser call, since asking twice on every chat open is a
 * round trip for nothing.
 */
async function getBotInfo(entry, chatId) {
    const empty = { commands: [], menuButton: null };
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!(entity instanceof telegram_1.Api.User) || !entity.bot)
        return empty;
    try {
        const full = await entry.client.invoke(new telegram_1.Api.users.GetFullUser({ id: entity }));
        const info = full.fullUser?.botInfo;
        const commands = info?.commands ?? [];
        // Three shapes come back here: the default and "commands" variants only say which
        // menu the client should show, and carry no app. Only botMenuButton has one, which is
        // the text and address of a Mini App.
        const raw = info?.menuButton;
        const menuButton = raw && typeof raw.url === "string" && raw.url
            ? { text: String(raw.text ?? "").trim() || "Mini App", url: raw.url }
            : null;
        return {
            commands: commands.map((c) => ({
                command: c.command,
                description: c.description,
            })),
            menuButton,
        };
    }
    catch {
        return empty;
    }
}
async function resolvePeer(entry, username) {
    const query = username.startsWith("@") ? username : `@${username}`;
    try {
        const entity = await entry.client.getEntity(query);
        if (!entity)
            return null;
        let chatId;
        let type;
        let name;
        let uname = null;
        if (entity instanceof telegram_1.Api.User) {
            chatId = `u${entity.id}`;
            type = entity.bot ? "bot" : "user";
            name =
                [entity.firstName, entity.lastName].filter(Boolean).join(" ") || query;
            uname = entity.username ?? null;
        }
        else if (entity instanceof telegram_1.Api.Channel) {
            chatId = `c${entity.id}`;
            type = entity.megagroup ? "group" : "channel";
            name = entity.title ?? query;
            uname = entity.username ?? null;
        }
        else if (entity instanceof telegram_1.Api.Chat) {
            chatId = `g${entity.id}`;
            type = "group";
            name = entity.title ?? query;
        }
        else {
            return null;
        }
        entry.entityCache.set(chatId, entity);
        const left = entity instanceof telegram_1.Api.Channel ? Boolean(entity.left) : false;
        return {
            chatId,
            name,
            type,
            username: uname,
            unreadCount: 0,
            lastMessage: null,
            left,
        };
    }
    catch {
        return null;
    }
}
// Opens a bot chat and sends the startParam, mirroring a t.me/bot?start=PARAM deep link.
// Tries messages.StartBot first (correct for first-time activation); falls back to sending
// /start PARAM as a plain message when the bot is already active.
async function startBot(entry, username, startParam) {
    const query = username.startsWith("@") ? username : `@${username}`;
    const entity = await entry.client.getEntity(query);
    if (!(entity instanceof telegram_1.Api.User) || !entity.bot) {
        throw new Error("Not a bot");
    }
    const chatId = `u${entity.id}`;
    entry.entityCache.set(chatId, entity);
    try {
        await entry.client.invoke(new telegram_1.Api.messages.StartBot({
            bot: entity,
            peer: entity,
            randomId: BigInt(Date.now() % 1000000000),
            startParam,
        }));
    }
    catch {
        // Bot already started -- send the command as a regular message instead
        await entry.client.sendMessage(entity, {
            message: `/start ${startParam}`,
            parseMode: false,
        });
    }
    const name = [entity.firstName, entity.lastName].filter(Boolean).join(" ") || username;
    return {
        chatId,
        name,
        type: "bot",
        username: entity.username ?? null,
        unreadCount: 0,
        lastMessage: null,
    };
}
// Resolves a mini app URL to an authenticated web app URL.
// Handles two cases:
//   - t.me/BotName?startapp=HASH            -- uses RequestMainWebView
//   - t.me/BotName/AppShortName?startapp=HASH -- uses RequestAppWebView
//   - Direct web app URL from a KeyboardButtonWebView -- uses RequestSimpleWebView
async function resolveWebApp(entry, tmeOrUrl, botChatId, // for direct URLs we need to know which bot owns the app
peerChatId, // chat where the webview button lives (for RequestWebView)
fromBotMenu) {
    const miniApp = (0, miniApp_1.parseMiniAppLink)(tmeOrUrl);
    if (miniApp) {
        const { botUsername, appShortName, startParam } = miniApp;
        const bot = (await entry.client.getEntity(botUsername));
        entry.entityCache.set(entityToChatId(bot), bot);
        if (appShortName) {
            // Named mini app: use RequestAppWebView with InputBotAppShortName
            const inputUser = new telegram_1.Api.InputUser({
                userId: bot.id,
                accessHash: bot.accessHash,
            });
            const result = (await entry.client.invoke(new telegram_1.Api.messages.RequestAppWebView({
                peer: bot,
                app: new telegram_1.Api.InputBotAppShortName({
                    botId: inputUser,
                    shortName: appShortName,
                }),
                startParam,
                platform: "web",
                writeAllowed: true,
            })));
            return { url: (0, miniApp_1.withClientLaunchParams)(result.url), resolved: true };
        }
        const result = (await entry.client.invoke(new telegram_1.Api.messages.RequestMainWebView({
            peer: bot,
            bot,
            platform: "web",
            startParam,
        })));
        return { url: (0, miniApp_1.withClientLaunchParams)(result.url), resolved: true };
    }
    // Direct web app URL with a known bot
    if (botChatId) {
        try {
            await ensureEntityCached(entry, botChatId);
            const bot = entry.entityCache.get(botChatId);
            if (bot instanceof telegram_1.Api.User) {
                // Inline webview buttons need RequestWebView; its URL carries the full
                // signed init data (query_id included) that mini apps expect
                let peer = bot;
                if (peerChatId && peerChatId !== botChatId) {
                    await ensureEntityCached(entry, peerChatId);
                    peer = entry.entityCache.get(peerChatId) ?? bot;
                }
                try {
                    const result = (await entry.client.invoke(new telegram_1.Api.messages.RequestWebView({
                        peer,
                        bot,
                        url: tmeOrUrl,
                        platform: "web",
                        // Telegram signs a menu button's app only when told that is where the
                        // address came from. Asked without it, the request is taken for an
                        // inline-keyboard webview and what comes back carries no account data at
                        // all, so the app loads and immediately fails on "No initData found".
                        ...(fromBotMenu ? { fromBotMenu: true } : {}),
                    })));
                    return { url: (0, miniApp_1.withClientLaunchParams)(result.url), resolved: true };
                }
                catch {
                    const result = (await entry.client.invoke(new telegram_1.Api.messages.RequestSimpleWebView({
                        bot,
                        url: tmeOrUrl,
                        platform: "web",
                    })));
                    return { url: (0, miniApp_1.withClientLaunchParams)(result.url), resolved: true };
                }
            }
        }
        catch {
            // Bot rejected the webview request; treat as unresolved
        }
    }
    // Could not obtain an authenticated web app URL -- caller decides the fallback
    return { url: tmeOrUrl, resolved: false };
}
// Re-fetches the channel from TG to get the latest membership state.
async function checkMembership(entry, chatId) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity || !(entity instanceof telegram_1.Api.Channel))
        return false;
    try {
        const result = (await entry.client.invoke(new telegram_1.Api.channels.GetChannels({ id: [entity] })));
        const fresh = result.chats?.[0];
        if (fresh) {
            entry.entityCache.set(chatId, fresh);
            return !fresh.left;
        }
    }
    catch { }
    return false;
}
// Matches t.me/+HASH and t.me/joinchat/HASH invite links
const INVITE_HASH_RE = /t\.me\/(?:\+|joinchat\/)([A-Za-z0-9_-]{5,})/g;
function extractInviteHashes(msgs) {
    const hashes = [];
    const seen = new Set();
    for (const m of msgs) {
        if (!(m instanceof telegram_1.Api.Message))
            continue;
        // Links can sit in plain text, behind text entities, or on inline buttons
        const sources = [m.message ?? ""];
        for (const ent of (m.entities ?? [])) {
            if (typeof ent?.url === "string")
                sources.push(ent.url);
        }
        for (const row of (m.replyMarkup?.rows ?? [])) {
            for (const btn of (row?.buttons ?? [])) {
                if (typeof btn?.url === "string")
                    sources.push(btn.url);
            }
        }
        for (const src of sources) {
            for (const match of src.matchAll(INVITE_HASH_RE)) {
                if (!seen.has(match[1])) {
                    seen.add(match[1]);
                    hashes.push(match[1]);
                }
            }
        }
    }
    return hashes;
}
// True when a message visibly references the channel (forward header, reply,
// or being its peer) -- the references InputChannelFromMessage accepts
function referencesChannel(m, channelId) {
    const id = channelId.toString();
    const refs = [
        m.peerId?.channelId,
        m.fwdFrom?.fromId?.channelId,
        m.fwdFrom?.savedFromPeer?.channelId,
        m.replyTo?.replyToPeerId?.channelId,
    ];
    return refs.some((r) => r != null && r.toString() === id);
}
// Private chats reject channels.JoinChannel on a min entity (as cached from
// search results). Recover the way official clients can: derive a full channel
// reference from a message that mentions it (no invite needed), or find invite
// links in messages that mention the chat's title, verify each candidate
// resolves to this chat, then join through the newest valid one.
async function joinPrivateChannel(entry, entity) {
    const title = entityName(entity);
    if (!title)
        return null;
    const targetChatId = entityToChatId(entity);
    let msgs = [];
    try {
        const result = await entry.client.invoke(new telegram_1.Api.messages.SearchGlobal({
            q: title,
            filter: new telegram_1.Api.InputMessagesFilterEmpty(),
            minDate: 0,
            maxDate: 0,
            offsetRate: 0,
            offsetPeer: new telegram_1.Api.InputPeerEmpty(),
            offsetId: 0,
            limit: 50,
        }));
        msgs = (result.messages ?? []);
    }
    catch {
        /* fall through with no messages */
    }
    // Strategy 1: join via a message reference -- works without any invite link
    let fromMsgAttempts = 0;
    for (const m of msgs) {
        if (fromMsgAttempts >= 5)
            break;
        if (!(m instanceof telegram_1.Api.Message) || !m.peerId)
            continue;
        if (!referencesChannel(m, entity.id))
            continue;
        fromMsgAttempts++;
        try {
            const peer = await entry.client.getInputEntity(m.peerId);
            await entry.client.invoke(new telegram_1.Api.channels.JoinChannel({
                channel: new telegram_1.Api.InputChannelFromMessage({
                    peer,
                    msgId: m.id,
                    channelId: entity.id,
                }),
            }));
            entity.left = false;
            return { joined: true };
        }
        catch (err) {
            if (err?.message?.includes("INVITE_REQUEST_SENT")) {
                return { requestSent: true };
            }
            if (err?.message?.includes("FLOOD"))
                throw err;
            continue;
        }
    }
    // Strategy 2: invite links found in the same messages
    const hashes = extractInviteHashes(msgs);
    // Cap the invite checks -- CheckChatInvite flood-limits aggressively
    for (const hash of hashes.slice(0, 6)) {
        let preview;
        try {
            preview = await checkInvite(entry, hash);
        }
        catch (err) {
            if (err?.message?.includes("FLOOD"))
                throw err;
            continue; // expired or revoked link
        }
        if (preview.alreadyJoined) {
            if (preview.chatId === targetChatId) {
                entity.left = false;
                return { joined: true };
            }
            continue;
        }
        // ChatInvite previews carry no chat id -- match on the exact title
        if (preview.title !== title)
            continue;
        try {
            await joinInvite(entry, hash);
            entity.left = false;
            return { joined: true };
        }
        catch (err) {
            if (err?.message?.includes("INVITE_REQUEST_SENT")) {
                return { requestSent: true };
            }
            if (err?.message?.includes("USER_ALREADY_PARTICIPANT")) {
                entity.left = false;
                return { joined: true };
            }
            if (err?.message?.includes("FLOOD"))
                throw err;
            continue;
        }
    }
    return null;
}
async function joinChannel(entry, chatId) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Chat not found");
    if (!(entity instanceof telegram_1.Api.Channel))
        throw new Error("Only channels and supergroups can be joined this way");
    try {
        await entry.client.invoke(new telegram_1.Api.channels.JoinChannel({ channel: entity }));
        entity.left = false;
        return { joined: true };
    }
    catch (err) {
        // INVITE_REQUEST_SENT = group requires admin approval; request was submitted
        if (err?.message?.includes("INVITE_REQUEST_SENT")) {
            return { requestSent: true };
        }
        // Private chat -- recover via a message reference or a discovered invite
        if (err?.message?.includes("CHANNEL_PRIVATE")) {
            const recovered = await joinPrivateChannel(entry, entity);
            if (recovered)
                return recovered;
        }
        throw err;
    }
}
// Leave a group or channel. Branches on entity type: supergroups/channels use
// channels.LeaveChannel; legacy basic groups use messages.DeleteChatUser.
async function leaveChat(entry, chatId) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Chat not found");
    if (entity instanceof telegram_1.Api.Channel) {
        await entry.client.invoke(new telegram_1.Api.channels.LeaveChannel({ channel: entity }));
        entity.left = true;
    }
    else if (entity instanceof telegram_1.Api.Chat) {
        await entry.client.invoke(new telegram_1.Api.messages.DeleteChatUser({
            chatId: entity.id,
            userId: new telegram_1.Api.InputUserSelf(),
        }));
    }
    else {
        throw new Error("Only groups and channels can be left");
    }
}
async function markRead(entry, chatId, maxId) {
    await ensureEntityCached(entry, chatId);
    const entity = entry.entityCache.get(chatId);
    if (!entity)
        throw new Error("Chat not found");
    if (chatId.startsWith("c")) {
        await entry.client.invoke(new telegram_1.Api.channels.ReadHistory({ channel: entity, maxId }));
    }
    else {
        await entry.client.invoke(new telegram_1.Api.messages.ReadHistory({ peer: entity, maxId }));
    }
}
async function checkInvite(entry, hash) {
    const result = await entry.client.invoke(new telegram_1.Api.messages.CheckChatInvite({ hash }));
    if (result instanceof telegram_1.Api.ChatInviteAlready ||
        result instanceof telegram_1.Api.ChatInvitePeek) {
        const chat = result.chat;
        let chatId = "";
        let title = "";
        let memberCount = 0;
        let type = "group";
        if (chat instanceof telegram_1.Api.Channel) {
            chatId = `c${chat.id}`;
            title = chat.title ?? "";
            memberCount = chat.participantsCount ?? 0;
            type = chat.megagroup ? "group" : "channel";
            entry.entityCache.set(chatId, chat);
        }
        else if (chat instanceof telegram_1.Api.Chat) {
            chatId = `g${chat.id}`;
            title = chat.title ?? "";
            memberCount = chat.participantsCount ?? 0;
            entry.entityCache.set(chatId, chat);
        }
        return {
            hash,
            title,
            memberCount,
            type,
            alreadyJoined: true,
            chatId: chatId || undefined,
        };
    }
    const invite = result;
    const type = invite.channel && !invite.megagroup ? "channel" : "group";
    return {
        hash,
        title: invite.title ?? "",
        memberCount: invite.participantsCount ?? 0,
        type,
        alreadyJoined: false,
    };
}
async function joinInvite(entry, hash) {
    const updates = await entry.client.invoke(new telegram_1.Api.messages.ImportChatInvite({ hash }));
    const chats = updates.chats;
    const chat = chats?.[0];
    if (!chat)
        throw new Error("Failed to join: no chat in response");
    let chatId;
    let name;
    let type;
    let username = null;
    if (chat instanceof telegram_1.Api.Channel) {
        chatId = `c${chat.id}`;
        name = chat.title ?? "";
        type = chat.megagroup ? "group" : "channel";
        username = chat.username ?? null;
        entry.entityCache.set(chatId, chat);
    }
    else {
        chatId = `g${chat.id}`;
        name = chat.title ?? "";
        type = "group";
        entry.entityCache.set(chatId, chat);
    }
    return { chatId, name, type, username, unreadCount: 0, lastMessage: null };
}
function getReadOutboxMaxId(accountId, chatId) {
    return liveClients.get(accountId)?.readOutboxCache.get(chatId) ?? 0;
}
function subscribeToReadOutbox(accountId, handler) {
    const entry = liveClients.get(accountId);
    if (!entry)
        return () => { };
    entry.readSubscribers.add(handler);
    return () => entry.readSubscribers.delete(handler);
}
function subscribeToMessages(accountId, handler) {
    const entry = liveClients.get(accountId);
    if (!entry)
        return () => { };
    entry.subscribers.add(handler);
    return () => entry.subscribers.delete(handler);
}
function subscribeToDialogs(accountId, handler) {
    const entry = liveClients.get(accountId);
    if (!entry)
        return () => { };
    entry.dialogSubscribers.add(handler);
    return () => entry.dialogSubscribers.delete(handler);
}
function subscribeToTyping(accountId, handler) {
    const entry = liveClients.get(accountId);
    if (!entry)
        return () => { };
    entry.typingSubscribers.add(handler);
    return () => entry.typingSubscribers.delete(handler);
}
// --- Message cache helpers ---
const MSG_CACHE_MAX = 500;
function getCachedMessages(accountId, chatId, limit, beforeId) {
    const params = [accountId, chatId];
    let sql = "SELECT payload FROM tg_message_cache WHERE account_id = ? AND chat_id = ?";
    if (beforeId !== undefined) {
        sql += " AND msg_id < ?";
        params.push(beforeId);
    }
    sql += " ORDER BY msg_id DESC LIMIT ?";
    params.push(limit);
    const rows = database_1.db.prepare(sql).all(...params);
    return rows.map((r) => JSON.parse(r.payload));
}
function cacheMessages(accountId, chatId, msgs) {
    if (!msgs.length)
        return;
    const insert = database_1.db.prepare("INSERT OR REPLACE INTO tg_message_cache (account_id, chat_id, msg_id, msg_date, payload) VALUES (?, ?, ?, ?, ?)");
    database_1.db.transaction(() => {
        for (const msg of msgs) {
            insert.run(accountId, chatId, msg.id, msg.date, JSON.stringify(msg));
        }
    })();
    // Trim to keep only the most recent MSG_CACHE_MAX per chat
    database_1.db.prepare(`DELETE FROM tg_message_cache WHERE account_id = ? AND chat_id = ? AND msg_id NOT IN (
      SELECT msg_id FROM tg_message_cache WHERE account_id = ? AND chat_id = ? ORDER BY msg_id DESC LIMIT ?
    )`).run(accountId, chatId, accountId, chatId, MSG_CACHE_MAX);
}
// Rewrite the cached payload text after an edit so reloads show the new text
function updateCachedMessageText(accountId, chatId, msgId, text) {
    const row = database_1.db
        .prepare("SELECT payload FROM tg_message_cache WHERE account_id = ? AND chat_id = ? AND msg_id = ?")
        .get(accountId, chatId, msgId);
    if (!row)
        return;
    const payload = JSON.parse(row.payload);
    payload.text = text;
    payload.html = entitiesToHtml(text, undefined);
    database_1.db.prepare("UPDATE tg_message_cache SET payload = ? WHERE account_id = ? AND chat_id = ? AND msg_id = ?").run(JSON.stringify(payload), accountId, chatId, msgId);
}
function removeCachedMessages(accountId, chatId, ids) {
    if (!ids.length)
        return;
    const placeholders = ids.map(() => "?").join(",");
    database_1.db.prepare(`DELETE FROM tg_message_cache WHERE account_id = ? AND chat_id = ? AND msg_id IN (${placeholders})`).run(accountId, chatId, ...ids);
}
function clearCachedMessages(accountId, chatId) {
    database_1.db.prepare("DELETE FROM tg_message_cache WHERE account_id = ? AND chat_id = ?").run(accountId, chatId);
}
// Fetches messages newer than the last cached msg and pushes them to subscribers.
// Pass afterId to override the cache-based baseline (used by WS periodic sync).
async function syncMessagesInBackground(accountId, chatId, afterId) {
    const entry = liveClients.get(accountId);
    if (!entry)
        return;
    let maxId = afterId ?? 0;
    if (!maxId) {
        const row = database_1.db
            .prepare("SELECT MAX(msg_id) as m FROM tg_message_cache WHERE account_id = ? AND chat_id = ?")
            .get(accountId, chatId);
        maxId = row?.m ?? 0;
    }
    if (!maxId)
        return;
    const recent = await getMessages(entry, chatId, 100, 0);
    const newMsgs = recent.filter((m) => m.id > maxId);
    if (!newMsgs.length)
        return;
    cacheMessages(accountId, chatId, newMsgs);
    // Push oldest-first so the frontend appends in chronological order
    const ordered = newMsgs.slice().sort((a, b) => a.id - b.id);
    for (const msg of ordered) {
        entry.subscribers.forEach((sub) => sub({ chatId, message: msg }));
    }
}
// --- Dialog cache helpers ---
function getCachedDialogs(accountId) {
    const rows = database_1.db
        .prepare("SELECT payload FROM tg_dialog_cache WHERE account_id = ? ORDER BY sort_order ASC")
        .all(accountId);
    return rows.map((r) => JSON.parse(r.payload));
}
function cacheDialogs(accountId, dialogs) {
    if (!dialogs.length)
        return;
    const upsert = database_1.db.prepare(`INSERT INTO tg_dialog_cache (account_id, chat_id, sort_order, payload)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (account_id, chat_id) DO UPDATE SET sort_order = excluded.sort_order, payload = excluded.payload`);
    database_1.db.transaction(() => {
        for (let i = 0; i < dialogs.length; i++) {
            upsert.run(accountId, dialogs[i].chatId, i, JSON.stringify(dialogs[i]));
        }
    })();
}
// Drop everything cached for an account: SQLite message/dialog caches and the
// live client's in-memory entity, avatar and read-state caches. All of it is
// refetched from Telegram on demand.
function clearAccountCache(accountId) {
    database_1.db.prepare("DELETE FROM tg_message_cache WHERE account_id = ?").run(accountId);
    database_1.db.prepare("DELETE FROM tg_dialog_cache WHERE account_id = ?").run(accountId);
    const entry = liveClients.get(accountId);
    if (entry) {
        entry.entityCache.clear();
        entry.avatarCache.clear();
        entry.readOutboxCache.clear();
    }
}
function removeCachedDialog(accountId, chatId) {
    database_1.db.prepare("DELETE FROM tg_dialog_cache WHERE account_id = ? AND chat_id = ?").run(accountId, chatId);
}
// Removes cached rows for chats no longer in a full dialog load
// (deleted chats, left groups). Upserts alone never drop them.
function pruneCachedDialogs(accountId, dialogs) {
    if (!dialogs.length)
        return;
    const keep = new Set(dialogs.map((d) => d.chatId));
    const rows = database_1.db
        .prepare("SELECT chat_id FROM tg_dialog_cache WHERE account_id = ?")
        .all(accountId);
    const del = database_1.db.prepare("DELETE FROM tg_dialog_cache WHERE account_id = ? AND chat_id = ?");
    for (const r of rows) {
        if (!keep.has(r.chat_id))
            del.run(accountId, r.chat_id);
    }
}
async function syncDialogsInBackground(accountId) {
    const entry = liveClients.get(accountId);
    if (!entry)
        return;
    try {
        const dialogs = await loadDialogs(entry);
        pruneCachedDialogs(accountId, dialogs);
        cacheDialogs(accountId, dialogs);
        entry.dialogSubscribers.forEach((sub) => sub(dialogs));
    }
    catch { }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Bulk-clean an account: leave every group and channel, delete every private
// chat for both sides, remove all contacts and all custom chat folders.
// Saved Messages is kept. Destructive and irreversible -- the caller is
// responsible for confirming with the user first.
// Dialog loads are capped, so process in rounds until nothing is pending.
async function cleanAccount(entry, accountId) {
    const result = {
        left: 0,
        deleted: 0,
        contacts: 0,
        folders: 0,
        failed: [],
    };
    const failedIds = new Set();
    for (let round = 0; round < 10; round++) {
        const dialogs = await loadDialogs(entry);
        const pending = dialogs.filter((d) => {
            if (failedIds.has(d.chatId))
                return false;
            const entity = entry.entityCache.get(d.chatId);
            if (entity instanceof telegram_1.Api.User) {
                // Never wipe the user's own Saved Messages
                if (entity.self)
                    return false;
                // Keep Telegram service notifications (u777000) and SpamBot --
                // both are needed for account status and appeal messages
                if (entity.id.toString() === "777000")
                    return false;
                if ((entity.username ?? "").toLowerCase() === "spambot")
                    return false;
            }
            return true;
        });
        if (!pending.length)
            break;
        for (const d of pending) {
            try {
                if (d.type === "group" || d.type === "channel") {
                    await leaveChat(entry, d.chatId);
                    // Leaving does not always drop the dialog -- clear the leftover copy
                    try {
                        await deleteHistory(entry, d.chatId, false);
                    }
                    catch { }
                    result.left++;
                }
                else {
                    await deleteHistory(entry, d.chatId, true);
                    result.deleted++;
                }
                removeCachedDialog(accountId, d.chatId);
                clearCachedMessages(accountId, d.chatId);
                // Pace the calls to stay clear of Telegram flood limits
                await sleep(250);
            }
            catch (err) {
                failedIds.add(d.chatId);
                result.failed.push({
                    chatId: d.chatId,
                    name: d.name,
                    error: err?.message ?? String(err),
                });
            }
        }
    }
    // Remove all custom chat folders (the default "All chats" view has no id).
    // UpdateDialogFilter without a filter payload deletes the folder.
    try {
        const raw = await entry.client.invoke(new telegram_1.Api.messages.GetDialogFilters());
        const filters = Array.isArray(raw)
            ? raw
            : (raw?.filters ?? []);
        for (const f of filters) {
            if (!f.id)
                continue;
            await entry.client.invoke(new telegram_1.Api.messages.UpdateDialogFilter({ id: f.id }));
            result.folders++;
            await sleep(250);
        }
    }
    catch (err) {
        result.failed.push({
            chatId: "folders",
            name: "Folders",
            error: err?.message ?? String(err),
        });
    }
    // Remove all contacts, deleted accounts included
    try {
        const res = await entry.client.invoke(new telegram_1.Api.contacts.GetContacts({ hash: BigInt(0) }));
        if ("users" in res) {
            const ids = res.users.map((u) => new telegram_1.Api.InputUser({
                userId: u.id,
                accessHash: u.accessHash ?? BigInt(0),
            }));
            for (let i = 0; i < ids.length; i += 100) {
                const batch = ids.slice(i, i + 100);
                await entry.client.invoke(new telegram_1.Api.contacts.DeleteContacts({ id: batch }));
                result.contacts += batch.length;
                await sleep(250);
            }
        }
    }
    catch (err) {
        result.failed.push({
            chatId: "contacts",
            name: "Contacts",
            error: err?.message ?? String(err),
        });
    }
    return result;
}
