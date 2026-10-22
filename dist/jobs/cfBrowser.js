"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CF_BROWSER_LANG_KEY = void 0;
exports.cloakCacheDir = cloakCacheDir;
exports.cfBrowserLang = cfBrowserLang;
exports.checkCfLicenseKey = checkCfLicenseKey;
exports.chromiumExecutable = chromiumExecutable;
exports.isChromiumInstalled = isChromiumInstalled;
exports.installedBuildTier = installedBuildTier;
exports.keyedBuildPending = keyedBuildPending;
exports.chromiumVersion = chromiumVersion;
exports.chromiumPath = chromiumPath;
exports.installedCfBuilds = installedCfBuilds;
exports.installCfChromium = installCfChromium;
exports.clearCfProfiles = clearCfProfiles;
exports.cfProfileCount = cfProfileCount;
exports.removeAllCfBuilds = removeAllCfBuilds;
exports.cfBrowsersRunning = cfBrowsersRunning;
exports.stopAllCfBrowsers = stopAllCfBrowsers;
exports.launchCfBrowser = launchCfBrowser;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_net_1 = __importDefault(require("node:net"));
const node_os_1 = __importDefault(require("node:os"));
const node_crypto_1 = require("node:crypto");
const node_child_process_1 = require("node:child_process");
const socks_1 = require("socks");
const cfTuning_1 = require("./cfTuning");
const cfFonts_1 = require("./cfFonts");
const cfLicense_1 = require("./cfLicense");
const database_1 = require("../db/database");
const paths_1 = require("./paths");
const proxyProviders_1 = require("../tg/proxyProviders");
// The browser behind the Cloudflare solver: CloakBrowser, a Chromium built with
// source-level fingerprint patches (canvas, WebGL, audio, fonts, WebRTC, TLS,
// navigator.webdriver) and driven through Playwright. Nothing here decides whether a
// challenge passed -- that is cloudflare.ts; this module only produces a page to work with.
//
// The image ships without a browser to stay small. The stealth binary (~200MB) is
// downloaded on demand into the data dir, which is a volume, so it survives a restart and
// an upgrade.
/**
 * Where CloakBrowser caches its Chromium builds: a data-dir subfolder, unless the operator
 * has pointed the library somewhere else. Honouring the override here too keeps what the
 * settings page reports as installed in step with what the library actually downloads.
 */
function cloakCacheDir() {
    return process.env.CLOAKBROWSER_CACHE_DIR || node_path_1.default.join((0, paths_1.dataDir)(), "cloakbrowser");
}
/** Settings key holding the locale the browser reports, when it is not left to the exit. */
exports.CF_BROWSER_LANG_KEY = "cf_browser_lang";
/**
 * The locale the browser should report, when the operator has pinned one.
 *
 * Normally this follows the country the exit comes out in, which is what keeps the browser
 * consistent with its IP. Pinning it is for the case that outweighs that: an app which
 * renders in whatever language the browser asks for, where a step naming a control by its
 * Chinese wording only ever finds it if the app is speaking Chinese.
 */
function cfBrowserLang() {
    try {
        const row = database_1.db.prepare("SELECT value FROM settings WHERE key = ?").get(exports.CF_BROWSER_LANG_KEY);
        return row?.value?.trim() || undefined;
    }
    catch {
        return undefined;
    }
}
/** Data-dir subfolder holding one browser profile per exit. */
function cfProfilesRoot() {
    return node_path_1.default.join((0, paths_1.dataDir)(), "cf-profiles");
}
/**
 * CloakBrowser is configured through the environment, so it is set up before any call into
 * the library. Anything the operator has already set is left alone.
 *
 * Auto-update is off: left on, the library downloads a new 200MB build in the background
 * the moment a job launches a browser, onto the user's data volume and over whatever
 * bandwidth the job is using. Settings has a Reinstall button for that instead.
 */
function applyCloakEnv() {
    if (!process.env.CLOAKBROWSER_CACHE_DIR)
        process.env.CLOAKBROWSER_CACHE_DIR = cloakCacheDir();
    if (!process.env.CLOAKBROWSER_AUTO_UPDATE)
        process.env.CLOAKBROWSER_AUTO_UPDATE = "false";
}
const importEsm = new Function("specifier", "return import(specifier)");
let cloakModule;
function cloak() {
    applyCloakEnv();
    cloakModule ?? (cloakModule = importEsm("cloakbrowser"));
    return cloakModule;
}
/**
 * Asks CloakBrowser's server what a licence key is worth. A key that was mistyped or has
 * lapsed otherwise shows up only as jobs quietly running the older free build.
 */
async function checkCfLicenseKey(key) {
    try {
        const { validateLicense } = await cloak();
        const info = await validateLicense(key);
        if (!info)
            return { valid: false, error: "CloakBrowser could not be reached" };
        return { valid: info.valid, plan: info.plan, expires: info.expires ?? undefined };
    }
    catch (err) {
        return { valid: false, error: err?.message ?? String(err) };
    }
}
/** Segments of a CloakBrowser version ("146.0.7680.177.5"), for comparing installs. */
function versionParts(v) {
    return v.split(".").map((n) => Number(n) || 0);
}
function versionNewer(a, b) {
    const [x, y] = [versionParts(a), versionParts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0))
            return (x[i] ?? 0) > (y[i] ?? 0);
    }
    return false;
}
/**
 * The stealth Chromium builds in the cache dir. Read off the filesystem rather than asked
 * of the library, so the settings page can report what is installed without an async call
 * -- and without the library reaching out to check for an update.
 *
 * A keyed build unpacks into a `-pro` directory whether the key is free or paid.
 */
