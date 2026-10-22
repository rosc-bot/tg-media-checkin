"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseTgProxy = parseTgProxy;
exports.runJob = runJob;
const checkin_1 = require("./checkin");
const embywatch_1 = require("./embywatch");
const cloudflare_1 = require("./cloudflare");
const custom_1 = require("./custom");
const autoreg_1 = require("./autoreg");
const database_1 = require("../db/database");
const appClient_1 = require("../tg/appClient");
/** Looks a proxy id up in the settings list. */
function proxyUrlById(proxyId) {
    if (!proxyId)
        return undefined;
    try {
        const row = database_1.db
            .prepare("SELECT value FROM settings WHERE key = ?")
            .get("proxies");
        if (!row?.value)
            return undefined;
        const list = JSON.parse(row.value);
        return list.find((p) => p.id === proxyId)?.url;
    }
    catch {
        return undefined;
    }
}
/** The proxy id a job or its template carries, if any. */
function configProxyId(jobConfig, templateId) {
    const readProxyId = (raw) => {
        if (!raw)
            return undefined;
        try {
            let c = JSON.parse(raw);
            if (typeof c === "string")
                c = JSON.parse(c);
            return c?.proxyId || undefined;
        }
        catch {
            return undefined;
        }
    };
    let fromTemplate;
    if (templateId) {
        const row = database_1.db
            .prepare("SELECT config FROM job_templates WHERE id = ?")
            .get(templateId);
        fromTemplate = readProxyId(row?.config);
    }
    return fromTemplate ?? readProxyId(jobConfig);
}
/**
 * Exit for this account's Telegram connection: the account's own proxy, and nothing
 * else. Every other place a session is used (login, status checks, the messenger) goes
 * through the account proxy too, so anything else here would put one auth key behind two
 * IPs -- which Telegram answers with AUTH_KEY_DUPLICATED and an invalidated session. A
 * job/template proxy is for the browser side instead (see resolveWebProxyUrl).
 */
function resolveTgProxyUrl(accountProxyId, job) {
    const configured = configProxyId(job.config, job.templateId);
    if (configured && configured !== accountProxyId) {
        console.warn(`[runner] Job "${job.name}": proxy "${configured}" is set on the job/template but the ` +
            `Telegram connection follows the account's proxy (${accountProxyId ?? "none"}); the job ` +
            `proxy is used for the browser only. Set it on the account (and re-authenticate) to ` +
            `route Telegram through it.`);
    }
    return proxyUrlById(accountProxyId);
}
/**
 * Exit for the browser side (Cloudflare challenges, Mini Apps): the job's or template's
 * proxy when one is set, otherwise the account's. Cloudflare judges the exit IP, so this
 * one is meant to be chosen per job, and the browser holds no Telegram session.
 */
