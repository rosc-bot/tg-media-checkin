"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROXY_PASSWORD_MASK = exports.CLIENT_HIDDEN_KEYS = exports.ALLOWED_KEYS = void 0;
exports.maskProxies = maskProxies;
exports.unmaskProxies = unmaskProxies;
const express_1 = require("express");
const database_1 = require("../db/database");
const scheduler_1 = require("../scheduler");
const socks_1 = require("socks");
const runner_1 = require("../jobs/runner");
const bulkAdd_1 = require("../jobs/bulkAdd");
const cloudflare_1 = require("../jobs/cloudflare");
const cfTuning_1 = require("../jobs/cfTuning");
const cfLicense_1 = require("../jobs/cfLicense");
const cfBrowser_1 = require("../jobs/cfBrowser");
const proxyProviders_1 = require("../tg/proxyProviders");
const notify_1 = require("../jobs/notify");
const router = (0, express_1.Router)();
exports.ALLOWED_KEYS = [
    "default_timezone",
    "default_max_retry",
    "check_daily_run",
    "default_ua",
    "default_play_duration",
    "default_device_name",
    "ai_model",
    "ai_default_model_id",
    "ai_fallback_enabled",
    // Deprecated: target for the account-session sender, kept until that sender is removed
    "notify_tg_username",
    "notify_tg_events",
    notify_1.NOTIFY_BOT_TOKEN_KEY,
    notify_1.NOTIFY_BOT_TARGET_KEY,
    "ua_presets",
    "proxies",
    "tg_app_clients",
    "tg_client_mode",
    "default_tg_api_id",
    "default_tg_api_hash",
    "account_display_with_tg_name",
    "schedule_separate_page",
    "log_retention_days",
    "schedule_min_gap_minutes",
    "cf_solver_enabled",
    cfBrowser_1.CF_BROWSER_LANG_KEY,
    cfTuning_1.CF_TUNING_KEY,
];
/** Settings keys that must never be sent to the client. */
exports.CLIENT_HIDDEN_KEYS = new Set([
    "admin_password_hash",
    "admin_username",
    "jwt_secret",
    // Legacy single-key AI credential (superseded by the ai_suppliers table);
    // never echo it back to the client on upgraded installs.
    "ai_api_key",
    // CloakBrowser licence keys: served separately, masked
    cfLicense_1.CF_KEYS_SETTING,
    // Proxy provider credentials: served separately, with keys replaced by a flag
    "webshare_api_key",
    "proxy_providers",
    // Notification bot token: served masked, under a separate key
    notify_1.NOTIFY_BOT_TOKEN_KEY,
]);
/** True when an AI key exists anywhere the runtime looks: a supplier, the legacy setting or the env. */
function aiKeyConfigured() {
    const suppliers = database_1.db
        .prepare("SELECT COUNT(*) AS n FROM ai_suppliers WHERE api_key != ''")
        .get();
    if (suppliers.n > 0)
        return true;
    const legacy = database_1.db
        .prepare("SELECT value FROM settings WHERE key = 'ai_api_key'")
        .get();
    return Boolean(legacy?.value || process.env.AI_API_KEY);
}
/** Returns first 4 chars + **** + last 4 chars, or **** for short values. */
function maskApiHash(hash) {
    if (!hash)
        return "";
    if (hash.length <= 8)
        return "****";
    return `${hash.slice(0, 4)}****${hash.slice(-4)}`;
}
// A proxy is stored as a URL with its credentials inside it, so sending the list to the
// client sent the passwords with it -- while the seller's API key beside it was already held
// back. The password is replaced by this sentinel on the way out and restored on the way
// back in, the same round trip the API hash above already makes.
exports.PROXY_PASSWORD_MASK = "********";
function parseProxyList(raw) {
    if (!raw)
        return [];
    try {
        const list = JSON.parse(raw);
        return Array.isArray(list) ? list : [];
    }
    catch {
        return [];
    }
}
/** Rewrites a proxy URL's password, leaving everything else about it intact. */
function withProxyPassword(url, password) {
    try {
        const parsed = new URL(url);
        if (!parsed.username && !parsed.password)
            return url;
        if (password === null)
            return url;
        parsed.password = password;
        return parsed.toString();
    }
    catch {
        return url;
    }
}
function proxyPassword(url) {
    try {
        return decodeURIComponent(new URL(url).password);
    }
    catch {
        return "";
    }
}
/** The proxies setting with every password replaced by the sentinel. */
function maskProxies(raw) {
    const list = parseProxyList(raw);
    if (!list.length)
        return raw ?? "[]";
    return JSON.stringify(list.map((p) => typeof p.url === "string" && proxyPassword(p.url)
        ? { ...p, url: withProxyPassword(p.url, exports.PROXY_PASSWORD_MASK) }
        : p));
}
/**
 * Puts the real passwords back where the client sent the sentinel unchanged. An entry whose
 * id is not already stored has nothing to restore from, so its value is taken at face value.
 */
