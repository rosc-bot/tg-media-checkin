"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NOTIFY_BOT_TARGET_KEY = exports.NOTIFY_BOT_TOKEN_KEY = void 0;
exports.normaliseNotifyTarget = normaliseNotifyTarget;
exports.normaliseBotTarget = normaliseBotTarget;
exports.isChatId = isChatId;
exports.getNotifyConfig = getNotifyConfig;
exports.maskBotToken = maskBotToken;
exports.getBotInfo = getBotInfo;
exports.recentBotChats = recentBotChats;
exports.sendBotNotify = sendBotNotify;
exports.sendTgNotify = sendTgNotify;
exports.notifyJobEvent = notifyJobEvent;
exports.buildFailureMessage = buildFailureMessage;
exports.buildSuccessMessage = buildSuccessMessage;
const telegram_1 = require("telegram");
const Logger_1 = require("telegram/extensions/Logger");
const sessions_1 = require("telegram/sessions");
const undici_1 = require("undici");
const database_1 = require("../db/database");
exports.NOTIFY_BOT_TOKEN_KEY = "notify_bot_token";
exports.NOTIFY_BOT_TARGET_KEY = "notify_bot_target";
const BOT_API = "https://api.telegram.org";
/** Normalises username / @username / https://t.me/username to a bare @username peer string. */
function normaliseNotifyTarget(raw) {
    const s = raw.trim();
    // t.me URL
    const tme = s.match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{3,})/);
    if (tme)
        return `@${tme[1]}`;
    // Strip leading @, re-add to normalise
    const stripped = s.replace(/^@/, "");
    return `@${stripped}`;
}
/**
 * Normalises a Bot API chat target. A bot cannot look a user up by @username -- only a
 * numeric chat id reaches a person, and @name only reaches a public channel or group -- so
 * a numeric id is passed through untouched and everything else is treated as a @name.
 */
