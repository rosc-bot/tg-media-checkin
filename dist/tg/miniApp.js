"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withClientLaunchParams = withClientLaunchParams;
exports.parseMiniAppLink = parseMiniAppLink;
exports.parseBotStartLink = parseBotStartLink;
exports.webButtonOf = webButtonOf;
exports.resolveMiniAppUrl = resolveMiniAppUrl;
exports.botMenuButtonOf = botMenuButtonOf;
exports.openableBotMenuApp = openableBotMenuApp;
exports.openableMiniAppUrl = openableMiniAppUrl;
exports.openableButtonUrl = openableButtonUrl;
const telegram_1 = require("telegram");
// Mini App (WebView) buttons carry a bare page address. Telegram never opens that
// address directly -- it asks the server for a signed URL first, then renders it in
// a real browser view. Job automation must do the same: request the signed URL over
// MTProto, then load it in the installed Chromium so the app sees a genuine browser
// (which is what gets us past Cloudflare) and a logged-in account.
//
// Bots also put the same thing behind plain URL buttons as t.me links, either a mini
// app (`?startapp=`) or a command deep link (`?start=`), which need the same treatment
// a real client gives them rather than being loaded as web pages.
/**
 * The theme a client hands a Mini App. Kept in step with the palette the messenger viewer
 * sends over the `theme_changed` bridge, so an app reading either sees the same colours.
 */
const THEME_PARAMS = {
    bg_color: "#ffffff",
    text_color: "#1a1a2e",
    hint_color: "#999999",
    link_color: "#4361ee",
    button_color: "#4361ee",
    button_text_color: "#ffffff",
    secondary_bg_color: "#f7f8fc",
};
/**
 * The launch parameters a client adds rather than the server: Telegram signs `tgWebAppData`
 * and returns it, but the theme is the client's to supply, and RequestSimpleWebView answers
 * without the version or platform.
 *
 * An app built on telegram-web-app.js defaults whatever is missing, which is why most open
 * fine without these. @telegram-apps/sdk instead validates the whole set and throws
 * LaunchParamsRetrieveError ("opened outside Telegram?") when the theme is absent, which the
 * app shows as its own error page -- a blank panel with no clue where the fault is.
 */
const CLIENT_LAUNCH_PARAMS = [
    ["tgWebAppVersion", "8.0"],
    ["tgWebAppPlatform", "web"],
    ["tgWebAppThemeParams", JSON.stringify(THEME_PARAMS)],
];
/** Fills in the launch parameters Telegram leaves to the client, keeping any already there. */
function withClientLaunchParams(url) {
    let out = url;
    for (const [name, value] of CLIENT_LAUNCH_PARAMS) {
        if (new RegExp(`[#&]${name}=`).test(out))
            continue;
        out += `${out.includes("#") ? "&" : "#"}${name}=${encodeURIComponent(value)}`;
    }
    return out;
}
/**
 * Parses a t.me mini app link: `t.me/BotName/AppShortName`, or `t.me/BotName`, with an
 * optional `?startapp=PARAM` on either.
 *
 * What makes a link a mini app is the app short name or a start parameter -- a bare
 * `t.me/BotName` is just a link to the bot, so it is not claimed here.
 *
 * The startapp value is percent-decoded and stripped of base64 padding: Telegram only
 * accepts [A-Za-z0-9_-] in start_param, so raw links carrying %3D-encoded padding fail
 * with START_PARAM_INVALID (issue seen with telegram.me/.../panel?startapp=...%3D%3D).
 */
function parseMiniAppLink(tmeOrUrl) {
    const m = tmeOrUrl.match(/t(?:elegram)?\.me\/([A-Za-z]\w+)(?:\/([A-Za-z]\w+))?(?:\?startapp=([^&\s]*))?/i);
    if (!m)
        return null;
    const [, botUsername, appShortName, rawParam] = m;
    // Neither an app to open nor a parameter to open one with: this is a bot link
    if (!appShortName && !rawParam)
        return null;
    let startParam = rawParam;
    if (startParam) {
        try {
            startParam = decodeURIComponent(startParam);
        }
        catch {
            // Malformed escape sequence -- keep the raw value
        }
        startParam = startParam.replace(/=+$/, "");
    }
    return { botUsername, appShortName, ...(startParam ? { startParam } : {}) };
}
/**
 * Parses a t.me/BotName?start=PARAM command deep link. Clicking such a button in a
 * real client opens the bot chat and sends `/start PARAM`, which is how bots hand a
 * group verification over to a private chat.
 */
