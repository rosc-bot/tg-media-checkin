"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CF_FONTS = void 0;
exports.cfFontsRoot = cfFontsRoot;
exports.areCfFontsInstalled = areCfFontsInstalled;
exports.cfFontsStatus = cfFontsStatus;
exports.applyCfFontEnv = applyCfFontEnv;
exports.installCfFonts = installCfFonts;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = require("node:crypto");
const node_stream_1 = require("node:stream");
const promises_1 = require("node:stream/promises");
const node_child_process_1 = require("node:child_process");
const paths_1 = require("./paths");
exports.CF_FONTS = [
    {
        file: "NotoSansCJK-Regular.ttc",
        url: "https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTC/NotoSansCJK-Regular.ttc",
        bytes: 19484784,
        sha256: "b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a",
        label: "Noto Sans CJK",
    },
    {
        file: "NotoColorEmoji.ttf",
        url: "https://raw.githubusercontent.com/googlefonts/noto-emoji/f3ae03f5e9b3b8516fa151f7168159ca1a3e7515/fonts/NotoColorEmoji.ttf",
        bytes: 10673480,
        sha256: "72a635cb3d2f3524c51620cdde406b217204e8a6a06c6a096ff8ed4b5fd6e27b",
        label: "Noto Color Emoji",
    },
];
/** Data-dir subfolder holding the on-demand font install. */
function cfFontsRoot() {
    return node_path_1.default.join((0, paths_1.dataDir)(), "cf-fonts");
}
function cfFontsDir() {
    return node_path_1.default.join(cfFontsRoot(), "fonts");
}
function cfFontConfigFile() {
    return node_path_1.default.join(cfFontsRoot(), "fonts.conf");
}
/** Installed only at the exact expected size, so a part-written file never counts. */
function cfFontPresent(f) {
    try {
        return (0, node_fs_1.statSync)(node_path_1.default.join(cfFontsDir(), f.file)).size === f.bytes;
    }
    catch {
        return false;
    }
}
function areCfFontsInstalled() {
    return exports.CF_FONTS.every(cfFontPresent);
}
/** Which faces are in the data dir and which are still missing, for the settings view. */
function cfFontsStatus() {
    return {
        installed: exports.CF_FONTS.filter(cfFontPresent).map((f) => f.label),
        missing: exports.CF_FONTS.filter((f) => !cfFontPresent(f)).map((f) => f.label),
    };
}
/**
 * Adds the data-dir fonts to the image's own fontconfig setup.
 *
 * The image config is included rather than replaced, so Debian's generic-family aliases and
 * hinting rules still apply and the Latin fallback in /usr/share/fonts stays visible. Our
 * cachedir is listed first because fontconfig writes to the first one it can write to:
 * that puts the cache on the volume, so it is built once instead of on every start.
 */
function ensureCfFontConfig() {
    const body = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<!-- Written by Bemby: the Cloudflare solver's fonts live in the data dir, not the image. -->
<fontconfig>
  <cachedir>${node_path_1.default.join(cfFontsRoot(), "cache")}</cachedir>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${cfFontsDir()}</dir>
</fontconfig>
`;
    (0, node_fs_1.mkdirSync)(cfFontsDir(), { recursive: true });
    (0, node_fs_1.mkdirSync)(node_path_1.default.join(cfFontsRoot(), "cache"), { recursive: true });
    const conf = cfFontConfigFile();
    if (!(0, node_fs_1.existsSync)(conf) || (0, node_fs_1.readFileSync)(conf, "utf8") !== body) {
        (0, node_fs_1.writeFileSync)(conf, body);
    }
    return conf;
}
/**
 * Points fontconfig at the data-dir fonts. Applied at launch rather than at install, so
 * fonts fetched by an earlier version are picked up without reinstalling anything.
 */
let warnedMissingFonts = false;
function applyCfFontEnv() {
    if (!areCfFontsInstalled()) {
        // Once per process: this runs per browser launch, so a job would otherwise repeat it.
        if (!warnedMissingFonts) {
            warnedMissingFonts = true;
            console.warn(`[cfFonts] CJK/emoji fonts are missing from ${cfFontsDir()}; the browser has only ` +
                "the Latin fallback. Re-run the Cloudflare solver install in Settings to fetch them.");
        }
        return;
    }
    warnedMissingFonts = false;
    try {
        process.env.FONTCONFIG_FILE = ensureCfFontConfig();
    }
    catch (err) {
        console.warn(`[cfFonts] could not point fontconfig at ${cfFontsDir()}: ${err?.message ?? err}`);
    }
}
/** Streams one face to a `.part` file, hashing as it goes, and only names it on a match. */
async function downloadCfFont(f) {
    const dest = node_path_1.default.join(cfFontsDir(), f.file);
    const part = `${dest}.part`;
    const res = await fetch(f.url, { redirect: "follow" });
    if (!res.ok || !res.body)
        throw new Error(`HTTP ${res.status}`);
    const hash = (0, node_crypto_1.createHash)("sha256");
    await (0, promises_1.pipeline)(node_stream_1.Readable.fromWeb(res.body), async function* (chunks) {
        for await (const chunk of chunks) {
            hash.update(chunk);
            yield chunk;
        }
    }, (0, node_fs_1.createWriteStream)(part));
    const digest = hash.digest("hex");
    if (digest !== f.sha256) {
        (0, node_fs_1.rmSync)(part, { force: true });
        throw new Error(`digest mismatch (expected ${f.sha256.slice(0, 12)}, got ${digest.slice(0, 12)})`);
    }
    (0, node_fs_1.renameSync)(part, dest);
}
/**
 * Downloads the faces the image no longer carries (~30MB) into the data dir.
 *
 * Deliberately not fatal to setting up the solver: with the image's Latin fallback the
 * browser still runs, it just cannot draw CJK or emoji, so a blocked download degrades the
 * challenge pass rate rather than leaving nothing installed at all.
 */
async function installCfFonts(force = false) {
    const lines = [];
    try {
        ensureCfFontConfig();
    }
    catch (err) {
        return { ok: false, output: `Cannot write to ${cfFontsRoot()}: ${err?.message ?? err}` };
    }
    for (const f of exports.CF_FONTS) {
        if (!force && cfFontPresent(f)) {
            lines.push(`${f.label}: already installed`);
            continue;
        }
        try {
            await downloadCfFont(f);
            lines.push(`${f.label}: installed (${Math.round(f.bytes / 1048576)}MB)`);
        }
        catch (err) {
            lines.push(`${f.label}: FAILED, ${err?.message ?? err}`);
        }
    }
    const ok = areCfFontsInstalled();
    if (ok)
        lines.push(buildCfFontCache());
    return { ok, output: lines.join("\n") };
}
/**
 * Builds the fontconfig cache up front so the first launch does not pay for it. Best
 * effort: without fc-cache on the path the browser builds the cache itself.
 */
function buildCfFontCache() {
    try {
        const out = (0, node_child_process_1.spawnSync)("fc-cache", ["-f", cfFontsDir()], {
            encoding: "utf8",
            timeout: 180000,
            env: { ...process.env, FONTCONFIG_FILE: cfFontConfigFile() },
        });
        if (out.error)
            return "fc-cache not available; the browser will build the cache itself";
        const tail = `${out.stdout ?? ""}${out.stderr ?? ""}`.trim().split("\n").pop();
        return `fc-cache: ${tail || "done"}`;
    }
    catch {
        return "fc-cache skipped";
    }
}