function normaliseBotTarget(raw) {
    const s = raw.trim();
    if (/^-?\d+$/.test(s))
        return s;
    return normaliseNotifyTarget(s);
}
/** True when the target is a numeric chat id rather than a public @name. */
function isChatId(target) {
    return /^-?\d+$/.test(target.trim());
}
function getNotifyConfig() {
    const rows = database_1.db
        .prepare(`SELECT key, value FROM settings
       WHERE key IN ('notify_tg_username', 'notify_tg_events', 'notify_bot_token', 'notify_bot_target')`)
        .all();
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    let events = ["failed"];
    try {
        if (map.notify_tg_events)
            events = JSON.parse(map.notify_tg_events);
    }
    catch {
        /* ignore */
    }
    const raw = map.notify_tg_username?.trim();
    const botTarget = map[exports.NOTIFY_BOT_TARGET_KEY]?.trim();
    return {
        botToken: map[exports.NOTIFY_BOT_TOKEN_KEY]?.trim() || null,
        botTarget: botTarget ? normaliseBotTarget(botTarget) : null,
        username: raw ? normaliseNotifyTarget(raw) : null,
        events,
    };
}
/** Returns the last 4 chars of a bot token behind its public numeric id: 12345678:****wXyZ. */
function maskBotToken(token) {
    if (!token)
        return "";
    const id = token.split(":")[0] ?? "";
    const tail = token.length > 4 ? token.slice(-4) : "";
    return `${id}:****${tail}`;
}
/** One Bot API call. Never throws: a transport failure comes back as ok:false. */
async function botApi(token, method, body) {
    try {
        const res = await (0, undici_1.fetch)(`${BOT_API}/bot${token}/${method}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body ?? {}),
            signal: AbortSignal.timeout(15000),
        });
        const json = (await res.json());
        if (!json?.ok) {
            return { ok: false, error: json?.description ?? `HTTP ${res.status}` };
        }
        return { ok: true, result: json.result };
    }
    catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}
/** getMe -- confirms the token is live and names the bot it belongs to. */
function getBotInfo(token) {
    return botApi(token, "getMe");
}
/**
 * Chats the bot has heard from recently, via getUpdates. This is how an operator finds the
 * numeric chat id to notify: message the bot, then read the id back off this list. Only
 * works while no webhook is set and only covers updates Telegram still holds (~24h).
 */
async function recentBotChats(token) {
    const res = await botApi(token, "getUpdates", {
        limit: 100,
        allowed_updates: [],
    });
    if (!res.ok)
        return res;
    const chats = new Map();
    for (const update of res.result) {
        // Every update that carries a chat -- message, edited_message, channel_post,
        // my_chat_member -- holds it under the same `chat` key one level down.
        for (const value of Object.values(update)) {
            const chat = value?.chat;
            if (!chat || typeof chat.id !== "number" || chats.has(chat.id))
                continue;
            chats.set(chat.id, { id: chat.id, type: chat.type, title: chatTitle(chat) });
        }
    }
    return { ok: true, result: [...chats.values()] };
}
function chatTitle(chat) {
    const name = [chat.first_name, chat.username ? `@${chat.username}` : null]
        .filter(Boolean)
        .join(" ");
    return chat.title || name || String(chat.id);
}
/** Sends a message as the bot. Rejects with the Bot API's own description on failure. */
async function sendBotNotify(token, target, message) {
    const res = await botApi(token, "sendMessage", {
        chat_id: normaliseBotTarget(target),
        text: message,
        disable_web_page_preview: true,
    });
    if (!res.ok)
        throw new Error(res.error);
}
/**
 * Sends a notification via the given account's session.
 * target defaults to 'me' (Saved Messages).
 * Fire-and-forget -- callers should .catch() any rejection.
 *
 * @deprecated Superseded by {@link sendBotNotify}, and due for removal in a future
 * release. Sending as the account spins up a full MTProto client per notification and
 * only works when that account is authenticated; a bot token has neither limitation.
 */
async function sendTgNotify(account, message, target = "me") {
    if (!account.sessionString || !account.apiId || !account.apiHash)
        return;
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(account.sessionString), account.apiId, account.apiHash, {
        connectionRetries: 3,
        autoReconnect: false,
        baseLogger: new telegram_1.Logger(Logger_1.LogLevel.NONE),
    });
    try {
        await client.connect();
        await client.sendMessage(target, { message });
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
}
/**
 * The one place a finished job's notification is decided and sent. The bot is preferred
 * because it needs no account session, so a job whose account is unauthenticated -- or a
 * job type that has no account at all -- still notifies. Without a bot token this falls
 * back to sending from the job's own account, which is what installs did before tokens.
 * That fallback is deprecated and will be removed, so it warns each time it is used.
 *
 * `target` is the per-job override; the global default applies when it is absent.
 * Never throws: a failed notification must not fail the run that triggered it.
 */
async function notifyJobEvent(event, message, account, target, jobType) {
    const cfg = getNotifyConfig();
    const shouldNotify = cfg.events.includes(event) || (event === "success" && jobType === "embywatch");
    if (!shouldNotify)
        return;
    if (cfg.botToken) {
        const chat = target?.trim() || cfg.botTarget;
        if (!chat)
            return;
        await sendBotNotify(cfg.botToken, chat, message).catch((e) => console.warn("[notify] bot notification failed:", e));
        return;
    }
    // Deprecated sender. A failure still went to Saved Messages when no target was set.
    if (!account?.sessionString)
        return;
    const legacyTarget = target?.trim() || cfg.username;
    if (!legacyTarget && event !== "failed")
        return;
    console.warn("[notify] sending as the account is deprecated and will be removed in a future release -- set a notification bot token in Settings");
    await sendTgNotify(account, message, legacyTarget ?? "me").catch((e) => console.warn("[notify] TG notification failed:", e));
}
function translateJobType(type) {
    const map = {
        checkin: "每日签到",
        embywatch: "观影保活",
        custom: "自定义任务",
    };
    return map[type] || type;
}

function translateErrorMessage(msg) {
    if (!msg || typeof msg !== "string") return "未知错误";
    
    const timeoutMatch = msg.match(/Timed out after (\d+)ms waiting for bot reply/i);
    if (timeoutMatch) {
        const sec = Math.round(parseInt(timeoutMatch[1]) / 1000);
        return `等待机器人回复超时（${sec} 秒未响应，机器人可能卡顿或维护）`;
    }
    const btnTimeoutMatch = msg.match(/Button "(.*?)" click timed out \(BOT_RESPONSE_TIMEOUT\) with no response/i);
    if (btnTimeoutMatch) {
        return `点击按钮「${btnTimeoutMatch[1]}」无响应（机器人回调超时）`;
    }
    if (/Expected success indicator/i.test(msg)) {
        return "未收到签到成功回执（可能需要人机安全验证，或今日已签过）";
    }
    if (/No message with buttons received/i.test(msg)) {
        return "未收到带操作按钮的机器人菜单";
    }
    const btnNotFoundMatch = msg.match(/Button (.*?) not found in bot reply/i);
    if (btnNotFoundMatch) {
        return `在机器人菜单中未找到指定的签到按钮 ${btnNotFoundMatch[1]}`;
    }
    if (/no checkin control was found in the app/i.test(msg)) {
        return "验证小程序中未找到签到按钮";
    }
    if (/"css:#return-bot" is not on the app page/i.test(msg)) {
        return "验证页面未能成功生成返回机器人的跳转回执";
    }
    if (/Could not pass the Cloudflare/i.test(msg)) {
        return "未能自动通过 Cloudflare 防人机验证盾";
    }
    if (/the app is still asking for a human verification/i.test(msg)) {
        return "页面提示需要人工交互验证，自动化未通过";
    }
    if (/the app page never rendered/i.test(msg)) {
        return "验证网页加载超时，未渲染出有效内容";
    }
    if (/the app page came up blank/i.test(msg)) {
        return "验证网页加载为空白页";
    }
    if (/Checkin requires opening a Cloudflare-protected page/i.test(msg)) {
        return "该任务需要进行 Cloudflare 验证，请在任务配置中开启过盾功能";
    }
    if (/Interrupted by server restart/i.test(msg)) {
        return "面板服务重启导致任务中断";
    }
    if (/Job cancelled/i.test(msg)) {
        return "任务已被手动取消";
    }
    if (/All \d+ available proxies have already been tried/i.test(msg)) {
        if (msg.includes("no checkin control was found")) {
            return "代理节点尝试完毕：验证页面中未找到签到按钮";
        }
        if (msg.includes('"css:#return-bot"')) {
            return "代理节点尝试完毕：验证页面未生成返回机器人的跳转链接";
        }
        return "所有可用代理均已尝试，仍未能完成验证";
    }
    if (/Emby POST \/Sessions\/Playing → 400/i.test(msg)) {
        return "Emby 播放保活失败（服务器拒绝上报播放心跳：400 Bad Request）";
    }
    if (/Emby POST \/Users\/AuthenticateByName → 403/i.test(msg)) {
        return "Emby 登录失败：账号已被禁用，请联系服主";
    }
    if (/Emby POST \/Users\/AuthenticateByName → 401/i.test(msg)) {
        return "Emby 登录失败：用户名或密码错误";
    }
    const embyCodeMatch = msg.match(/Emby .*? → (\d{3})/i);
    if (embyCodeMatch) {
        return `Emby 服务器连接异常（HTTP ${embyCodeMatch[1]}）`;
    }
    const failReplyMatch = msg.match(/Reply indicates failure: "(.*?)" detected/i);
    if (failReplyMatch) {
        return `机器人返回了失败提示：${failReplyMatch[1]}`;
    }
    return msg;
}

function buildFailureMessage(jobName, jobType, errorMessage) {
    const timeStr = formatChinaTime();
    const typeZh = translateJobType(jobType);
    const reasonZh = translateErrorMessage(errorMessage);
    return [
        "❌ 任务执行失败",
        "",
        `📌 任务名称：${jobName}`,
        `⚙️ 任务类型：${typeZh}`,
        `⚠️ 失败原因：${reasonZh}`,
        `⏰ 发生时间：${timeStr}`
    ].join("\n");
}
function formatChinaTime(date = new Date()) {
    return date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function buildSuccessMessage(jobName, jobType, detailLogs = []) {
    const timeStr = formatChinaTime();
    if (jobType === "embywatch") {
        const item = (Array.isArray(detailLogs) && detailLogs.length > 0) ? detailLogs[0] : {};
        const title = item.title || item.episodes?.[0]?.title || "未知影片/剧集";
        const itemType = item.itemType || "视频";
        const durationSec = item.watchedSeconds || item.endSeconds || 0;
        const durationMin = Math.round(durationSec / 60);
        return [
            "🎬 观影保活任务完成",
            "",
            `📌 任务名称：${jobName}`,
            `🎞️ 观看内容：${title} (${itemType})`,
            `⏱️ 观看时长：${durationMin} 分钟 (${durationSec} 秒)`,
            `⏰ 观看时间：${timeStr}`
        ].join("\n");
    }
    if (jobType === "checkin" || jobType === "custom") {
        return [
            "✅ 签到任务完成",
            "",
            `📌 任务名称：${jobName}`,
            `⏰ 签到时间：${timeStr}`
        ].join("\n");
    }
    return [
        "✅ 任务执行成功",
        "",
        `📌 任务名称：${jobName}`,
        `⚙️ 任务类型：${translateJobType(jobType)}`,
        `⏰ 完成时间：${timeStr}`
    ].join("\n");
}