function cachedBuilds() {
    // The layout CloakBrowser unpacks into. Linux is what the image runs; the others are
    // for a developer machine.
    const exeName = process.platform === "darwin"
        ? "Chromium.app/Contents/MacOS/Chromium"
        : process.platform === "win32"
            ? "chrome.exe"
            : "chrome";
    const out = [];
    try {
        for (const name of (0, node_fs_1.readdirSync)(cloakCacheDir())) {
            const match = /^chromium-([\d.]+)(-pro)?$/.exec(name);
            if (!match)
                continue;
            const exe = node_path_1.default.join(cloakCacheDir(), name, exeName);
            // A directory with no executable is what a download that died halfway leaves behind
            if (!(0, node_fs_1.existsSync)(exe))
                continue;
            out.push({ version: match[1], tier: match[2] ? "keyed" : "free", exe });
        }
    }
    catch {
        return [];
    }
    return out.sort((a, b) => (versionNewer(a.version, b.version) ? -1 : 1));
}
/** The build that would launch for `tier`, falling back to whatever is installed. */
function resolvedBuild(tier) {
    const builds = cachedBuilds();
    if (!tier)
        return builds[0];
    const exact = builds.find((b) => b.tier === tier);
    if (exact)
        return exact;
    // Standing in for the tier asked for is only safe one way round. A free build handed a
    // key ignores it and runs; the keyed build asked to run without one refuses and quits
    // during startup, which reaches the operator as a browser that closed itself with no
    // stated reason and a page of Chromium log. So "free" is never served the keyed build.
    return tier === "keyed" ? builds.find((b) => b.tier === "free") : undefined;
}
/**
 * A CloakBrowser binary the operator pinned themselves, which is how an older build is
 * rolled back to. The library reads this variable directly as well, so honouring it here
 * only keeps the settings page in step with what will launch.
 */
function pinnedBinary() {
    const pin = process.env.CLOAKBROWSER_BINARY_PATH;
    return pin && (0, node_fs_1.existsSync)(pin) ? pin : undefined;
}
// The previous solver launched whatever PUPPETEER_EXECUTABLE_PATH named, and installs that
// were set up then still carry it. It is deliberately not honoured any more: a stock
// Chromium has none of the fingerprint patches, so a job pointed at one is not solving
// anything -- it just looks like it is.
let warnedLegacyPin = false;
function warnLegacyPin() {
    if (warnedLegacyPin || !process.env.PUPPETEER_EXECUTABLE_PATH)
        return;
    warnedLegacyPin = true;
    console.warn(`[cfBrowser] ignoring PUPPETEER_EXECUTABLE_PATH (${process.env.PUPPETEER_EXECUTABLE_PATH}): ` +
        "the solver only launches CloakBrowser builds. Remove it from your .env, and delete " +
        "the browser it points at to reclaim the space.");
}
/**
 * The browser that will launch: the operator's pin, else the downloaded stealth build of
 * the tier matching whether a licence key is in hand -- a keyed build declines to run
 * without one.
 */
function chromiumExecutable(tier) {
    warnLegacyPin();
    return pinnedBinary() ?? resolvedBuild(tier)?.exe;
}
function isChromiumInstalled() {
    return !!chromiumExecutable();
}
/** Tier of the build that is installed, for the settings view. */
function installedBuildTier() {
    if (pinnedBinary())
        return undefined;
    return resolvedBuild()?.tier;
}
/**
 * A licence key is configured but the build it unlocks has not been downloaded, so jobs
 * are still launching the older free one. Downloading is deliberate rather than automatic
 * (see the launch pin), so this is what tells the operator there is something to fetch.
 */
function keyedBuildPending() {
    if (pinnedBinary())
        return false;
    const hasKey = !!process.env.CLOAKBROWSER_LICENSE_KEY?.trim() || (0, cfLicense_1.cfLicenseUsage)().total > 0;
    return hasKey && !cachedBuilds().some((build) => build.tier === "keyed");
}
/**
 * Version of the browser that will launch, e.g. "CloakBrowser 150.0.7871.114.4".
 *
 * Read from the directory the build was unpacked into rather than by running it: the
 * keyed build refuses to start without its licence key, and the key lives in the database
 * rather than this process's environment, so asking the binary reports nothing at all --
 * which is how the settings page ended up naming the build it had replaced.
 */