function resolveWebProxyUrl(accountProxyId, job) {
    return proxyUrlById(configProxyId(job.config, job.templateId) ?? accountProxyId);
}
function parseTgProxy(proxyUrl) {
    if (!proxyUrl)
        return undefined;
    try {
        const u = new URL(proxyUrl);
        const proto = u.protocol.replace(":", "");
        if (proto !== "socks5" && proto !== "socks4" && proto !== "socks")
            return undefined;
        return {
            ip: u.hostname,
            port: Number(u.port) || 1080,
            socksType: proto === "socks4" ? 4 : 5,
            username: u.username || undefined,
            password: u.password || undefined,
        };
    }
    catch {
        return undefined;
    }
}
const RETRY_DELAY_MS = 5000;
function delayAbortable(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new Error("Job cancelled"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("Job cancelled"));
        }, { once: true });
    });
}
async function runJob(job, account, detailLogs, signal) {
    let lastError;
    // Browser exits refused during this run, shared by every attempt below: retrying a
    // proxy Cloudflare has already turned down only replays the refusal
    const cfRun = (0, cloudflare_1.newCfRunState)();
    for (let attempt = 1; attempt <= job.retryMax; attempt++) {
        if (signal?.aborted)
            throw new Error("Job cancelled");
        try {
            switch (job.jobType) {
                case "checkin": {
                    if (!account)
                        throw new Error("No account linked to this job");
                    if (!account.sessionString)
                        throw new Error("Account has no session -- authenticate first");
                    if (!account.apiId || !account.apiHash)
                        throw new Error("No API credentials available for this account");
                    // Telegram follows the account's exit; the browser may use the job's
                    const checkinProxy = parseTgProxy(resolveTgProxyUrl(account.proxyId, job));
                    const checkinProxyUrl = resolveWebProxyUrl(account.proxyId, job);
                    const checkinDevice = (0, appClient_1.resolveAppClientParams)(account.id, account.appClientId);
                    let checkinCfg = {};
                    try {
                        // For template-linked jobs, use template config as base then overlay job config
                        if (job.templateId) {
                            const tplRow = database_1.db
                                .prepare("SELECT config FROM job_templates WHERE id = ?")
                                .get(job.templateId);
                            if (tplRow?.config) {
                                let t = JSON.parse(tplRow.config);
                                if (typeof t === "string")
                                    t = JSON.parse(t);
                                checkinCfg = { ...checkinCfg, ...t };
                            }
                        }
                        if (job.config) {
                            let c = JSON.parse(job.config);
                            if (typeof c === "string")
                                c = JSON.parse(c);
                            checkinCfg = { ...checkinCfg, ...c };
                        }
                    }
                    catch {
                        /* ignore */
                    }
                    const log = await (0, checkin_1.runCheckin)(account.apiId, account.apiHash, account.sessionString, job.botUsername, job.replyTimeoutMs, job.startCommand, job.checkinButton, attempt, job.retryMax, signal, checkinProxy, checkinDevice, checkinCfg.successContains, checkinCfg.failContains, checkinCfg.cfChallenge ?? false, checkinProxyUrl, cfRun);
                    detailLogs?.push(log);
                    break;
                }
                case "embywatch": {
                    let jobCfg = JSON.parse(job.config ?? "{}");
                    if (typeof jobCfg === "string")
                        jobCfg = JSON.parse(jobCfg);
                    let config = jobCfg;
                    // Template-linked jobs: merge template config (settings) with job config (credentials)
                    if (job.templateId) {
                        const tplRow = database_1.db
                            .prepare("SELECT config FROM job_templates WHERE id = ?")
                            .get(job.templateId);
                        if (tplRow?.config) {
                            let tplCfg = JSON.parse(tplRow.config);
                            if (typeof tplCfg === "string")
                                tplCfg = JSON.parse(tplCfg);
                            config = { ...tplCfg, ...jobCfg };
                        }
                    }
                    if (!config.username || !config.password)
                        throw new Error("Emby username and password are required");
                    const log = await (0, embywatch_1.runEmbywatch)(job.botUsername, config, signal);
                    detailLogs?.push(log);
                    break;
                }
                case "custom": {
                    if (!account)
                        throw new Error("No account linked to this job");
                    if (!account.sessionString)
                        throw new Error("Account has no session -- authenticate first");
                    if (!account.apiId || !account.apiHash)
                        throw new Error("No API credentials available for this account");
                    const rawCfg = JSON.parse(job.config ?? '{"actions":[]}');
                    // Telegram follows the account's exit; the browser may use the job's
                    const customProxy = parseTgProxy(resolveTgProxyUrl(account.proxyId, job));
                    const customProxyUrl = resolveWebProxyUrl(account.proxyId, job);
                    const customDevice = (0, appClient_1.resolveAppClientParams)(account.id, account.appClientId);
                    const customLog = await (0, custom_1.runCustom)(account.apiId, account.apiHash, account.sessionString, job.botUsername, rawCfg, signal, customProxy, customDevice, customProxyUrl, cfRun);
                    detailLogs?.push(customLog);
                    break;
                }
                case "autoreg": {
                    if (!account)
                        throw new Error("No account linked to this job");
                    if (!account.sessionString)
                        throw new Error("Account has no session -- authenticate first");
                    if (!account.apiId || !account.apiHash)
                        throw new Error("No API credentials available for this account");
                    let autoregCfg = {};
                    try {
                        // Template-linked jobs: template config as base, job config overlaid
                        if (job.templateId) {
                            const tplRow = database_1.db
                                .prepare("SELECT config FROM job_templates WHERE id = ?")
                                .get(job.templateId);
                            if (tplRow?.config) {
                                let t = JSON.parse(tplRow.config);
                                if (typeof t === "string")
                                    t = JSON.parse(t);
                                autoregCfg = { ...autoregCfg, ...t };
                            }
                        }
                        if (job.config) {
                            let c = JSON.parse(job.config);
                            if (typeof c === "string")
                                c = JSON.parse(c);
                            autoregCfg = { ...autoregCfg, ...c };
                        }
                    }
                    catch {
                        /* ignore */
                    }
                    const autoregProxy = parseTgProxy(resolveTgProxyUrl(account.proxyId, job));
                    const autoregDevice = (0, appClient_1.resolveAppClientParams)(account.id, account.appClientId);
                    const autoregLog = await (0, autoreg_1.runAutoreg)(account.apiId, account.apiHash, account.sessionString, job.botUsername, job.startCommand, autoregCfg, signal, autoregProxy, autoregDevice, job.replyTimeoutMs);
                    detailLogs?.push(autoregLog);
                    break;
                }
                default:
                    throw new Error(`Unknown job type: ${job.jobType}`);
            }
            return;
        }
        catch (err) {
            if (err instanceof checkin_1.CheckinError)
                detailLogs?.push(err.log);
            if (err instanceof custom_1.CustomJobError)
                detailLogs?.push(err.log);
            if (err instanceof autoreg_1.AutoregJobError)
                detailLogs?.push(err.log);
            lastError = err;
            // A cancelled job must not be retried, and must report as cancelled even
            // if the underlying failure surfaced as something else.
            if (signal?.aborted)
                throw new Error("Job cancelled");
            console.error(`[runner] Job "${job.name}" attempt ${attempt}/${job.retryMax} failed:`, err);
            if (attempt < job.retryMax && signal) {
                await delayAbortable(RETRY_DELAY_MS, signal).catch(() => {
                    throw lastError;
                });
            }
            else if (attempt < job.retryMax) {
                await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            }
        }
    }
    throw lastError;
}
