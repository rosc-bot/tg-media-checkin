"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CF_TUNING_FIELDS = exports.CF_TUNING_LIMITS = exports.CF_TUNING_DEFAULTS = exports.CF_TUNING_KEY = void 0;
exports.resolveCfTuning = resolveCfTuning;
exports.invalidateCfTuning = invalidateCfTuning;
exports.cfTuning = cfTuning;
const database_1 = require("../db/database");
// Every number the Cloudflare/Mini App browser runs on. They started as constants in the
// solver; sites differ enough (a slow app, a proxy with high latency, a captcha that takes
// its time) that they are worth tuning without a rebuild. Anything unset, unparsable or
// out of range falls back to the value the solver shipped with.
exports.CF_TUNING_KEY = "cf_tuning";
/** The values the solver shipped with. */
exports.CF_TUNING_DEFAULTS = {
    budgetMs: 300000,
    minAttemptMs: 10000,
    minActionMs: 15000,
    navTimeoutMs: 45000,
    appReadyTimeoutMs: 25000,
    challengeTimeoutMs: 45000,
    postClickChallengeMs: 20000,
    confirmTimeoutMs: 20000,
    settleMs: 1500,
    relaunchSettleMs: 3000,
    inAppStepMs: 1200,
    inAppSettleMs: 4000,
    pollMs: 1000,
    readyPollMs: 500,
    protocolTimeoutMs: 30000,
    proxyCandidates: 8,
    maxPoolCandidates: 200,
    maxProfiles: 12,
    blankTextLen: 10,
    windowWidth: 0,
    windowHeight: 0,
};
/** Range each value is held to, so a typo cannot wedge a job for an hour. */
exports.CF_TUNING_LIMITS = {
    budgetMs: { min: 30000, max: 3600000 },
    minAttemptMs: { min: 2000, max: 120000 },
    minActionMs: { min: 2000, max: 120000 },
    navTimeoutMs: { min: 5000, max: 180000 },
    appReadyTimeoutMs: { min: 2000, max: 180000 },
    challengeTimeoutMs: { min: 5000, max: 300000 },
    postClickChallengeMs: { min: 0, max: 180000 },
    confirmTimeoutMs: { min: 0, max: 180000 },
    settleMs: { min: 0, max: 60000 },
    relaunchSettleMs: { min: 0, max: 60000 },
    inAppStepMs: { min: 0, max: 60000 },
    inAppSettleMs: { min: 0, max: 60000 },
    pollMs: { min: 200, max: 10000 },
    readyPollMs: { min: 100, max: 10000 },
    protocolTimeoutMs: { min: 5000, max: 300000 },
    proxyCandidates: { min: 1, max: 200 },
    maxPoolCandidates: { min: 1, max: 500 },
    maxProfiles: { min: 0, max: 200 },
    blankTextLen: { min: 0, max: 5000 },
    windowWidth: { min: 0, max: 3840 },
    windowHeight: { min: 0, max: 4320 },
};
exports.CF_TUNING_FIELDS = Object.keys(exports.CF_TUNING_DEFAULTS);
/**
 * Folds stored values over the defaults, keeping each inside its range. Used both when
 * reading for a job and when saving from the client, so a value is stored exactly as it
 * will be applied.
 */
function resolveCfTuning(stored) {
    const out = { ...exports.CF_TUNING_DEFAULTS };
    if (!stored || typeof stored !== "object")
        return out;
    for (const field of exports.CF_TUNING_FIELDS) {
        const raw = stored[field];
        const n = typeof raw === "string" ? Number(raw) : raw;
        if (typeof n !== "number" || !Number.isFinite(n))
            continue;
        const { min, max } = exports.CF_TUNING_LIMITS[field];
        out[field] = Math.round(Math.min(max, Math.max(min, n)));
    }
    return out;
}
// Read on every poll of every challenge otherwise; cached, and dropped when the setting is
// written so a change applies to the next job without a restart.
let cached;
function invalidateCfTuning() {
    cached = undefined;
}
/** The numbers in force right now. */
function cfTuning() {
    if (cached)
        return cached;
    let stored;
    try {
        const row = database_1.db.prepare("SELECT value FROM settings WHERE key = ?").get(exports.CF_TUNING_KEY);
        if (row?.value)
            stored = JSON.parse(row.value);
    }
    catch {
        /* fall back to defaults */
    }
    cached = resolveCfTuning(stored);
    return cached;
}