function chromiumVersion() {
    const build = resolvedBuild();
    if (build && !pinnedBinary())
        return `CloakBrowser ${build.version}`;
    // A pinned binary has no version in its path, so it has to be asked
    const exe = pinnedBinary();
    if (!exe)
        return undefined;
    try {
        const out = (0, node_child_process_1.spawnSync)(exe, ["--version"], { encoding: "utf8", timeout: 15000 });
        return `${out.stdout ?? ""}`.trim().split("\n")[0] || undefined;
    }
    catch {
        return undefined;
    }
}
/** Path of the browser that will launch, so the settings page can name it exactly. */
function chromiumPath() {
    return chromiumExecutable();
}
/**
 * Every downloaded build, for the settings page. Both tiers can be on disk at once -- the
 * keyed one for normal runs, the unlicensed one for when no seat is free -- and a job may
 * use either, so reporting only the preferred one hides half of what is installed.
 */
function installedCfBuilds() {
    const builds = cachedBuilds();
    const preferred = resolvedBuild()?.exe;
    return builds.map((b) => ({
        tier: b.tier,
        version: b.version,
        path: b.exe,
        preferred: b.exe === preferred,
    }));
}
/**
 * Downloads the stealth Chromium into the data dir. Long-running (~200MB) but needs no
 * root: it writes to the data volume as the app's own user.
 *
 * `force` clears the cache first, which is how the browser is moved to a newer build.
 */
/**
 * Downloads a build into the data dir.
 *
 * `tier` names which one: "keyed" (or unset) follows the configured licence keys, "free"
 * fetches the unlicensed build regardless of them. Having the free build alongside the
 * keyed one is what lets a launch that cannot take a licence seat still run -- the keyed
 * binary refuses to start without one, so with only that on disk there is no fallback.
 */
async function installCfChromium(force = false, tier) {
    applyCloakEnv();
    const lines = [];
    const cacheDir = process.env.CLOAKBROWSER_CACHE_DIR || cloakCacheDir();
    try {
        (0, node_fs_1.mkdirSync)(cacheDir, { recursive: true });
    }
    catch (err) {
        return { ok: false, output: `Cannot write to ${cacheDir}: ${err?.message ?? err}` };
    }
    // Checked before the download rather than during it: the library streams straight to a
    // file, and a write that fails part-way surfaces as an unhandled stream error, which
    // takes the whole backend down rather than failing this request.
    try {
        (0, node_fs_1.accessSync)(cacheDir, node_fs_1.constants.W_OK);
    }
    catch {
        return {
            ok: false,
            output: `Cannot write to ${cacheDir}. The browser is downloaded into the data dir, so that ` +
                "directory has to be writable by the user this app runs as -- check its ownership.",
        };
    }
    // Any configured key will do here: which build is downloaded is the same question for
    // all of them, and this is not a browser session, so it takes no seat. Asking for the
    // free build deliberately ignores them -- that is the point of the request.
    const licenseKey = tier === "free" ? undefined : (0, cfLicense_1.anyCfLicenseKey)();
    try {
        const { ensureBinary, binaryInfo } = await cloak();
        // Only the build being replaced is cleared, not the whole cache: the other tier is
        // what an overflow launch falls back to, and re-downloading it is another 200MB.
        if (force) {
            const dropped = removeBuild(licenseKey ? "keyed" : "free");
            lines.push(dropped ? `Cleared ${dropped}` : "Nothing cached to clear");
        }
        const exe = await ensureBinary(licenseKey);
        const info = binaryInfo();
        lines.push(`CloakBrowser ${info.version} (${info.tier} build) at ${exe}`);
        if (!licenseKey && tier !== "free") {
            lines.push("No licence key configured, so this is the older free build. Add a free key in " +
                "Settings for the current one, which passes more challenges.");
        }
        if (tier === "free") {
            lines.push("This is the unlicensed build, kept alongside the keyed one. A run that cannot " +
                "take a licence seat falls back to it instead of failing.");
        }
    }
    catch (err) {
        return { ok: false, output: `${lines.join("\n")}\n${err?.message ?? err}`.trim() };
    }
    if (!isChromiumInstalled()) {
        return { ok: false, output: `${lines.join("\n")}\nThe download finished but no browser is in ${cloakCacheDir()}` };
    }
    const version = chromiumVersion();
    if (version)
        lines.push(version);
    const dropped = pruneOldBuilds();
    if (dropped)
        lines.push(dropped);
    const reclaimed = pruneLegacyBrowsers();
    if (reclaimed)
        lines.push(reclaimed);
    return { ok: true, output: lines.join("\n") };
}
/** Drops the cached build of one tier, so the next install fetches it again. */
function removeBuild(tier) {
    const build = cachedBuilds().find((b) => b.tier === tier);
    if (!build)
        return undefined;
    const dir = node_path_1.default.dirname(build.exe);
    try {
        (0, node_fs_1.rmSync)(dir, { recursive: true, force: true });
    }
    catch (err) {
        console.warn(`[cfBrowser] could not remove ${dir}: ${err?.message ?? err}`);
        return undefined;
    }
    return node_path_1.default.basename(dir);
}
/**
 * Keeps the newest build of each tier and drops the rest. An update leaves the build it
 * replaced behind, and each is several hundred MB unpacked, which on a self-hosted volume
 * adds up fast. Both tiers are kept because which one launches depends on whether a
 * licence key is free at the time.
 */