function unmaskProxies(incoming, storedRaw) {
    const list = parseProxyList(incoming);
    if (!list.length)
        return incoming;
    const stored = new Map(parseProxyList(storedRaw)
        .filter((p) => typeof p.id === "string" && typeof p.url === "string")
        .map((p) => [p.id, p.url]));
    return JSON.stringify(list.map((p) => {
        if (typeof p.url !== "string" || proxyPassword(p.url) !== exports.PROXY_PASSWORD_MASK)
            return p;
        const previous = typeof p.id === "string" ? stored.get(p.id) : undefined;
        const password = previous ? proxyPassword(previous) : "";
        return { ...p, url: withProxyPassword(p.url, password) };
    }));
}
/** Returns client-safe settings: migration flags and secret keys removed, API hash masked. */
function getClientSettings() {
    const rows = database_1.db
        .prepare("SELECT key, value FROM settings WHERE key NOT LIKE 'migration:%'")
        .all();
    const result = Object.fromEntries(rows.filter((r) => !exports.CLIENT_HIDDEN_KEYS.has(r.key)).map((r) => [r.key, r.value]));
    // Never expose the raw hash to the client
    if (result.default_tg_api_hash) {
        result.default_tg_api_hash = maskApiHash(result.default_tg_api_hash);
    }
    // Nor the passwords sitting inside the proxy URLs
    if (result.proxies) {
        result.proxies = maskProxies(result.proxies);
    }
    // Synthetic flag so the client can gate AI features without seeing the key
    result.ai_key_configured = aiKeyConfigured() ? "true" : "false";
    // Env-gated feature flag for bulk account management (add + clean)
    result.bulk_account_management = (0, bulkAdd_1.isBulkAccountManagementEnabled)()
        ? "true"
        : "false";
    // Whether the on-demand Cloudflare-solver browser is present, and which build
    result.cf_chromium_installed = (0, cloudflare_1.isChromiumInstalled)() ? "true" : "false";
    result.cf_chromium_version = (0, cloudflare_1.chromiumVersion)() ?? "";
    // Which build is on disk, and whether a configured key unlocks one that is not yet
    // downloaded -- downloads are deliberate, so this is what surfaces the outstanding one
    result.cf_chromium_tier = (0, cfBrowser_1.installedBuildTier)() ?? "";
    result.cf_chromium_path = (0, cfBrowser_1.chromiumPath)() ?? "";
    result.cf_chromium_keyed_pending = (0, cfBrowser_1.keyedBuildPending)() ? "true" : "false";
    // Whether the unlicensed build is also on disk. It is what a launch falls back to when
    // no licence seat is free -- without it, such a launch has nothing that can run.
    result.cf_chromium_free_installed = (0, cfBrowser_1.chromiumExecutable)("free") ? "true" : "false";
    // Every build on disk, so the panel can list the keyed and free ones side by side
    result.cf_chromium_builds = JSON.stringify((0, cfBrowser_1.installedCfBuilds)());
    // Browser profiles on disk: state carried between runs, and the thing to clear when a
    // browser starts failing for no reason that changed elsewhere
    result.cf_profile_count = String((0, cfBrowser_1.cfProfileCount)());
    // How many solver browsers are open right now, so the panel can offer to stop them
    result.cf_browsers_running = String((0, cfBrowser_1.cfBrowsersRunning)());
    // The CJK/emoji faces are not in the image either; they sit beside the browser in the
    // data dir. Reported separately so a browser that can only draw Latin is visible.
    result.cf_fonts_installed = (0, cloudflare_1.areCfFontsInstalled)() ? "true" : "false";
    result.cf_fonts_missing = (0, cloudflare_1.cfFontsStatus)().missing.join(", ");
    // Licence keys, masked, plus how many seats are taken right now: a free key is one
    // concurrent session, so the count is what tells the operator whether to add another
    result.cf_cloak_keys_masked = JSON.stringify((0, cfLicense_1.cfLicenseKeysForClient)());
    result.cf_cloak_keys_in_use = String((0, cfLicense_1.cfLicenseUsage)().inUse);
    // The browser timings in force, alongside the shipped defaults and the range each is
    // held to, so the client can render every field without a second source of truth
    result.cf_tuning = JSON.stringify((0, cfTuning_1.cfTuning)());
    result.cf_tuning_defaults = JSON.stringify(cfTuning_1.CF_TUNING_DEFAULTS);
    result.cf_tuning_limits = JSON.stringify(cfTuning_1.CF_TUNING_LIMITS);
    // Synthetic count so the client can show whether proxy importing is set up
    result.proxy_providers_count = String((0, proxyProviders_1.providersForClient)().length);
    // The notification bot's token, masked. Its presence is what decides whether job
    // notifications go out as the bot or fall back to the job's own account session.
    const botToken = (0, notify_1.getNotifyConfig)().botToken;
    result.notify_bot_configured = botToken ? "true" : "false";
    result.notify_bot_token_masked = botToken ? (0, notify_1.maskBotToken)(botToken) : "";
    return result;
}
router.get("/", (_req, res) => {
    res.json(getClientSettings());
});
router.put("/", (req, res) => {
    const updates = req.body;
    const stmt = database_1.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    database_1.db.transaction(() => {
        for (const key of exports.ALLOWED_KEYS) {
            if (!(key in updates))
                continue;
            // Skip if the client sent back the masked hash or bot token unchanged
            if ((key === "default_tg_api_hash" || key === notify_1.NOTIFY_BOT_TOKEN_KEY) &&
                String(updates[key]).includes("****"))
                continue;
            // Put back any proxy password the client echoed as the mask rather than retyping
            if (key === "proxies") {
                const current = database_1.db.prepare("SELECT value FROM settings WHERE key = 'proxies'").get()?.value;
                stmt.run(key, unmaskProxies(String(updates[key]), current));
                continue;
            }
            // Browser timings are stored resolved: out-of-range or unparsable values become the
            // shipped default there and then, so what is saved is what a job will use
            if (key === cfTuning_1.CF_TUNING_KEY) {
                let incoming = updates[key];
                if (typeof incoming === "string") {
                    try {
                        incoming = JSON.parse(incoming);
                    }
                    catch {
                        incoming = undefined;
                    }
                }
                stmt.run(key, JSON.stringify((0, cfTuning_1.resolveCfTuning)(incoming)));
                continue;
            }
            stmt.run(key, String(updates[key]));
        }
    })();
    // Reschedule if daily-run check toggled or the default timezone changed
    // (jobs with no timezone of their own follow the default)
    if ("check_daily_run" in updates || "default_timezone" in updates)
        (0, scheduler_1.refreshScheduler)();
    // Apply a tightened retention window straight away
    if ("log_retention_days" in updates)
        (0, scheduler_1.purgeOldLogs)();
    // Drop the cached timings so the next job picks the new ones up without a restart
    if (cfTuning_1.CF_TUNING_KEY in updates)
        (0, cfTuning_1.invalidateCfTuning)();
    res.json(getClientSettings());
});
// POST /cf-solver/install -- download the CloakBrowser stealth Chromium (~200MB) and the
// CJK/emoji faces (~30MB) on demand into the data dir so the Cloudflare "I am not a bot"
// solver can run. Neither is in the image, and the data dir is a volume, so both survive an
// upgrade. `force` downloads again over an existing install, which is how they get updated.
//
// The fonts are reported but do not decide `ok`: with the image's Latin fallback the
// browser still works, so a blocked font download is a warning, not a failed install.
let cfInstalling = false;
router.post("/cf-solver/install", async (req, res) => {
    const force = req.body?.force === true || req.query.force === "1";
    // "free" asks for the unlicensed build specifically, which is what a launch falls back
    // to when no licence seat is free. It is a separate download, so an install that already
    // has the keyed build still has work to do.
    const tier = req.body?.tier === "free" ? "free" : undefined;
    if (tier === "free") {
        if (cfInstalling) {
            res.status(409).json({ ok: false, message: "Install already in progress" });
            return;
        }
        cfInstalling = true;
        try {
            const browser = await (0, cloudflare_1.installCfChromium)(force, "free");
            res.json({
                ok: browser.ok,
                installed: browser.ok,
                fontsInstalled: (0, cloudflare_1.areCfFontsInstalled)(),
                version: browser.ok ? (0, cloudflare_1.chromiumVersion)() : undefined,
                output: browser.output.slice(-1500),
            });
        }
        finally {
            cfInstalling = false;
        }
        return;
    }
    // A licence key with no build behind it counts as outstanding: the key is only worth
    // anything once the build it unlocks is on disk.
    if ((0, cloudflare_1.isChromiumInstalled)() && (0, cloudflare_1.areCfFontsInstalled)() && !(0, cfBrowser_1.keyedBuildPending)() && !force) {
        res.json({
            ok: true,
            installed: true,
            fontsInstalled: true,
            version: (0, cloudflare_1.chromiumVersion)(),
            message: "Already installed",
        });
        return;
    }
    if (cfInstalling) {
        res.status(409).json({ ok: false, message: "Install already in progress" });
        return;
    }
    cfInstalling = true;
    try {
        // Only re-download a browser that is missing (or explicitly forced): an upgrade from an
        // image that carried the fonts needs the fonts alone, not another 200MB of browser.
        const browser = (0, cloudflare_1.isChromiumInstalled)() && !(0, cfBrowser_1.keyedBuildPending)() && !force
            ? { ok: true, output: "Browser already installed" }
            : await (0, cloudflare_1.installCfChromium)(force);
        const fonts = await (0, cloudflare_1.installCfFonts)(force);
        if (browser.ok) {
            database_1.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cf_solver_enabled', 'true')").run();
        }
        res.json({
            ok: browser.ok,
            installed: browser.ok,
            fontsInstalled: fonts.ok,
            version: browser.ok ? (0, cloudflare_1.chromiumVersion)() : undefined,
            output: `${browser.output}\n\n--- fonts ---\n${fonts.output}`.slice(-1500),
        });
    }
    catch (err) {
        res.status(500).json({ ok: false, message: err?.message ?? "Install failed" });
    }
    finally {
        cfInstalling = false;
    }
});
// ── CloakBrowser licence keys ─────────────────────────────────────────────────
// A free key (one per GitHub sign-in at cloakbrowser.dev/free) gets the current stealth
// build instead of the ageing one that needs no key, and allows one concurrent browser.
// Several can be stored so concurrent jobs each get a seat. Never sent back in full.
router.get("/cf-solver/keys", (_req, res) => {
    res.json({ keys: (0, cfLicense_1.cfLicenseKeysForClient)(), ...(0, cfLicense_1.cfLicenseUsage)() });
});
router.put("/cf-solver/keys", (req, res) => {
    const { keys } = req.body;
    if (!Array.isArray(keys)) {
        res.status(400).json({ error: "keys array is required" });
        return;
    }
    (0, cfLicense_1.saveCfLicenseKeys)(keys);
    res.json({ keys: (0, cfLicense_1.cfLicenseKeysForClient)(), ...(0, cfLicense_1.cfLicenseUsage)() });
});
// POST /cf-solver/keys/check -- ask CloakBrowser's server what each stored key is worth,
// so a key that was mistyped or has lapsed shows up here rather than as a job that quietly
// runs the old build.
router.post("/cf-solver/keys/check", async (_req, res) => {
    const results = [];
    for (const entry of (0, cfLicense_1.cfLicenseKeys)()) {
        results.push({ label: entry.label, masked: (0, cfLicense_1.maskKey)(entry.key), ...(await (0, cfBrowser_1.checkCfLicenseKey)(entry.key)) });
    }
    res.json({ results });
});
// POST /cf-solver/test -- launch the installed browser and check that it renders, so a
// Mini App step that comes up blank on a server can be told apart from a site problem.
// `?screenshot=1` includes what the browser drew.
// POST /cf-solver/stop -- close every solver browser that is open. The jobs holding them
// fail as their pages go; that is the point, since this is the way out when a run has
// wedged and is sitting on a licence seat, a profile or a proxy nothing else can have.
router.post("/cf-solver/stop", async (_req, res) => {
    const result = await (0, cfBrowser_1.stopAllCfBrowsers)();
    res.json({ ok: true, stopped: result.stopped });
});
// POST /cf-solver/clear-profiles -- delete the per-exit browser profiles (cookies, cache,
// site data). Nothing identifying goes with them: the fingerprint is derived from the exit,
// not stored here. Refused while a browser still has one open.
router.post("/cf-solver/clear-profiles", (_req, res) => {
    const result = (0, cfBrowser_1.clearCfProfiles)();
    if (result.error) {
        res.status(409).json({ ok: false, removed: result.removed, message: result.error });
        return;
    }
    res.json({ ok: true, removed: result.removed });
});
// POST /cf-solver/uninstall -- delete every downloaded browser build, reclaiming the
// ~200MB each takes in the data dir. Refused while a job still has one open, since the
// binary would be pulled out from under it.
router.post("/cf-solver/uninstall", (_req, res) => {
    if (cfInstalling) {
        res.status(409).json({ ok: false, message: "Install already in progress" });
        return;
    }
    const result = (0, cfBrowser_1.removeAllCfBuilds)();
    if (result.error) {
        res.status(409).json({ ok: false, removed: result.removed, message: result.error });
        return;
    }
    // The solver has nothing to launch now, so it stops claiming to be on
    database_1.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cf_solver_enabled', 'false')").run();
    res.json({ ok: true, removed: result.removed });
});
let cfTestState;
router.post("/cf-solver/test", (req, res) => {
    if (cfTestState?.running) {
        res.status(409).json({ ...cfTestState, message: "A browser test is already running" });
        return;
    }
    // Every build that is installed, in turn. With both on disk a job may run on either --
    // the keyed one normally, the free one when no licence seat is going -- so testing only
    // the preferred build leaves the fallback unproven, which is exactly the one that gets
    // used on a bad day.
    const tiers = ["keyed", "free"].filter((t) => !!(0, cfBrowser_1.chromiumExecutable)(t));
    const wantShot = !!req.query.screenshot;
    if (!tiers.length) {
        cfTestState = {
            running: false,
            startedAt: Date.now(),
            finishedAt: Date.now(),
            ok: false,
            error: "Chromium is not installed",
            builds: [],
        };
        res.json(cfTestState);
        return;
    }
    const state = { running: true, startedAt: Date.now(), builds: [] };
    cfTestState = state;
    void (async () => {
        try {
            for (const tier of tiers) {
                const result = await (0, cloudflare_1.testBrowser)(undefined, tier).catch((err) => ({
                    ok: false,
                    tier,
                    error: err?.message ?? String(err),
                }));
                state.builds.push(wantShot ? result : { ...result, screenshot: undefined });
            }
            state.ok = state.builds.every((b) => b.ok);
        }
        catch (err) {
            state.ok = false;
            state.error = err?.message ?? String(err);
        }
        finally {
            state.running = false;
            state.finishedAt = Date.now();
        }
    })();
    res.status(202).json(state);
});
// GET /cf-solver/test -- how the run started above is going, and its results once it is
// done. Returns a finished-with-nothing state when no test has been run since boot.
router.get("/cf-solver/test", (_req, res) => {
    res.json(cfTestState ?? { running: false, startedAt: 0, builds: [] });
});
// ── Notification bot ──────────────────────────────────────────────────────────
// Job notifications are sent by a Telegram bot, so they no longer depend on a job having
// an authenticated account. A bot cannot start a conversation, and cannot resolve a user
// by @username, so the target has to be a numeric chat id the operator obtains by messaging
// the bot first -- which is what the two endpoints below are for.
/** The token to work with: the one supplied in the request, else the one stored. */
function resolveBotToken(body) {
    const supplied = body?.token?.trim();
    if (supplied && !supplied.includes("****"))
        return supplied;
    return (0, notify_1.getNotifyConfig)().botToken;
}
// GET /notify/bot -- who the stored token belongs to, so a mistyped or revoked token shows
// up here rather than as notifications that quietly never arrive.
router.get("/notify/bot", async (_req, res) => {
    const token = (0, notify_1.getNotifyConfig)().botToken;
    if (!token) {
        res.json({ configured: false });
        return;
    }
    const info = await (0, notify_1.getBotInfo)(token);
    if (!info.ok) {
        res.json({ configured: true, ok: false, error: info.error });
        return;
    }
    res.json({
        configured: true,
        ok: true,
        id: info.result.id,
        username: info.result.username ?? "",
        name: info.result.first_name ?? "",
    });
});
// GET /notify/bot/chats -- chat ids the bot has heard from lately, for filling in the
// default target. Telegram only keeps recent updates, so an empty list usually means
// "message the bot and try again".
router.get("/notify/bot/chats", async (req, res) => {
    const token = resolveBotToken(req.query);
    if (!token) {
        res.status(400).json({ ok: false, error: "No bot token configured" });
        return;
    }
    const chats = await (0, notify_1.recentBotChats)(token);
    if (!chats.ok) {
        res.status(502).json({ ok: false, error: chats.error });
        return;
    }
    res.json({ ok: true, chats: chats.result });
});
// POST /notify/bot/test -- send a real message now. The only check that proves the whole
// path: token valid, host can reach the Bot API, and the target has started the bot.
router.post("/notify/bot/test", async (req, res) => {
    const token = resolveBotToken(req.body);
    const cfg = (0, notify_1.getNotifyConfig)();
    const target = req.body?.target?.trim() || cfg.botTarget;
    if (!token) {
        res.status(400).json({ ok: false, error: "No bot token configured" });
        return;
    }
    if (!target) {
        res.status(400).json({ ok: false, error: "No notification target configured" });
        return;
    }
    try {
        await (0, notify_1.sendBotNotify)(token, target, "🔔 Bemby test notification");
        res.json({ ok: true });
    }
    catch (err) {
        res.status(502).json({ ok: false, error: err?.message ?? "Send failed" });
    }
});
// ── Proxy providers ───────────────────────────────────────────────────────────
// Configured proxy sellers whose current list can be pulled into the proxies setting.
// API keys are never sent back to the client; a `hasKey` flag stands in for them.
router.get("/proxy-providers", (_req, res) => {
    res.json({ providers: (0, proxyProviders_1.providersForClient)() });
});
router.put("/proxy-providers", (req, res) => {
    const { providers } = req.body;
    if (!Array.isArray(providers)) {
        res.status(400).json({ error: "providers array is required" });
        return;
    }
    const seen = new Set();
    for (const p of providers) {
        if (!p?.id?.trim() || !p?.name?.trim()) {
            res.status(400).json({ error: "Each provider needs an id and a name" });
            return;
        }
        if (p.type !== "webshare" && p.type !== "list") {
            res.status(400).json({ error: `Unsupported provider type "${p.type}"` });
            return;
        }
        if (p.type === "list" && !p.url?.trim()) {
            res.status(400).json({ error: `"${p.name}" needs a list URL` });
            return;
        }
        if (seen.has(p.id)) {
            res.status(400).json({ error: "Provider ids must be unique" });
            return;
        }
        seen.add(p.id);
    }
    (0, proxyProviders_1.saveProviders)(providers);
    res.json({ providers: (0, proxyProviders_1.providersForClient)() });
});
// Pull the current lists in. `providerId` syncs a single provider; otherwise every
// enabled one is synced. Manual proxies, and imports from providers that were not
// synced, are preserved.
router.post("/proxy-providers/sync", async (req, res) => {
    const { providerId } = req.body;
    try {
        const result = await (0, proxyProviders_1.syncProviders)(providerId?.trim() || undefined);
        res.json({ ok: true, ...result });
    }
    catch (err) {
        res.status(502).json({ ok: false, error: err?.message ?? "Sync failed" });
    }
});
// Test TCP reachability through a SOCKS proxy (target: 1.1.1.1:80)
router.post("/test-proxy", async (req, res) => {
    const { url } = req.body;
    if (!url) {
        res.status(400).json({ error: "url is required" });
        return;
    }
    const proxy = (0, runner_1.parseTgProxy)(url);
    if (!proxy) {
        res
            .status(400)
            .json({ error: "Invalid proxy URL — use socks5:// or socks4://" });
        return;
    }
    try {
        const result = await socks_1.SocksClient.createConnection({
            proxy: {
                host: proxy.ip,
                port: proxy.port,
                type: proxy.socksType,
                ...(proxy.username
                    ? { userId: proxy.username, password: proxy.password }
                    : {}),
            },
            command: "connect",
            destination: { host: "1.1.1.1", port: 80 },
            timeout: 6000,
        });
        result.socket.destroy();
        res.json({ ok: true });
    }
    catch (err) {
        res.json({ ok: false, error: err.message ?? "Connection failed" });
    }
});
exports.default = router;