function parseBotStartLink(tmeOrUrl) {
    const m = tmeOrUrl.match(/t(?:elegram)?\.me\/([A-Za-z]\w+)\?start=([^&\s]+)/i);
    if (!m)
        return null;
    let startParam = m[2];
    try {
        startParam = decodeURIComponent(startParam);
    }
    catch {
        // Malformed escape sequence -- keep the raw value
    }
    return { botUsername: m[1], startParam };
}
/** Reads the destination off an inline button, classifying what opening it means. */
function webButtonOf(btn) {
    if (btn instanceof telegram_1.Api.KeyboardButtonWebView || btn instanceof telegram_1.Api.KeyboardButtonSimpleWebView) {
        return { text: btn.text, url: btn.url, miniApp: true };
    }
    if (btn instanceof telegram_1.Api.KeyboardButtonUrl) {
        const miniAppLink = parseMiniAppLink(btn.url);
        if (miniAppLink)
            return { text: btn.text, url: btn.url, miniApp: true, miniAppLink };
        const startLink = parseBotStartLink(btn.url);
        if (startLink)
            return { text: btn.text, url: btn.url, miniApp: false, startLink };
        return { text: btn.text, url: btn.url, miniApp: false };
    }
    return undefined;
}
/**
 * Resolves a t.me mini app link to the signed URL Telegram would open: a named app
 * (`/panel?startapp=`) via RequestAppWebView, a main app via RequestMainWebView.
 */
async function resolveMiniAppLink(client, link) {
    try {
        const bot = (await client.getEntity(link.botUsername));
        if (link.appShortName) {
            const res = (await client.invoke(new telegram_1.Api.messages.RequestAppWebView({
                peer: bot,
                app: new telegram_1.Api.InputBotAppShortName({
                    botId: new telegram_1.Api.InputUser({ userId: bot.id, accessHash: bot.accessHash }),
                    shortName: link.appShortName,
                }),
                ...(link.startParam ? { startParam: link.startParam } : {}),
                platform: "web",
                writeAllowed: true,
            })));
            if (res?.url)
                return { url: withClientLaunchParams(res.url), resolved: true };
        }
        else {
            const res = (await client.invoke(new telegram_1.Api.messages.RequestMainWebView({
                peer: bot,
                bot,
                platform: "web",
                ...(link.startParam ? { startParam: link.startParam } : {}),
            })));
            if (res?.url)
                return { url: withClientLaunchParams(res.url), resolved: true };
        }
    }
    catch {
        /* bot refused, or the app short name is wrong -- caller falls back */
    }
    return { url: "", resolved: false };
}
/**
 * Asks Telegram for the signed Mini App URL behind a WebView button: the same page
 * plus the `tgWebAppData` fragment identifying the account. Without it the app loads
 * logged out. Falls back to the bare URL when the bot refuses the request.
 */
async function resolveMiniAppUrl(client, bot, url, peer) {
    const platform = "web";
    // Inline-keyboard buttons use RequestWebView; its URL carries the full init data
    // (query_id included), which apps that call back into the bot need.
    try {
        const res = (await client.invoke(new telegram_1.Api.messages.RequestWebView({ peer: peer ?? bot, bot, url, platform })));
        if (res?.url)
            return { url: withClientLaunchParams(res.url), resolved: true };
    }
    catch {
        /* not accepted as an inline webview -- try the simple form below */
    }
    try {
        const res = (await client.invoke(new telegram_1.Api.messages.RequestSimpleWebView({ bot, url, platform })));
        if (res?.url)
            return { url: withClientLaunchParams(res.url), resolved: true };
    }
    catch {
        /* bot refused; caller falls back to the bare URL */
    }
    return { url, resolved: false };
}
/**
 * The Mini App a bot pins beside the composer, and its label -- the button at the bottom
 * left of the chat. It is a property of the bot, not of any message, so it appears nowhere
 * in the history and this is the only way to reach it.
 *
 * Three shapes come back from Telegram here. The default and "commands" variants only say
 * which menu a client should show and carry no app at all; only `botMenuButton` has an
 * address, and a bot without one returns null rather than an empty address.
 */