/**
 * Deletes every browser profile: the cookies, cache and site data each exit has built up.
 *
 * Worth having as a button because a profile is the one piece of state a run carries over
 * from the last one, so it is what to clear when a browser has started failing for no
 * reason that changed elsewhere -- a half-written profile from a browser that was killed
 * can keep Chromium from starting at all. Nothing identifying is lost: the fingerprint
 * comes from a seed derived from the exit, not from the profile, so each exit comes back
 * as the same machine.
 */
function clearCfProfiles() {
    if (liveBrowsers.size > 0) {
        return {
            removed: 0,
            error: `${liveBrowsers.size} browser(s) are still running and are using their profiles. ` +
                "Stop the browsers first, then try again.",
        };
    }
    let names;
    try {
        names = (0, node_fs_1.readdirSync)(cfProfilesRoot());
    }
    catch (err) {
        // A missing directory is nothing to clear rather than a failure
        if (err?.code === "ENOENT")
            return { removed: 0 };
        return { removed: 0, error: `Could not read ${cfProfilesRoot()}: ${err?.message ?? err}` };
    }
    // Each profile stands alone, so one that cannot be removed must not hold up the rest --
    // clearing the others is the point of the exercise.
    let removed = 0;
    const failed = [];
    let firstError = "";
    for (const name of names) {
        try {
            (0, node_fs_1.rmSync)(node_path_1.default.join(cfProfilesRoot(), name), { recursive: true, force: true });
            removed++;
        }
        catch (err) {
            failed.push(name);
            firstError || (firstError = err?.message ?? String(err));
        }
    }
    profilesInUse.clear();
    if (failed.length) {
        return {
            removed,
            error: `${removed} cleared, ${failed.length} could not be removed (${firstError})`,
        };
    }
    return { removed };
}
/** How many browser profiles are on disk, for the settings page. */
function cfProfileCount() {
    try {
        return (0, node_fs_1.readdirSync)(cfProfilesRoot()).length;
    }
    catch {
        return 0;
    }
}
/**
 * Deletes every downloaded build, freeing the ~200MB each takes in the data dir. The
 * solver has nothing to launch afterwards, so this is the counterpart of the download
 * button rather than something a job ever does.
 */
function removeAllCfBuilds() {
    if (liveBrowsers.size > 0) {
        return {
            removed: [],
            error: `${liveBrowsers.size} browser(s) are still running. Wait for those jobs to finish, ` +
                "or stop the browsers first, then try again.",
        };
    }
    const removed = [];
    for (const build of cachedBuilds()) {
        const dir = node_path_1.default.dirname(build.exe);
        try {
            (0, node_fs_1.rmSync)(dir, { recursive: true, force: true });
            removed.push(node_path_1.default.basename(dir));
        }
        catch (err) {
            return { removed, error: `Could not remove ${dir}: ${err?.message ?? err}` };
        }
    }
    return { removed };
}
function pruneOldBuilds() {
    const keep = new Set(["keyed", "free"]
        .map((tier) => cachedBuilds().find((b) => b.tier === tier))
        .filter((b) => !!b)
        .map((b) => node_path_1.default.dirname(b.exe)));
    if (!keep.size)
        return undefined;
    const dropped = [];
    try {
        for (const name of (0, node_fs_1.readdirSync)(cloakCacheDir())) {
            if (!/^chromium-/.test(name))
                continue;
            const full = node_path_1.default.join(cloakCacheDir(), name);
            if (keep.has(full))
                continue;
            (0, node_fs_1.rmSync)(full, { recursive: true, force: true });
            dropped.push(name);
        }
    }
    catch {
        /* housekeeping only */
    }
    return dropped.length ? `Removed ${dropped.length} superseded build(s): ${dropped.join(", ")}` : undefined;
}
/**
 * Removes the browsers earlier versions installed: the Playwright download and the
 * Alpine-era apk root. Both are caches this app wrote and no longer launches, and between
 * them they are most of a gigabyte on the user's volume.
 */
function pruneLegacyBrowsers() {
    const stale = ["pw-browsers", ".pw-browsers", "cf-chromium"]
        .map((name) => node_path_1.default.join((0, paths_1.dataDir)(), name))
        .filter((dir) => (0, node_fs_1.existsSync)(dir));
    if (!stale.length)
        return undefined;
    for (const dir of stale) {
        try {
            (0, node_fs_1.rmSync)(dir, { recursive: true, force: true });
        }
        catch (err) {
            console.warn(`[cfBrowser] could not remove ${dir}: ${err?.message ?? err}`);
        }
    }
    return `Removed the browser left by the previous solver (${stale.map((d) => node_path_1.default.basename(d)).join(", ")})`;
}
// ── Virtual display ──────────────────────────────────────────────────────────
//
// The browser runs headed: a challenge is scored on far more than the headless flag, and
// the pass rate headed is not close. On a server there is no display, so one Xvfb is
// started for the process and every browser shares it.
let displayPromise;
function displaySocket(display) {
    return `/tmp/.X11-unix/X${display.replace(/^:/, "").split(".")[0]}`;
}
/** The desktop the browser opens on when nothing asks for more room. */
const DEFAULT_SCREEN = { width: 1920, height: 1080 };
/**
 * The window geometry the settings ask for, or undefined for Chromium's own choice.
 *
 * Both numbers are needed: half a size is not a window. Anything implausibly small is
 * ignored rather than clamped -- a 100px window renders a mobile layout nothing on the page
 * expects, and silently correcting it would hide the typo.
 */
