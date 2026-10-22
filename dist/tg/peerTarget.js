"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsePeerTarget = parsePeerTarget;
exports.displayPeerId = displayPeerId;
exports.resolvePeerTarget = resolvePeerTarget;
const telegram_1 = require("telegram");
/**
 * Reads a chat reference the operator typed or pasted:
 * - `@name`, `name`, `t.me/name` -- a username
 * - `t.me/+HASH`, `t.me/joinchat/HASH` -- an invite link
 * - `-100123`, `-123`, `123` -- an ID as Telegram clients and bots show it
 * - `c123`, `g123`, `u123` -- an ID as Bemby's messenger copies it
 */
function parsePeerTarget(raw) {
    const text = raw.trim();
    if (!text)
        return null;
    const invite = text.match(/t(?:elegram)?\.me\/(?:joinchat\/|\+)([A-Za-z0-9_-]+)/i);
    if (invite)
        return { kind: "invite", hash: invite[1] };
    const prefixed = text.match(/^([cgu])(\d+)$/);
    if (prefixed) {
        const peerType = { c: "channel", g: "chat", u: "user" };
        return { kind: "id", id: prefixed[2], peerType: peerType[prefixed[1]] };
    }
    // -100 marks a supergroup or channel, a bare minus a basic group: the form bots use
    const negative = text.match(/^-(100)?(\d+)$/);
    if (negative)
        return { kind: "id", id: negative[2], peerType: negative[1] ? "channel" : "chat" };
    if (/^\d+$/.test(text))
        return { kind: "id", id: text };
    const tme = text.match(/t(?:elegram)?\.me\/([A-Za-z]\w+)/i);
    if (tme)
        return { kind: "username", username: tme[1] };
    const username = text.replace(/^@+/, "");
    return /^[A-Za-z]\w+$/.test(username) ? { kind: "username", username } : null;
}
/** The ID form to show an operator, matching what Telegram clients and bots display. */
function displayPeerId(chatId) {
    const target = parsePeerTarget(chatId);
    if (!target || target.kind !== "id")
        return chatId;
    if (target.peerType === "channel")
        return `-100${target.id}`;
    if (target.peerType === "chat")
        return `-${target.id}`;
    return target.id;
}
function idPeer(target) {
    const id = BigInt(target.id);
    if (target.peerType === "channel")
        return new telegram_1.Api.PeerChannel({ channelId: id });
    if (target.peerType === "chat")
        return new telegram_1.Api.PeerChat({ chatId: id });
    if (target.peerType === "user")
        return new telegram_1.Api.PeerUser({ userId: id });
    return null;
}
function matchesId(entity, target) {
    if (entity.id.toString() !== target.id)
        return false;
    if (!target.peerType)
        return true;
    if (target.peerType === "user")
        return entity instanceof telegram_1.Api.User;
    if (target.peerType === "channel")
        return entity instanceof telegram_1.Api.Channel;
    return entity instanceof telegram_1.Api.Chat;
}
/**
 * Finds the chat an ID names in the account's dialog list. That list is what carries the
 * access hash Telegram demands for a private group, so it is the only way in for a chat the
 * account is a member of but that resolves nowhere by name.
 */
async function findInDialogs(client, target) {
    for await (const dialog of client.iterDialogs({})) {
        const entity = dialog.entity;
        if (entity && matchesId(entity, target))
            return entity;
    }
    return null;
}
/**
 * Resolves whatever names a chat to an entity a job can send to, read from, or join.
 *
 * An invite link is resolved without joining: the chat comes back only when the account is
 * already a member, which is the case that matters for a link that has since been revoked.
 */
async function resolvePeerTarget(client, raw) {
    const target = parsePeerTarget(raw);
    if (!target)
        throw new Error(`"${raw}" does not name a chat`);
    if (target.kind === "username")
        return client.getEntity(target.username);
    if (target.kind === "invite") {
        const check = await client.invoke(new telegram_1.Api.messages.CheckChatInvite({ hash: target.hash }));
        const chat = check.chat;
        if (chat)
            return chat;
        throw new Error("That invite link resolves to a chat this account has not joined");
    }
    const peer = idPeer(target);
    if (peer) {
        try {
            return await client.getEntity(peer);
        }
        catch {
            /* not cached and not resolvable from the ID alone -- the dialog list has the hash */
        }
    }
    const found = await findInDialogs(client, target);
    if (found)
        return found;
    throw new Error(`No chat with ID ${raw} in this account's chat list -- the account must be a member of it`);
}