async function botMenuButtonOf(client, bot) {
    const entity = (await client.getEntity(bot));
    if (!(entity instanceof telegram_1.Api.User) || !entity.bot)
        return null;
    const full = (await client.invoke(new telegram_1.Api.users.GetFullUser({ id: entity })));
    const raw = full?.fullUser?.botInfo?.menuButton;
    if (!raw || typeof raw.url !== "string" || !raw.url)
        return null;
    return { text: String(raw.text ?? "").trim() || "Mini App", url: raw.url };
}
/**
 * Asks a bot for its menu button and has Telegram sign it for this account.
 *
 * `fromBotMenu` is what makes the signing work: the address is the bot's registered one
 * rather than a button in a message, and asked for any other way Telegram takes it for an
 * inline-keyboard webview and hands back a URL carrying no account data at all -- the app
 * then loads and fails on its own "No initData found".
 */
async function openableBotMenuApp(client, bot) {
    const button = await botMenuButtonOf(client, bot);
    if (!button)
        return null;
    try {
        const res = (await client.invoke(new telegram_1.Api.messages.RequestWebView({
            peer: bot,
            bot,
            url: button.url,
            platform: "web",
            fromBotMenu: true,
        })));
        if (res?.url)
            return { url: withClientLaunchParams(res.url), text: button.text, signed: true };
    }
    catch {
        /* the bot refused; the caller decides whether the bare address is any use */
    }
    return { url: button.url, text: button.text, signed: false };
}
/**
 * Signs an address the operator typed rather than one read off a button. A
 * `t.me/<bot>/<app>` link names its own bot and is resolved from the link; anything else
 * is signed through `bot`, which is the only way Telegram will attach the init data.
 * Unsigned means the app would load logged out, so the caller decides whether to go on.
 */
async function openableMiniAppUrl(client, url, bot) {
    const link = parseMiniAppLink(url);
    if (link) {
        const viaLink = await resolveMiniAppLink(client, link);
        // The bare t.me link is a Telegram page rather than the app, so it is no fallback
        return { url: viaLink.resolved ? viaLink.url : url, signed: viaLink.resolved };
    }
    if (!bot)
        return { url, signed: false };
    const viaBot = await resolveMiniAppUrl(client, bot, url);
    return { url: viaBot.url, signed: viaBot.resolved };
}
/**
 * Turns a matched inline button into an address a browser can open: plain URL
 * buttons as-is, Mini App buttons signed by Telegram. For a webview button the app's
 * owner is the message sender (or its via-bot); in a bot DM that is the chat peer
 * itself. A t.me mini app link names its own bot, so it is resolved from the link.
 */
async function openableButtonUrl(client, web, peer, msg) {
    if (web.miniAppLink) {
        const viaLink = await resolveMiniAppLink(client, web.miniAppLink);
        // No usable fallback: the bare t.me link is a Telegram page, not the app
        return { url: viaLink.resolved ? viaLink.url : web.url, signed: viaLink.resolved };
    }
    if (!web.miniApp)
        return { url: web.url, signed: false };
    const sender = msg?.viaBotId ?? msg?.senderId ?? undefined;
    if (sender) {
        const viaSender = await resolveMiniAppUrl(client, sender, web.url, peer);
        if (viaSender.resolved)
            return { url: viaSender.url, signed: true };
    }
    const viaPeer = await resolveMiniAppUrl(client, peer, web.url, peer);
    return { url: viaPeer.url, signed: viaPeer.resolved };
}