function configuredWindow() {
    const { windowWidth: width, windowHeight: height } = (0, cfTuning_1.cfTuning)();
    if (width < 400 || height < 400)
        return undefined;
    return { width, height };
}
/** The screen this process started, so a window asking for more room can be reported. */
let startedScreen;
/**
 * One X server serves the whole process and it is sized when the first browser launches, so
 * a size raised afterwards has nothing to grow into and the window is clipped to the screen.
 * Silently rendering shorter than asked is the confusing outcome; saying so is not.
 */
function warnIfWindowExceedsScreen(win) {
    if (!win || !startedScreen)
        return;
    if (win.width <= startedScreen.width && win.height + 140 <= startedScreen.height)
        return;
    console.warn(`[cfBrowser] the window size in settings (${win.width}x${win.height}) does not fit the ` +
        `virtual screen already running (${startedScreen.width}x${startedScreen.height}), so the ` +
        "page will be clipped to it. Restart the app to start a screen that holds it.");
}
/**
 * Starts one X server on a free display number. The socket appearing is what proves it
 * came up: a process that died is still an unreaped child that looks alive.
 */
async function startXvfb() {
    for (let n = 99; n < 110; n++) {
        const display = `:${n}`;
        if ((0, node_fs_1.existsSync)(displaySocket(display)))
            continue;
        // Sized to the desktop the stealth build reports to a page, so the window it opens
        // sits inside a screen of a plausible size rather than filling a small one. A window
        // configured taller or wider than that gets a screen grown to hold it: one that does not
        // fit is clipped, and the page then renders shorter than the size that was asked for.
        const want = configuredWindow();
        const width = Math.max(DEFAULT_SCREEN.width, want?.width ?? 0);
        // Room for the window frame and the browser's own chrome above the page
        const height = Math.max(DEFAULT_SCREEN.height, (want?.height ?? 0) + 140);
        const proc = (0, node_child_process_1.spawn)("Xvfb", [display, "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp"], { stdio: "ignore" });
        // Not on the path at all, as opposed to started and then exited
        let missing = false;
        const died = new Promise((resolve) => {
            proc.once("error", () => {
                missing = true;
                resolve(false);
            });
            proc.once("exit", () => resolve(false));
        });
        const up = (async () => {
            for (let i = 0; i < 40; i++) {
                if ((0, node_fs_1.existsSync)(displaySocket(display)))
                    return true;
                await new Promise((r) => setTimeout(r, 200));
            }
            return false;
        })();
        if (await Promise.race([died, up])) {
            // Killed with the app so a restart does not leave X servers behind
            process.once("exit", () => proc.kill());
            startedScreen = { width, height };
            console.log(`[cfBrowser] started Xvfb on ${display} at ${width}x${height}`);
            return display;
        }
        proc.kill();
        if (missing)
            break; // trying other display numbers cannot help
    }
    return undefined;
}
/**
 * A display for the headed browser: the one already in the environment, else an Xvfb of
 * our own. Undefined when there is none to be had, which leaves the browser headless --
 * it still runs, it just passes fewer challenges.
 */
async function ensureDisplay() {
    displayPromise ?? (displayPromise = (async () => {
        const existing = process.env.DISPLAY;
        if (existing && (0, node_fs_1.existsSync)(displaySocket(existing)))
            return existing;
        const started = await startXvfb();
        if (!started) {
            console.warn("[cfBrowser] no X display and Xvfb could not be started; the browser will run " +
                "headless, which passes fewer challenges. Install xvfb on the host.");
            return undefined;
        }
        process.env.DISPLAY = started;
        return started;
    })());
    return displayPromise;
}
// ── Profiles ─────────────────────────────────────────────────────────────────
//
// One profile per exit, so cookies -- above all the cf_clearance a solved challenge issues
// -- outlive the browser. Without one every attempt arrives as a first-time visitor, which
// is exactly what a managed challenge is looking for.
/**
 * Stable id for an exit, used to name its profile and remember its geography. The proxy
 * URL is hashed rather than stored: it carries credentials, and this ends up on disk.
 */
function exitKey(proxyUrl) {
    return proxyUrl ? (0, node_crypto_1.createHash)("sha1").update(proxyUrl).digest("hex").slice(0, 12) : "direct";
}
/**
 * The device fingerprint seed for an exit. CloakBrowser picks a random one per launch,
 * which would hand the same site a different machine every run -- while the profile hands
 * it the same cookies. Derived from the exit key instead, so an exit keeps one identity
 * for as long as its profile does.
 */
function fingerprintSeed(key) {
    const digest = (0, node_crypto_1.createHash)("sha1").update(`bemby-fingerprint:${key}`).digest();
    return 10000 + (digest.readUInt32BE(0) % 90000);
}
// One Chromium at a time per profile: two sharing a user-data-dir corrupt it, and jobs can
// run concurrently. The loser of the race gets a throwaway profile instead.
const profilesInUse = new Set();
// Chromium writes inside Default/, which leaves the profile's own mtime at creation time,
// so last use is recorded here instead.
const USED_MARKER = ".bemby-last-used";
function lastUsedAt(dir) {
    try {
        return (0, node_fs_1.statSync)(node_path_1.default.join(dir, USED_MARKER)).mtimeMs;
    }
    catch {
        try {
            return (0, node_fs_1.statSync)(dir).mtimeMs;
        }
        catch {
            return 0;
        }
    }
}
/** Drops the least recently used profiles, keeping the newest maxProfiles of them. */
function pruneProfiles(root) {
    const tune = (0, cfTuning_1.cfTuning)();
    try {
        const dirs = (0, node_fs_1.readdirSync)(root)
            .filter((name) => !profilesInUse.has(name) && !name.startsWith("tmp-"))
            .map((name) => ({ full: node_path_1.default.join(root, name), usedAt: lastUsedAt(node_path_1.default.join(root, name)) }))
            .sort((a, b) => b.usedAt - a.usedAt);
        for (const stale of dirs.slice(tune.maxProfiles)) {
            (0, node_fs_1.rmSync)(stale.full, { recursive: true, force: true });
        }
    }
    catch {
        /* housekeeping only */
    }
}
/**
 * The profile directory for this exit. When it is already open elsewhere -- or cannot be
 * created -- a throwaway one is used instead, which is thrown away with the browser.
 */
function claimProfile(key) {
    const throwaway = () => {
        const root = (0, node_fs_1.existsSync)(cfProfilesRoot()) ? cfProfilesRoot() : node_os_1.default.tmpdir();
        const dir = (0, node_fs_1.mkdtempSync)(node_path_1.default.join(root, "tmp-"));
        return { dir, release: () => (0, node_fs_1.rmSync)(dir, { recursive: true, force: true }) };
    };
    if (profilesInUse.has(key))
        return throwaway();
    const dir = node_path_1.default.join(cfProfilesRoot(), key);
    try {
        (0, node_fs_1.mkdirSync)(dir, { recursive: true });
        // A browser that was killed leaves these behind, and Chromium then refuses the profile
        // as "already in use"
        for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
            (0, node_fs_1.rmSync)(node_path_1.default.join(dir, lock), { force: true });
        }
        (0, node_fs_1.writeFileSync)(node_path_1.default.join(dir, USED_MARKER), "");
        profilesInUse.add(key);
        pruneProfiles(cfProfilesRoot());
        return { dir, release: () => profilesInUse.delete(key) };
    }
    catch (err) {
        console.warn(`[cfBrowser] no persistent profile (${err?.message ?? err})`);
        return throwaway();
    }
}
/**
 * A loopback HTTP proxy in front of an authenticated SOCKS5 exit, for the browser's
 * lifetime. Chromium's own SOCKS support is the one part of the proxy chain that varies by
 * build, and Bemby's proxies are almost all socks5://user:pass@host:port -- bridging them
 * keeps that off the critical path. Only CONNECT is handled; challenge pages are https.
 */
function startSocksBridge(url) {
    const proxy = {
        host: url.hostname,
        port: Number(url.port),
        type: (url.protocol === "socks4:" ? 4 : 5),
        userId: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
    };
    const sockets = new Set();
    const server = node_net_1.default.createServer((client) => {
        sockets.add(client);
        client.on("close", () => sockets.delete(client));
        client.on("error", () => client.destroy());
        client.once("data", async (chunk) => {
            const head = chunk.toString("latin1");
            const target = head.match(/^CONNECT\s+([^\s:]+):(\d+)/i);
            if (!target) {
                client.end("HTTP/1.1 405 Method Not Allowed\r\n\r\n");
                return;
            }
            try {
                const { socket } = await socks_1.SocksClient.createConnection({
                    proxy,
                    command: "connect",
                    // Hostname is passed through so the proxy resolves it, as socks5h does
                    destination: { host: target[1], port: Number(target[2]) },
                });
                sockets.add(socket);
                socket.on("close", () => sockets.delete(socket));
                socket.on("error", () => socket.destroy());
                client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
                socket.pipe(client);
                client.pipe(socket);
            }
            catch {
                client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
            }
        });
    });
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;
            resolve({
                port,
                close: () => {
                    for (const socket of sockets)
                        socket.destroy();
                    server.close();
                },
            });
        });
    });
}
/** The proxy CloakBrowser is launched with, plus whatever has to be shut down after. */
async function resolveProxy(proxyUrl) {
    if (!proxyUrl)
        return { close: () => { } };
    let url;
    try {
        url = new URL(proxyUrl);
    }
    catch {
        console.warn("[cfBrowser] proxy URL could not be parsed; going out direct");
        return { close: () => { } };
    }
    if (!/^socks/i.test(url.protocol) || !url.username)
        return { proxy: proxyUrl, close: () => { } };
    try {
        const bridge = await startSocksBridge(url);
        return { proxy: `http://127.0.0.1:${bridge.port}`, close: bridge.close };
    }
    catch (err) {
        console.error(`[cfBrowser] SOCKS bridge failed: ${err?.message ?? err}`);
        return { close: () => { } };
    }
}
// ── Launch ───────────────────────────────────────────────────────────────────
/**
 * Runs `launch` with the library pointed at a binary already on disk.
 *
 * `CLOAKBROWSER_BINARY_PATH` is the only thing that stops the library resolving a binary
 * of its own -- passing an executable through the launch options overrides which one
 * finally starts, but the resolve (and, with nothing cached for that tier, a ~200MB
 * download) has already happened by then. That download would land in the middle of a
 * job, over the connection the job is using.
 *
 * Launches are serialised through here because the setting is process-wide and two
 * concurrent ones can want different tiers. The section covers the launch call only, so
 * the queue is a second or two, and the previous value is put back for the settings page.
 */
let launchGate = Promise.resolve();
function withBinaryPin(exe, launch) {
    const run = launchGate.then(async () => {
        const previous = process.env.CLOAKBROWSER_BINARY_PATH;
        if (exe)
            process.env.CLOAKBROWSER_BINARY_PATH = exe;
        try {
            return await launch();
        }
        finally {
            if (previous === undefined)
                delete process.env.CLOAKBROWSER_BINARY_PATH;
            else
                process.env.CLOAKBROWSER_BINARY_PATH = previous;
        }
    });
    launchGate = run.catch(() => { });
    return run;
}
/**
 * Launches the stealth browser for one exit: headed on the shared display, on that exit's
 * own profile, with the clock and language of the country the exit comes out in.
 *
 * Timezone and locale are passed to CloakBrowser rather than emulated over CDP, because
 * the binary applies them as launch flags -- CDP emulation is itself detectable.
 */
/** Ceiling on a browser shutdown, so a wedged one cannot hold its licence seat. */
const CLOSE_TIMEOUT_MS = 10000;
/** Stands in for a lease where none is taken, so the launch path stays one shape. */
const NO_LEASE = { release: () => { } };
// Browsers currently up. A free-build launch takes no licence seat, so seat usage does not
// answer "is anything running" -- and removing a binary, or stopping the lot by hand, both
// need to know. Held as the browsers themselves so they can be closed on request.
const liveBrowsers = new Set();
/** How many solver browsers are open right now. */
function cfBrowsersRunning() {
    return liveBrowsers.size;
}
/**
 * Closes every open solver browser. The jobs holding them fail as their pages go, which is
 * the point: this is the way out when a run has wedged and is sitting on a licence seat,
 * a profile, or a proxy that nothing else can have until it lets go.
 */
async function stopAllCfBrowsers() {
    const open = [...liveBrowsers];
    // close() releases the seat, profile and proxy, and is bounded, so one wedged browser
    // cannot hold up the rest
    await Promise.all(open.map((b) => b.close().catch(() => { })));
    return { stopped: open.length };
}
async function launchCfBrowser(proxyUrl, opts = {}) {
    const tune = (0, cfTuning_1.cfTuning)();
    if (!isChromiumInstalled()) {
        throw new Error("The Cloudflare solver browser is not installed. Enable it in Settings to download it into the data dir.");
    }
    // Before the browser is spawned: fontconfig is read from the environment it inherits.
    // A browser with no fonts measures text like nothing else on the web, which is exactly
    // the sort of thing a challenge scores against.
    (0, cfFonts_1.applyCfFontEnv)();
    const display = await ensureDisplay();
    const win = configuredWindow();
    warnIfWindowExceedsScreen(win);
    const key = exitKey(proxyUrl);
    const geo = (0, proxyProviders_1.cfExitGeo)(key);
    const locale = cfBrowserLang() ?? geo?.lang;
    const profile = claimProfile(key);
    const proxy = await resolveProxy(proxyUrl);
    // The keyed build first, on a seat of its own: one licence key is one concurrent
    // session, so a seat is held for as long as this browser lives.
    //
    // When every seat is out, what to do next depends on what is on disk. With the
    // unlicensed build installed, run on that straight away -- it needs no session, and
    // holding the job for a seat that may not come free inside its budget buys nothing over
    // an older build that starts now. With only the keyed build there, waiting is the only
    // option, since it refuses to start without a key at all.
    // A forced free build takes no seat: it needs no licence, and holding one would keep it
    // from a run that does.
    let lease = opts.tier === "free" ? NO_LEASE : await (0, cfLicense_1.leaseCfLicenseKey)();
    if (opts.tier === "keyed" && !lease.key) {
        proxy.close();
        profile.release();
        throw new Error((0, cfLicense_1.cfLicenseUsage)().total
            ? "Every licence seat is in use right now, so the keyed build cannot be started for this test."
            : "No licence key is configured, so there is no keyed build to test.");
    }
    const freeBuild = chromiumExecutable("free");
    if (!lease.key && opts.tier !== "free" && (0, cfLicense_1.cfLicenseUsage)().total) {
        if (freeBuild) {
            console.log("[cfBrowser] every licence seat is taken; running this one on the free build");
        }
        else {
            console.log("[cfBrowser] every licence seat is taken; waiting for one to free up");
            lease = await (0, cfLicense_1.leaseCfLicenseKey)(tune.budgetMs);
            if (!lease.key) {
                console.warn("[cfBrowser] no licence seat came free, and there is no free build to fall back " +
                    "on. Add another key in Settings, or install the free build alongside it.");
            }
        }
    }
    // The build that matches whether a key is in hand: a keyed binary declines to run
    // without one, and a free one has no use for it
    const executablePath = chromiumExecutable(opts.tier ?? (lease.key ? "keyed" : "free"));
    if (!executablePath) {
        proxy.close();
        profile.release();
        lease.release();
        throw new Error("No licence seat was free and there is no unlicensed build installed to fall back " +
            "on, so nothing here can run: the keyed build refuses to start without a key. " +
            "Add another licence key in Settings so more solvers can run at once, or install " +
            "the free build alongside the keyed one.");
    }
    const { launchPersistentContext } = await cloak();
    const open = (exe, licenseKey) => withBinaryPin(exe, () => launchPersistentContext({
        userDataDir: profile.dir,
        headless: !display,
        proxy: proxy.proxy,
        ...(licenseKey ? { licenseKey } : {}),
        // Human-like pointer curves and keystroke timing on the driver's own methods
        humanize: true,
        ...(geo?.tz ? { timezone: geo.tz } : {}),
        // A pinned locale wins over the exit's: an app that renders in the browser's
        // language is unusable to a step naming its controls in another
        ...(locale ? { locale } : {}),
        args: [
            // One machine per exit, kept across runs alongside its cookies
            `--fingerprint=${fingerprintSeed(key)}`,
            // The container has no user namespaces to sandbox into, and /dev/shm is small
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            // Render through Chromium's own bundled SwiftShader rather than the system GL
            // stack. The image purges Mesa to stay small, which leaves no GLX for ANGLE to
            // start from ("GLX is not present"), and ANGLE does not fall back on its own.
            // This keeps WebGL present, which matters: a browser reporting none reads as
            // automation. Do not drop these without putting Mesa back in the image.
            "--use-gl=angle",
            "--use-angle=swiftshader",
            // A profile that is reused must not reopen the last session or offer to restore a
            // crashed one, either of which would leave a dialog over the page
            "--no-first-run",
            "--no-default-browser-check",
            "--hide-crash-restore-bubble",
            // A window Chromium considers occluded gets its timers, rendering and observer
            // callbacks throttled, which stalls anything waiting on them
            "--window-position=0,0",
            // The page runs with no emulated viewport (CloakBrowser passes viewport: null so
            // outerWidth cannot contradict innerWidth), so the window is the viewport and this
            // flag is what sizes it. Left out entirely when unset, so Chromium picks as before.
            ...(win ? [`--window-size=${win.width},${win.height}`] : []),
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--disable-background-timer-throttling",
            "--disable-web-security",
            "--disable-site-isolation-trials",
        ],
        launchOptions: { timeout: tune.navTimeoutMs, executablePath: exe },
    }));
    let context;
    let usedTier = lease.key ? "keyed" : "free";
    try {
        context = await open(executablePath, lease.key);
    }
    catch (err) {
        // The keyed build takes its licence at startup and quits on the spot when it cannot
        // hold a session -- another instance on the same key, or one the licence service has
        // not finished tearing down. The free build needs no session, so falling back to it
        // gets the job run instead of failing it outright over a seat.
        const freeExe = lease.key ? freeBuild : undefined;
        if (!freeExe) {
            proxy.close();
            profile.release();
            lease.release();
            throw err;
        }
        console.warn(`[cfBrowser] the keyed browser could not start (${String(err?.message ?? err).split("\n")[0]}); ` +
            "falling back to the free build for this run");
        // Hand the seat straight back: this browser is not using it, and something else can
        lease.release();
        try {
            context = await open(freeExe);
            usedTier = "free";
        }
        catch (freeErr) {
            proxy.close();
            profile.release();
            throw freeErr;
        }
    }
    try {
        // Bounds every driver call, so one wedged renderer cannot swallow the step budget
        context.setDefaultTimeout(tune.protocolTimeoutMs);
        context.setDefaultNavigationTimeout(tune.navTimeoutMs);
        const pages = context.pages();
        const page = pages[0] ?? (await context.newPage());
        // A reused profile reopens the tabs the last session left behind, and they pile up run
        // after run. Worse, a restored tab may be the active one, and Chromium delivers
        // pointer presses only to the active tab.
        for (const stray of pages.slice(1))
            await stray.close().catch(() => { });
        if (pages.length > 1) {
            console.log(`[cfBrowser] closed ${pages.length - 1} restored tab(s) from the saved profile`);
        }
        await page.bringToFront().catch(() => { });
        const launched = {
            context,
            page,
            key,
            tier: usedTier,
            geo,
            close: async () => {
                // Bounded: a wedged renderer can leave close() pending, and everything below it --
                // the licence seat above all -- would then be held for the life of the process.
                await Promise.race([
                    context.close().catch(() => { }),
                    new Promise((r) => setTimeout(r, CLOSE_TIMEOUT_MS)),
                ]);
                proxy.close();
                profile.release();
                lease.release();
                liveBrowsers.delete(launched);
            },
        };
        liveBrowsers.add(launched);
        return launched;
    }
    catch (err) {
        proxy.close();
        profile.release();
        lease.release();
        throw err;
    }
}
