"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CheckinError = void 0;
exports.expandCommand = expandCommand;
exports.htmlToText = htmlToText;
exports.isAiBtn = isAiBtn;
exports.parseAiBtnHint = parseAiBtnHint;
exports.callAI = callAI;
exports.hasAiInput = hasAiInput;
exports.parseAiInputLength = parseAiInputLength;
exports.buildCaptchaPrompt = buildCaptchaPrompt;
exports.recognizeCaptchaWithAI = recognizeCaptchaWithAI;
exports.selectButtonWithAI = selectButtonWithAI;
exports.selectMultipleButtonsWithAI = selectMultipleButtonsWithAI;
exports.parseMessages = parseMessages;
exports.findUrlButton = findUrlButton;
exports.waitForBotMessageEdit = waitForBotMessageEdit;
exports.waitForNewBotMessage = waitForNewBotMessage;
exports.checkSpamStatus = checkSpamStatus;
exports.runCheckin = runCheckin;
const telegram_1 = require("telegram");
const database_1 = require("../db/database");
const Logger_1 = require("telegram/extensions/Logger");
const sessions_1 = require("telegram/sessions");
const events_1 = require("telegram/events");
const cloudflare_1 = require("./cloudflare");
const miniApp_1 = require("../tg/miniApp");
const htmlEscape_1 = require("../tg/htmlEscape");
const proxyProviders_1 = require("../tg/proxyProviders");
class CheckinError extends Error {
    constructor(message, log) {
        super(message);
        this.log = log;
        this.name = 'CheckinError';
    }
}
exports.CheckinError = CheckinError;
// Carries partial messages when timeout fires before a buttons-message arrives
class BotReplyTimeoutError extends Error {
    constructor(ms, partial) {
        super(`Timed out after ${ms}ms waiting for bot reply`);
        this.partial = partial;
        this.name = 'BotReplyTimeoutError';
    }
}
// ── Command template expansion ────────────────────────────────────────────────
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const ALNUM = LOWER + UPPER + DIGITS;
function pick(chars, len) {
    return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
/**
 * Expands template placeholders before sending a command.
 * Syntax: {type} or {type:length}
 * Types: word (lowercase), WORD (uppercase), num (digits), alpha (mixed alnum), uuid
 * An optional context map supplies named tokens (e.g. {name}) that take
 * precedence over the built-in random types.
 */
function expandCommand(template, context) {
    return template.replace(/\{(\w+)(?::(\d+))?\}/g, (match, type, lenStr) => {
        if (context && Object.prototype.hasOwnProperty.call(context, type)) {
            return context[type];
        }
        const len = lenStr ? parseInt(lenStr, 10) : 0;
        switch (type) {
            case 'word': return pick(LOWER, len || 6);
            case 'WORD': return pick(UPPER, len || 6);
            case 'num': return pick(DIGITS, len || 6);
            case 'alpha': return pick(ALNUM, len || 8);
            case 'uuid': {
                // RFC 4122 v4
                return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                    const r = Math.random() * 16 | 0;
                    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
                });
            }
            default: return match; // unknown placeholder — leave as-is
        }
    });
}
// ── AI button selection ───────────────────────────────────────────────────────
// Strips HTML tags to plain text for the AI prompt
function htmlToText(html) {
    return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function getAiSetting(key, fallbackEnv, defaultVal) {
    const rows = database_1.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return rows?.value || process.env[fallbackEnv] || defaultVal;
}
/** Returns true if the value is an aiBtn placeholder (with or without hint) */
function isAiBtn(val) {
    return val === '{aiBtn}' || /^\{aiBtn:.+\}$/.test(val);
}
/** Extracts the hint from {aiBtn:hint}, returns undefined for plain {aiBtn} */
function parseAiBtnHint(val) {
    const m = val.match(/^\{aiBtn:(.+)\}$/);
    return m ? m[1].trim() : undefined;
}
// The answer itself (captcha chars / button text) is tiny, but reasoning models
// burn the budget on chain-of-thought first; too small and content comes back
// empty. Generous cap — non-reasoning models still stop early once done.
const AI_ANSWER_MAX_TOKENS = 2048;
function resolveAICreds(modelId) {
    const override = modelId?.trim();
    let row;
    // Pinned default: an exact ai_models row, so the same model under a second
    // supplier (e.g. another account of the same provider) can be the primary
    if (!override) {
        const pinnedId = Number(getAiSetting('ai_default_model_id', '', ''));
        if (pinnedId) {
            row = database_1.db.prepare(`
        SELECT m.model_id, s.api_key, s.base_url, s.timeout_ms
        FROM ai_models m JOIN ai_suppliers s ON s.id = m.supplier_id
        WHERE m.id = ?
      `).get(pinnedId);
        }
    }
    const model = override || row?.model_id || getAiSetting('ai_model', 'AI_MODEL', 'nvidia/nemotron-nano-12b-v2-vl:free');
    // Prefer a supplier with a non-empty key: the same model can exist under
    // multiple suppliers
    if (!row) {
        row = database_1.db.prepare(`
      SELECT m.model_id, s.api_key, s.base_url, s.timeout_ms
      FROM ai_models m JOIN ai_suppliers s ON s.id = m.supplier_id
      WHERE m.model_id = ?
      ORDER BY (s.api_key != '') DESC, m.id
      LIMIT 1
    `).get(model);
    }
    return {
        modelId: model,
        // `||` not `??`: upgraded installs can have a seeded supplier with an empty
        // key while the real key lives in the legacy setting or AI_API_KEY env
        apiKey: row?.api_key || getAiSetting('ai_api_key', 'AI_API_KEY', ''),
        baseUrl: (row?.base_url ?? getAiSetting('ai_base_url', 'AI_BASE_URL', 'https://openrouter.ai/api/v1')).replace(/\/$/, ''),
        timeoutMs: row ? row.timeout_ms : Number(getAiSetting('ai_timeout_ms', 'AI_TIMEOUT_MS', '25000')),
    };
}
function getAllModelCreds() {
    return database_1.db.prepare(`
    SELECT m.model_id, s.api_key, s.base_url, s.timeout_ms
    FROM ai_models m JOIN ai_suppliers s ON s.id = m.supplier_id
    ORDER BY s.id, m.id
  `).all().map(r => ({
        modelId: r.model_id,
        apiKey: r.api_key,
        baseUrl: r.base_url.replace(/\/$/, ''),
        timeoutMs: r.timeout_ms,
    }));
}
async function callAIWithCreds(images, prompt, maxTokens, creds) {
    if (!creds.apiKey)
        throw new Error('AI API key not configured — set it in Settings');
    const content = [];
    for (const img of images)
        content.push({ type: 'image_url', image_url: { url: img } });
    content.push({ type: 'text', text: prompt });
    const res = await fetch(`${creds.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${creds.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: creds.modelId, messages: [{ role: 'user', content }], max_tokens: maxTokens }),
        signal: AbortSignal.timeout(creds.timeoutMs),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`AI API error ${res.status}: ${body}`);
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    const response = stripReasoning(choice?.message?.content ?? '');
    // Reasoning models spend the token budget on chain-of-thought; when it runs
    // out before any answer, content comes back empty with finish_reason 'length'
    if (!response && choice?.finish_reason === 'length') {
        throw new Error(`AI response truncated before an answer (finish_reason=length, max_tokens=${maxTokens}). ` +
            `The model "${creds.modelId}" is likely a reasoning model — try a larger token budget or a non-reasoning model.`);
    }
    return { response };
}
/**
 * Strips chain-of-thought that reasoning models emit inline despite being told
 * not to, so the answer isn't buried in (or masked by) <think> blocks.
 */
function stripReasoning(text) {
    return text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/i, '') // unterminated block (truncated response)
        .trim();
}
/** Generic AI call: sends images + prompt, returns the raw text response. */
async function callAI(images, prompt, maxTokens = 200, modelOverride) {
    return callAIWithCreds(images, prompt, maxTokens, resolveAICreds(modelOverride));
}
/**
 * Tries the default model first; on any API error, falls back to other configured
 * suppliers/models in order (if ai_fallback_enabled is true).
 */
async function callAIWithFallback(images, prompt, maxTokens) {
    const primary = resolveAICreds();
    const fallbackEnabled = getAiSetting('ai_fallback_enabled', '', 'true') === 'true';
    // Dedupe by full credentials, not model id: the same model under a different
    // supplier (e.g. a second account of the same provider) is a valid fallback
    const credsKey = (c) => `${c.modelId}|${c.baseUrl}|${c.apiKey}`;
    const candidates = [primary];
    if (fallbackEnabled) {
        const seen = new Set([credsKey(primary)]);
        for (const c of getAllModelCreds()) {
            if (seen.has(credsKey(c)))
                continue;
            seen.add(credsKey(c));
            candidates.push(c);
        }
    }
    let lastError = new Error('AI API key not configured — set it in Settings');
    for (const creds of candidates) {
        if (!creds.apiKey)
            continue;
        try {
            return await callAIWithCreds(images, prompt, maxTokens, creds);
        }
        catch (err) {
            lastError = err;
        }
    }
    throw lastError;
}
/** Returns true if a command template contains an {aiInput} or {aiInput:N} placeholder */
function hasAiInput(template) {
    return /\{aiInput(?::\d+)?\}/.test(template);
}
/** Extracts the expected length from {aiInput:N}, returns undefined for plain {aiInput} */
function parseAiInputLength(template) {
    const m = template.match(/\{aiInput:(\d+)\}/);
    return m ? parseInt(m[1], 10) : undefined;
}
/** Builds the captcha recognition prompt so callers can log it before the fetch. */
function buildCaptchaPrompt(length) {
    const lengthHint = length ? ` The captcha is exactly ${length} characters.` : '';
    return `Read this captcha image.${lengthHint} Reply with ONLY the captcha characters, nothing else.`;
}
/** Sends captcha image(s) to the AI and returns the recognised text only. */
async function recognizeCaptchaWithAI(images, length) {
    if (!resolveAICreds().apiKey)
        throw new Error('{aiInput} requires an AI API key — configure it in Settings');
    if (!images.length)
        throw new Error('{aiInput} requires an image in the previous message');
    const prompt = buildCaptchaPrompt(length);
    const { response: recognized } = await callAIWithFallback(images, prompt, AI_ANSWER_MAX_TOKENS);
    if (!recognized)
        throw new Error('AI returned empty response for captcha recognition');
    return { text: recognized, prompt, response: recognized };
}
async function selectButtonWithAI(buttons, html, images, hint, maxRetries = 0) {
    if (!resolveAICreds().apiKey)
        throw new Error('{aiBtn} requires an AI API key — configure it in Settings');
    const flat = buttons.flat();
    const text = htmlToText(html);
    const task = hint ?? ('pick ONE button based on the message' + (images.length ? ' and attached image(s).' : ''));
    const prompt = `Task: "${task}".\n\nThe message:\n${text}\n\nThe available inline buttons are: ${JSON.stringify(flat)}\n\nWhich button should be clicked to "${task}"? If you don't know which button, please pick the most likely one. You MUST reply with ONLY the EXACT BUTTON TEXT from the available list, nothing else. Do NOT include any thinking logic.`;
    const effectiveMax = Math.min(maxRetries, 5); // hard cap to avoid exhausting AI credits
    const failedResponses = [];
    for (let attempt = 0; attempt <= effectiveMax; attempt++) {
        const { response: picked } = await callAIWithFallback(images, prompt, AI_ANSWER_MAX_TOKENS);
        if (!picked)
            throw new Error('AI API returned an empty response');
        const exact = flat.find(b => b === picked);
        if (exact)
            return { button: exact, prompt, response: picked, retries: failedResponses };
        const partial = flat.find(b => b.includes(picked) || picked.includes(b));
        if (partial)
            return { button: partial, prompt, response: picked, retries: failedResponses };
        // No match -- log this attempt and retry
        failedResponses.push(picked);
    }
    const err = new Error(`AI selected "${failedResponses.at(-1)}" but it does not match any available button after ${effectiveMax + 1} attempt(s): ${JSON.stringify(flat)}`);
    err.aiRetries = failedResponses;
    err.aiPrompt = prompt;
    err.aiResponse = failedResponses.at(-1) ?? '';
    throw err;
}
/** Strips a Markdown code fence some models wrap JSON in (```json ... ``` or ``` ... ```). */
function stripCodeFence(text) {
    const m = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    return (m ? m[1] : text).trim();
}
/**
 * Like selectButtonWithAI but picks multiple buttons to click in order. The AI replies
 * with a JSON array of exact button texts (avoids delimiter-in-label ambiguity); every
 * entry must map to an available button or the attempt is retried.
 */
async function selectMultipleButtonsWithAI(buttons, html, images, hint, maxRetries = 0) {
    if (!resolveAICreds().apiKey)
        throw new Error('The multiple-button click action requires an AI API key — configure it in Settings');
    const flat = buttons.flat();
    const text = htmlToText(html);
    const task = hint ?? ('pick the buttons that should be clicked based on the message' + (images.length ? ' and attached image(s).' : ''));
    const prompt = `Task: "${task}".\n\nThe message:\n${text}\n\nThe available inline buttons are: ${JSON.stringify(flat)}\n\nWhich button(s) should be clicked to "${task}", and in what order? You MUST reply with ONLY a JSON array of the EXACT BUTTON TEXTS to click, listed in click order, e.g. ["Button A", "Button B"]. Use ONLY texts from the available list. Do NOT include any other text or thinking logic.`;
    const effectiveMax = Math.min(maxRetries, 5); // hard cap to avoid exhausting AI credits
    const failedResponses = [];
    for (let attempt = 0; attempt <= effectiveMax; attempt++) {
        const { response: picked } = await callAIWithFallback(images, prompt, AI_ANSWER_MAX_TOKENS);
        if (!picked)
            throw new Error('AI API returned an empty response');
        let parsed;
        try {
            parsed = JSON.parse(stripCodeFence(picked));
        }
        catch {
            failedResponses.push(picked);
            continue;
        }
        if (!Array.isArray(parsed) || !parsed.length || !parsed.every((e) => typeof e === 'string')) {
            failedResponses.push(picked);
            continue;
        }
        const matched = [];
        let ok = true;
        for (const entry of parsed) {
            const val = entry.trim();
            const btn = flat.find(b => b === val) ?? flat.find(b => b.includes(val) || val.includes(b));
            if (!btn) {
                ok = false;
                break;
            }
            matched.push(btn);
        }
        if (ok && matched.length)
            return { buttons: matched, prompt, response: picked, retries: failedResponses };
        failedResponses.push(picked);
    }
    const err = new Error(`AI selection "${failedResponses.at(-1)}" did not map to available buttons after ${effectiveMax + 1} attempt(s): ${JSON.stringify(flat)}`);
    err.aiRetries = failedResponses;
    err.aiPrompt = prompt;
    err.aiResponse = failedResponses.at(-1) ?? '';
    throw err;
}
// ── HTML helpers ──────────────────────────────────────────────────────────────
function messageToHtml(text, entities) {
    if (!entities?.length)
        return (0, htmlEscape_1.escapeHtml)(text).replace(/\n/g, '<br>');
    const ins = [];
    for (const e of entities) {
        const end = e.offset + e.length;
        if (e instanceof telegram_1.Api.MessageEntityBold) {
            ins.push({ pos: e.offset, html: '<strong>', isClose: false });
            ins.push({ pos: end, html: '</strong>', isClose: true });
        }
        else if (e instanceof telegram_1.Api.MessageEntityItalic) {
            ins.push({ pos: e.offset, html: '<em>', isClose: false });
            ins.push({ pos: end, html: '</em>', isClose: true });
        }
        else if (e instanceof telegram_1.Api.MessageEntityCode) {
            ins.push({ pos: e.offset, html: '<code>', isClose: false });
            ins.push({ pos: end, html: '</code>', isClose: true });
        }
        else if (e instanceof telegram_1.Api.MessageEntityPre) {
            ins.push({ pos: e.offset, html: '<pre>', isClose: false });
            ins.push({ pos: end, html: '</pre>', isClose: true });
        }
        else if (e instanceof telegram_1.Api.MessageEntityUnderline) {
            ins.push({ pos: e.offset, html: '<u>', isClose: false });
            ins.push({ pos: end, html: '</u>', isClose: true });
        }
        else if (e instanceof telegram_1.Api.MessageEntityStrike) {
            ins.push({ pos: e.offset, html: '<s>', isClose: false });
            ins.push({ pos: end, html: '</s>', isClose: true });
        }
        else if (e instanceof telegram_1.Api.MessageEntityUrl) {
            const safe = (0, htmlEscape_1.safeHref)(text.slice(e.offset, end));
            if (safe) {
                ins.push({ pos: e.offset, html: `<a href="${(0, htmlEscape_1.escapeHtml)(safe)}" target="_blank" rel="noopener">`, isClose: false });
                ins.push({ pos: end, html: '</a>', isClose: true });
            }
        }
        else if (e instanceof telegram_1.Api.MessageEntityTextUrl) {
            const safe = (0, htmlEscape_1.safeHref)(e.url ?? '');
            if (safe) {
                ins.push({ pos: e.offset, html: `<a href="${(0, htmlEscape_1.escapeHtml)(safe)}" target="_blank" rel="noopener">`, isClose: false });
                ins.push({ pos: end, html: '</a>', isClose: true });
            }
        }
        else if (e instanceof telegram_1.Api.MessageEntityBotCommand) {
            ins.push({ pos: e.offset, html: '<span style="color:#2563eb">', isClose: false });
            ins.push({ pos: end, html: '</span>', isClose: true });
        }
    }
    // Sort: by position; close tags before open tags at same position (correct nesting)
    ins.sort((a, b) => a.pos - b.pos || (a.isClose ? -1 : 1) - (b.isClose ? -1 : 1));
    let result = '';
    let pos = 0;
    for (const { pos: iPos, html } of ins) {
        if (iPos > pos)
            result += (0, htmlEscape_1.escapeHtml)(text.slice(pos, iPos));
        result += html;
        pos = iPos;
    }
    result += (0, htmlEscape_1.escapeHtml)(text.slice(pos));
    return result.replace(/\n/g, '<br>');
}
// Renders a Telegram web page preview as inline HTML (inline styles required for v-html)
function webpageToHtml(wp) {
    const site = (0, htmlEscape_1.escapeHtml)(wp.siteName || wp.displayUrl || '');
    const title = (0, htmlEscape_1.escapeHtml)(wp.title ?? '');
    const desc = (0, htmlEscape_1.escapeHtml)(wp.description ?? '');
    let html = '<div style="border-left:3px solid #4a9eff;padding:3px 0 3px 8px;margin-top:6px;font-size:12px;line-height:1.4">';
    if (site)
        html += `<div style="color:#4a9eff;font-weight:500">${site}</div>`;
    if (title)
        html += `<div style="font-weight:600;color:#111">${title}</div>`;
    if (desc)
        html += `<div style="color:#555;margin-top:1px">${desc}</div>`;
    html += '</div>';
    return html;
}
// Extracts display data from a set of bot messages
async function parseMessages(messages, client, signal) {
    const hasMedia = messages.some(m => m.media instanceof telegram_1.Api.MessageMediaPhoto || m.media instanceof telegram_1.Api.MessageMediaDocument);
    const htmlParts = [];
    for (const m of messages) {
        const textHtml = messageToHtml(m.message, m.entities);
        let msgHtml = textHtml;
        if (m.media instanceof telegram_1.Api.MessageMediaWebPage && m.media.webpage instanceof telegram_1.Api.WebPage) {
            msgHtml += webpageToHtml(m.media.webpage);
        }
        if (msgHtml.trim())
            htmlParts.push(msgHtml);
    }
    const html = htmlParts.join('<hr style="margin:8px 0;border:none;border-top:1px solid #d0d0d0">');
    const buttons = [];
    const buttonsMsg = [...messages].reverse().find(m => m.replyMarkup instanceof telegram_1.Api.ReplyInlineMarkup);
    if (buttonsMsg) {
        const markup = buttonsMsg.replyMarkup;
        for (const row of markup.rows) {
            const rowTexts = row.buttons.map(btn => btn.text).filter(Boolean);
            if (rowTexts.length)
                buttons.push(rowTexts);
        }
    }
    const images = [];
    if (!signal?.aborted) {
        for (const m of messages) {
            if (!(m.media instanceof telegram_1.Api.MessageMediaPhoto))
                continue;
            try {
                const photo = m.media.photo;
                if (photo instanceof telegram_1.Api.Photo) {
                    const mSize = photo.sizes.find((s) => s instanceof telegram_1.Api.PhotoSize && s.type === 'm') ?? photo.sizes[1] ?? photo.sizes[0];
                    if (mSize) {
                        const bytes = await client.downloadMedia(m, { thumb: mSize });
                        if (bytes)
                            images.push(`data:image/jpeg;base64,${bytes.toString('base64')}`);
                    }
                }
            }
            catch { /* skip image on error */ }
        }
    }
    return { html, hasMedia, images, buttons };
}
// Finds an openable inline button that carries a web address rather than a
// callback: a URL button (e.g. "我不是机器人") or a Mini App button (e.g. FutureEcho's
// "🔐 Verify", or a "打开小程序签到" checkin app). Mini App buttons are flagged so the
// caller can have Telegram sign the URL before opening it. When `matchText` is
// given, only a button whose label contains it is returned.
function findUrlButton(msg, matchText) {
    const markup = msg?.replyMarkup;
    if (!(markup instanceof telegram_1.Api.ReplyInlineMarkup))
        return undefined;
    for (const row of markup.rows) {
        for (const btn of row.buttons) {
            const web = (0, miniApp_1.webButtonOf)(btn);
            if (!web)
                continue;
            if (!matchText || web.text.includes(matchText))
                return web;
        }
    }
    return undefined;
}
// Scans several recent bot messages for an openable web button. Bots often send
// the verify prompt as one of several follow-up messages (error + prompt + fresh
// menu), so the single raced reply isn't enough.
async function findUrlButtonRecent(client, botUsername, signal, miniAppOnly = false) {
    if (signal?.aborted)
        return undefined;
    try {
        const msgs = (await client.getMessages(botUsername, { limit: 6 }));
        for (const m of msgs) {
            const found = findUrlButton(m);
            if (found && (!miniAppOnly || found.miniApp))
                return { web: found, msg: m };
        }
    }
    catch {
        /* ignore fetch errors, fall back to the raced reply */
    }
    return undefined;
}
// A verify page (e.g. FutureEcho's Turnstile) only unlocks the checkin; after it
// passes, the bot expects the checkin button clicked again. Best-effort re-click
// on the latest menu, returning the follow-up text for success/fail matching.
// Never throws -- a failed re-click just yields no extra text.
async function reclickCheckinButton(client, botUsername, buttonText, replyTimeoutMs, signal) {
    try {
        if (signal?.aborted)
            return '';
        await new Promise(r => setTimeout(r, 3000)); // let the bot register the verification
        // The newest button message is usually the challenge prompt ("开始验证"), which carries no checkin
        // button -- so scan back through recent messages for one that does. Reading only the
        // newest menu silently skipped the re-click and the checkin never ran.
        const msgs = (await client.getMessages(botUsername, { limit: 10 }));
        let menu;
        let target;
        for (const m of msgs) {
            if (!(m.replyMarkup instanceof telegram_1.Api.ReplyInlineMarkup))
                continue;
            for (const row of m.replyMarkup.rows)
                for (const btn of row.buttons)
                    if (btn instanceof telegram_1.Api.KeyboardButtonCallback && btn.text.includes(buttonText))
                        target = btn;
            if (target) {
                menu = m;
                break;
            }
        }
        if (!menu || !target)
            return '';
        const peer = await client.getInputEntity(botUsername);
        const botPeerId = await client.getPeerId(botUsername);
        const editP = waitForBotMessageEdit(client, menu.id, replyTimeoutMs, signal, botPeerId);
        const newP = waitForNewBotMessage(client, botUsername, replyTimeoutMs, signal);
        let answer;
        try {
            answer = (await client.invoke(new telegram_1.Api.messages.GetBotCallbackAnswer({ peer, msgId: menu.id, data: target.data })));
        }
        catch (err) {
            if (!/BOT_RESPONSE_TIMEOUT/.test(err?.message ?? ''))
                throw err;
        }
        const capP = new Promise(r => setTimeout(() => r(null), Math.min(replyTimeoutMs, 15000)));
        const resp = await Promise.race([editP, newP, capP]);
        const parts = [answer?.message ?? ''];
        if (resp && !signal?.aborted) {
            const bp = await parseMessages([resp], client, signal);
            parts.push(htmlToText(bp.html ?? ''));
        }
        return parts.filter(Boolean).join('\n');
    }
    catch {
        return '';
    }
}
// Collects ALL bot messages; resolves when one has buttons, times out otherwise
function waitForBotReply(client, botUsername, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('Job cancelled'));
            return;
        }
        const collected = [];
        const cleanup = () => {
            clearTimeout(timer);
            client.removeEventHandler(handler, new events_1.NewMessage({}));
            signal?.removeEventListener('abort', onAbort);
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new BotReplyTimeoutError(timeoutMs, collected));
        }, timeoutMs);
        const onAbort = () => { cleanup(); reject(new Error('Job cancelled')); };
        signal?.addEventListener('abort', onAbort, { once: true });
        const handler = async (event) => {
            const msg = event.message;
            collected.push(msg);
            // Use replyMarkup (raw TLObject field) instead of msg.buttons getter, which
            // requires inputChat to be resolved and silently returns undefined when it isn't.
            if (msg.replyMarkup) {
                cleanup();
                resolve(collected);
            }
        };
        client.addEventHandler(handler, new events_1.NewMessage({ fromUsers: [botUsername] }));
    });
}
// Watches for an in-place edit of a specific message (bot edits the original reply).
// Uses raw Telegram updates since GramJS has no dedicated EditedMessage event.
// Never rejects -- resolves null on timeout or abort.
function waitForBotMessageEdit(client, originalMsgId, maxMs, signal, peerId) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(null);
            return;
        }
        const finish = (msg) => {
            clearTimeout(timer);
            client.removeEventHandler(handler, new events_1.Raw({}));
            signal?.removeEventListener('abort', onAbort);
            resolve(msg);
        };
        const timer = setTimeout(() => finish(null), maxMs);
        const onAbort = () => finish(null);
        signal?.addEventListener('abort', onAbort, { once: true });
        const handler = async (update) => {
            const isEdit = update.className === 'UpdateEditMessage' ||
                update.className === 'UpdateEditChannelMessage';
            if (isEdit) {
                const msg = update.message;
                // Catch any inbound edit from the bot (not our own outgoing messages).
                // Some bots edit a different message than the one that had the buttons.
                if (!msg || msg.out)
                    return;
                // When a peer filter is given, ignore edits from unrelated chats
                if (peerId && (!msg.peerId || telegram_1.utils.getPeerId(msg.peerId) !== peerId))
                    return;
                finish(msg);
            }
        };
        client.addEventHandler(handler, new events_1.Raw({}));
    });
}
// Waits for any new message from the bot within the given timeout.
// Never rejects -- resolves null on timeout or abort.
function waitForNewBotMessage(client, botUsername, maxMs, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(null);
            return;
        }
        const finish = (msg) => {
            clearTimeout(timer);
            client.removeEventHandler(handler, new events_1.NewMessage({}));
            signal?.removeEventListener('abort', onAbort);
            resolve(msg);
        };
        const timer = setTimeout(() => finish(null), maxMs);
        const onAbort = () => finish(null);
        signal?.addEventListener('abort', onAbort, { once: true });
        const handler = async (event) => {
            finish(event.message);
        };
        client.addEventHandler(handler, new events_1.NewMessage({ fromUsers: [botUsername] }));
    });
}
function parseSpamStatus(text) {
    const lower = text.toLowerCase();
    if (lower.includes("good news") || lower.includes("no limits") || lower.includes("free as a bird"))
        return "free";
    if (lower.includes("permanently") || lower.includes("banned") || lower.includes("suspended"))
        return "blocked";
    // SpamBot says "blocked" for frozen accounts (temporary restriction, not a permanent ban)
    if (lower.includes("frozen") || lower.includes("blocked"))
        return "frozen";
    if (lower.includes("limited"))
        return "limited";
    return "unknown";
}
async function checkSpamStatus(apiId, apiHash, sessionString, proxy, deviceParams) {
    const SPAM_BOT = "SpamBot";
    const TIMEOUT_MS = 25000;
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 5,
        autoReconnect: false,
        baseLogger: new telegram_1.Logger(Logger_1.LogLevel.NONE),
        ...(proxy ? { proxy } : {}),
        ...(deviceParams ?? {}),
    });
    await client.connect();
    try {
        // Set up listener BEFORE sending to avoid missing a fast reply
        const replyPromise = new Promise((resolve, reject) => {
            let done = false;
            const finish = (result) => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                client.removeEventHandler(handler, new events_1.NewMessage({}));
                if (result instanceof Error)
                    reject(result);
                else
                    resolve(result);
            };
            const timer = setTimeout(() => finish(new Error("SpamBot did not reply in time")), TIMEOUT_MS);
            const handler = async (event) => {
                const msg = event.message;
                const text = (msg.message ?? "").trim();
                if (text)
                    finish({ text, id: msg.id });
            };
            client.addEventHandler(handler, new events_1.NewMessage({ fromUsers: [SPAM_BOT] }));
        });
        await client.sendMessage(SPAM_BOT, { message: "/start" });
        const { text: rawMessage, id: replyId } = await replyPromise;
        // Mark SpamBot conversation as read so it doesn't show as unread in the chat list
        try {
            const spamBotEntity = await client.getEntity(SPAM_BOT);
            await client.invoke(new telegram_1.Api.messages.ReadHistory({ peer: spamBotEntity, maxId: replyId }));
        }
        catch { /* non-critical, ignore */ }
        return { spamStatus: parseSpamStatus(rawMessage), rawMessage };
    }
    finally {
        // destroy, not disconnect -- disconnect leaves the GramJS ping loop running,
        // which pins the client and grows its send queue forever (issue #14)
        try {
            await client.destroy();
        }
        catch { /* ignore */ }
    }
}
async function runCheckin(apiId, apiHash, sessionString, botUsername, replyTimeoutMs = 40000, startCommand = '/start', checkinButton = '签到', attempt = 1, maxAiRetries = 0, signal, proxy, deviceParams, successContains, failContains, cfChallenge = false, webProxyUrl, 
// Shared across the runner's retries, so an exit refused earlier in this run is not
// offered again instead of the same few being cycled
cfRun = (0, cloudflare_1.newCfRunState)()) {
    const attemptStart = Date.now();
    const log = {
        attempt, commandSent: startCommand, hasMedia: false,
        commandResponseHtml: '', availableButtons: [],
        replyTimeoutMs,
    };
    const client = new telegram_1.TelegramClient(new sessions_1.StringSession(sessionString), apiId, apiHash, {
        connectionRetries: 5,
        autoReconnect: false,
        baseLogger: new telegram_1.Logger(Logger_1.LogLevel.NONE),
        ...(proxy ? { proxy } : {}),
        ...(deviceParams ?? {}),
    });
    const t_connect = Date.now();
    await client.connect();
    log.connectMs = Date.now() - t_connect;
    // Mini App buttons must be signed by Telegram before the page will accept us.
    const toOpenableUrl = async (web, msg) => {
        if (!web.miniApp)
            return web.url;
        log.cfMiniApp = true;
        const { url, signed } = await (0, miniApp_1.openableButtonUrl)(client, web, botUsername, msg);
        log.cfMiniAppSigned = signed;
        return url;
    };
    // Opens a checkin page in the installed browser, passing any Cloudflare challenge.
    // Returns the page text for success/fail matching.
    const openCheckinPage = async (url) => {
        if (!cfChallenge) {
            throw new Error('Checkin requires opening a Cloudflare-protected page ("I am not a bot"). Enable "Solve Cloudflare challenge" for this job.');
        }
        const host = (() => {
            try {
                return new URL(url).host;
            }
            catch {
                return '';
            }
        })();
        const refused = (0, cloudflare_1.cfRefusedFor)(cfRun, host);
        const candidates = (0, proxyProviders_1.cfProxyCandidatesFor)({ primaryUrl: webProxyUrl, host, exclude: refused });
        if (!candidates.length) {
            throw new Error((0, cloudflare_1.cfNoCandidatesMessage)(cfRun, host));
        }
        const result = await (0, cloudflare_1.loadCheckinUrl)(url, webProxyUrl, {
            miniApp: log.cfMiniApp,

            // Cloudflare refuses some exit IPs outright, so the rest of the pool stands by --
            // minus the ones this run has already had refused
            proxyCandidates: candidates,
        });
        for (const id of result.refusedProxyIds ?? [])
            refused.add(id);
        if (!result.ok)
            (0, cloudflare_1.cfNoteFailure)(cfRun, result.finalHost, result.reason);
        log.cfHost = result.finalHost;
        log.cfChallenged = result.challenged;
        log.cfPassed = result.ok;
        log.cfMiniAppAction = result.inAppAction;
        log.cfProxy = result.proxyLabel;
        log.cfBuild = result.browserTier;
        log.cfAttempts = result.attempts;
        if (result.ok && result.proxyId)
            (0, proxyProviders_1.rememberCfProxy)(result.finalHost, result.proxyId);
        if (!result.ok)
            throw new Error(result.reason ?? (0, cloudflare_1.cfFailureFallback)(result.challenged, log.cfMiniApp));
        return { text: result.text, returnUrl: result.returnUrl };
    };
    const assertOutcome = (...texts) => {
        if (!successContains && !failContains)
            return;
        // "already checked in today" is a success, not a miss: the bot refuses a second
        // checkin, so the success keyword never appears and the run would false-fail.
        const joined = texts.filter(Boolean).join('\n');
        // 有些机器人（如 @Lewa_user_bot）把"已签到"提示放在消息正文而非回调查询答案里，
        // 只查 callbackAnswer 会漏判 → 假失败。两处合起来判断。
        if (/已签到|已經簽到|已经签到过|已經簽到過|already/i.test((log.callbackAnswer ?? '') + '\n' + joined))
            return;
        if (failContains && joined.includes(failContains)) {
            throw new Error(`Reply indicates failure: "${failContains}" detected`);
        }
        if (successContains && !joined.includes(successContains)) {
            throw new Error(`Expected success indicator "${successContains}" not found in response`);
        }
    };
    try {
        if (signal?.aborted)
            throw new Error('Job cancelled');
        const expandedCommand = expandCommand(startCommand);
        log.commandSent = expandedCommand; // record what was actually sent, not the template
        const replyPromise = waitForBotReply(client, botUsername, replyTimeoutMs, signal);
        const t_send = Date.now();
        await client.sendMessage(botUsername, { message: expandedCommand });
        let messages;
        try {
            messages = await replyPromise;
            log.replyLatencyMs = Date.now() - t_send;
        }
        catch (err) {
            log.replyLatencyMs = Date.now() - t_send;
            if (err instanceof BotReplyTimeoutError && err.partial.length > 0) {
                const parsed = await parseMessages(err.partial, client, signal);
                log.hasMedia = parsed.hasMedia;
                log.commandResponseHtml = parsed.html;
                log.commandResponseImages = parsed.images;
                log.availableButtons = parsed.buttons;
            }
            // Some bots answer minutes or hours later, but a Mini App checkin button is a
            // standing entry point (unlike a one-shot verify link): open the one already in
            // the chat rather than failing on the reply that never came.
            if (cfChallenge && err instanceof BotReplyTimeoutError) {
                const standing = await findUrlButtonRecent(client, botUsername, signal, true);
                if (standing) {
                    log.cfFromHistory = true;
                    log.buttonClicked = standing.web.text;
                    const cfText = await openCheckinPage(await toOpenableUrl(standing.web, standing.msg));
                    assertOutcome(cfText);
                    log.totalMs = Date.now() - attemptStart;
                    return log;
                }
            }
            throw err;
        }
        const parsed = await parseMessages(messages, client, signal);
        log.hasMedia = parsed.hasMedia;
        log.commandResponseHtml = parsed.html;
        log.commandResponseImages = parsed.images;
        log.availableButtons = parsed.buttons;
        const buttonsMsg = [...messages].reverse().find(m => m.replyMarkup instanceof telegram_1.Api.ReplyInlineMarkup);
        if (!buttonsMsg)
            throw new Error('No message with buttons received');
        if (signal?.aborted)
            throw new Error('Job cancelled');
        const markup = buttonsMsg.replyMarkup;
        const allBtnRows = markup.rows;
        // Resolve target button text and match mode
        let targetText;
        let useExactMatch;
        if (checkinButton === '{anyBtn}') {
            const flat = allBtnRows.flatMap(row => row.buttons.map((btn) => btn.text));
            if (!flat.length)
                throw new Error('No buttons available for {anyBtn}');
            targetText = flat[Math.floor(Math.random() * flat.length)];
            useExactMatch = true;
        }
        else if (isAiBtn(checkinButton)) {
            const aiStart = Date.now();
            const hint = parseAiBtnHint(checkinButton);
            const aiResult = await selectButtonWithAI(log.availableButtons, log.commandResponseHtml, parsed.images, hint, maxAiRetries);
            targetText = aiResult.button;
            log.aiDurationMs = Date.now() - aiStart;
            log.aiPrompt = aiResult.prompt;
            log.aiResponse = aiResult.response;
            if (aiResult.retries.length)
                log.aiRetries = aiResult.retries;
            useExactMatch = true;
        }
        else {
            targetText = checkinButton;
            useExactMatch = false;
        }
        const peer = await client.getInputEntity(botUsername);
        const botPeerId = await client.getPeerId(botUsername);
        let clicked = false;
        // Set when the checkin completes by opening a web URL behind Cloudflare
        // (e.g. a "我不是机器人" link) rather than by a callback.
        let urlToOpen;
        for (const row of allBtnRows) {
            for (const btn of row.buttons) {
                const btnText = btn.text;
                const matches = useExactMatch ? btnText === targetText : btnText.includes(targetText);
                if (matches) {
                    // A URL or Mini App button carries the web checkin address; neither is
                    // clickable via callback, so we open it in a browser (below) to pass the
                    // CF check -- which is also how a real client runs a Mini App.
                    const web = (0, miniApp_1.webButtonOf)(btn);
                    if (web) {
                        urlToOpen = await toOpenableUrl(web, buttonsMsg);
                        log.buttonClicked = btnText;
                        clicked = true;
                        break;
                    }
                    if (!(btn instanceof telegram_1.Api.KeyboardButtonCallback)) {
                        const typeName = btn.className ?? btn.constructor?.name ?? 'unknown';
                        throw new Error(`Button "${btnText}" is a ${typeName}, not a callback button — only KeyboardButtonCallback can be clicked automatically`);
                    }
                    // Start watching BEFORE invoking to avoid missing a fast response.
                    // Edit listener catches any inbound bot edit (not just the buttons message).
                    const editPromise = waitForBotMessageEdit(client, buttonsMsg.id, replyTimeoutMs, signal, botPeerId);
                    const newMsgPromise = waitForNewBotMessage(client, botUsername, replyTimeoutMs, signal);
                    const preClickEditDate = buttonsMsg.editDate;
                    // 拟人化延迟：许多机器人（如 Coolguassl_bot）在收到菜单后需异步注册会话，
                    // 若收到菜单后 <1s 极速点击会被防自动化/防连击机制无视丢弃（返回 null）。
                    // 等待 1500ms 模拟真人阅屏点击，确保机器人后台就绪。
                    await new Promise(r => setTimeout(r, 1500));
                    const t_click = Date.now();
                    let answer = null;
                    let callbackTimedOut = false;
                    try {
                        answer = await client.invoke(new telegram_1.Api.messages.GetBotCallbackAnswer({
                            peer,
                            msgId: buttonsMsg.id,
                            data: btn.data,
                        }));
                    }
                    catch (err) {
                        // BOT_RESPONSE_TIMEOUT means the click reached the bot but it never called
                        // answerCallbackQuery -- the check-in may still have registered (the bot edits
                        // the message or acts via a follow-up Cloudflare page). Fall through and let
                        // the edit/new-message watchers below decide.
                        if (!err?.message?.includes('BOT_RESPONSE_TIMEOUT'))
                            throw err;
                        callbackTimedOut = true;
                    }
                    log.buttonClickMs = Date.now() - t_click;
                    log.buttonClicked = btnText;
                    if (answer?.message)
                        log.callbackAnswer = answer.message;
                    console.log(`[checkin] callback answer: message="${answer?.message ?? ''}" url="${answer?.url ?? ''}" alert=${answer?.alert ?? false}`);
                    clicked = true;
                    // The bot may answer with a URL to open (a web checkin / CF page).
                    if (answer?.url)
                        urlToOpen = answer.url;
                    // If the bot already confirmed via toast (answer.message), allow a short
                    // grace window for any follow-up edit/message; otherwise wait longer.
                    // 有些机器人（如 @Lewa_user_bot）签到是异步的：回调只回一句"签到中..."，
                    // 真实结果 1~2 分钟后才"编辑"到原消息上。原逻辑对"已有 toast"的情况只等 5 秒，
                    // 必然漏掉这类结果 → 假失败。改为等待完整的 replyTimeoutMs。
                    const capMs = Math.min(replyTimeoutMs, answer?.message ? 150000 : 30000);
                    const capPromise = new Promise(r => setTimeout(() => r({ msg: null, src: 'cap' }), capMs));
                    // Take whichever response arrives first; track the source for dev logs
                    const t_resp = Date.now();
                    const taggedEdit = editPromise.then(m => ({ msg: m, src: 'edit' }));
                    const taggedNew = newMsgPromise.then(m => ({ msg: m, src: 'new_message' }));
                    const { msg: responseMsg, src: respSrc } = await Promise.race([taggedEdit, taggedNew, capPromise]);
                    log.buttonResponseMs = Date.now() - t_resp;
                    if (responseMsg && !signal?.aborted) {
                        log.buttonResponseSource = respSrc;
                        const bp = await parseMessages([responseMsg], client, signal);
                        if (bp.html || bp.hasMedia) {
                            log.buttonResponseHtml = bp.html || undefined;
                            log.buttonResponseHasMedia = bp.hasMedia || undefined;
                            log.buttonResponseImage = bp.images[0];
                            log.buttonResponseButtons = bp.buttons.length ? bp.buttons : undefined;
                        }
                        // A follow-up URL / Mini App button (e.g. "我不是机器人") takes precedence
                        // as the step that actually completes the checkin.
                        if (!urlToOpen) {
                            const followUp = findUrlButton(responseMsg);
                            if (followUp)
                                urlToOpen = await toOpenableUrl(followUp, responseMsg);
                        }
                        const combinedText = [
                            log.buttonResponseHtml ? (0, exports.htmlToText)(log.buttonResponseHtml) : '',
                            responseMsg?.message || ''
                        ].join('\n');
                        const arithmeticAnswer = (0, cloudflare_1.solveArithmetic)(combinedText);
                        if (arithmeticAnswer && !urlToOpen) {
                            console.log(`[checkin] detected arithmetic question in response, solving: answer="${arithmeticAnswer}"`);
                            await client.sendMessage(botUsername, { message: arithmeticAnswer });
                            const nextReply = await (0, exports.waitForNewBotMessage)(client, botUsername, 10000, signal).catch(() => null);
                            if (nextReply) {
                                const nextBp = await (0, exports.parseMessages)([nextReply], client, signal);
                                if (nextBp.html) {
                                    log.buttonResponseHtml = (log.buttonResponseHtml ? log.buttonResponseHtml + '<br>' : '') + nextBp.html;
                                }
                            }
                        }
                    }
                    // A timed-out callback only counts as a failure if the bot never reacted. If no
                    // edit/new message was seen live, re-fetch the message: a changed editDate proves
                    // the bot processed the click and the check-in registered.
                    if ((callbackTimedOut || !answer?.message) && !responseMsg && !signal?.aborted && !urlToOpen) {
                        const fresh = await client
                            .getMessages(botUsername, { ids: [buttonsMsg.id] })
                            .then(r => r?.[0] ?? null)
                            .catch(() => null);
                        const freshEditDate = fresh?.editDate;
                        const wasEdited = !!fresh && !!freshEditDate && freshEditDate !== preClickEditDate;
                        if (!wasEdited) {
                            throw new Error(`Button "${btnText}" click timed out (BOT_RESPONSE_TIMEOUT) with no response`);
                        }
                        log.buttonResponseSource = 'edit';
                        const bp = await parseMessages([fresh], client, signal);
                        if (bp.html || bp.hasMedia) {
                            log.buttonResponseHtml = bp.html || undefined;
                            log.buttonResponseHasMedia = bp.hasMedia || undefined;
                            log.buttonResponseImage = bp.images[0];
                            log.buttonResponseButtons = bp.buttons.length ? bp.buttons : undefined;
                        }
                    }
                    break;
                }
            }
            if (clicked)
                break;
        }
        const notFoundLabel = isAiBtn(checkinButton) ? `{aiBtn} -> "${targetText}"` : `"${checkinButton}"`;
        if (!clicked)
            throw new Error(`Button ${notFoundLabel} not found in bot reply`);
        // The verify/CF prompt is often one of several follow-up messages, so fall
        // back to scanning recent messages if the raced reply didn't carry it.
        if (cfChallenge && !urlToOpen) {
            const alreadyDone = /已签到|已經簽到|已经签到过|已經簽到過|already/i.test(log.callbackAnswer ?? '');
            if (!alreadyDone) {
                const recent = await findUrlButtonRecent(client, botUsername, signal);
                if (recent)
                    urlToOpen = await toOpenableUrl(recent.web, recent.msg);
            }
        }
        // Some bots complete (or unlock) the checkin only after a Cloudflare-gated web
        // page is opened: a "我不是机器人" URL button, or a Mini App button ("Verify",
        // "打开小程序签到") whose page carries the challenge. Open it in the installed
        // browser to pass the check.
        let cfPageText = '';
        let reclickText = '';
        if (urlToOpen) {
            const pageRes = await openCheckinPage(urlToOpen);
            cfPageText = typeof pageRes === 'string' ? pageRes : (pageRes?.text ?? '');
            const returnUrl = typeof pageRes === 'object' ? pageRes?.returnUrl : undefined;
            if (returnUrl && returnUrl.includes('start=')) {
                const m = returnUrl.match(/start=([a-zA-Z0-9_-]+)/);
                if (m) {
                    console.log(`[checkin] Follow-up return_url detected startParam="${m[1]}", sending to bot ${botUsername}`);
                    await client.sendMessage(botUsername, { message: `/start ${m[1]}` });
                    const retReply = await (0, exports.waitForNewBotMessage)(client, botUsername, replyTimeoutMs, signal).catch(() => null);
                    if (retReply) {
                        const bp = await (0, exports.parseMessages)([retReply], client, signal);
                        reclickText = (0, exports.htmlToText)(bp.html ?? '');
                    }
                }
            } else {
                // Verify pages only unlock the checkin; re-click the button to register it.
                reclickText = await reclickCheckinButton(client, botUsername, log.buttonClicked ?? checkinButton, replyTimeoutMs, signal);
            }
        }
        // Check success/fail text in callback answer, button response, CF page, or re-click
        assertOutcome(log.callbackAnswer ?? '', htmlToText(log.buttonResponseHtml ?? ''), cfPageText, reclickText);
        log.totalMs = Date.now() - attemptStart;
        return log;
    }
    catch (err) {
        log.error = err?.message ?? String(err);
        log.errorName = err?.name ?? err?.constructor?.name;
        log.totalMs = Date.now() - attemptStart;
        if (Array.isArray(err?.aiRetries) && err.aiRetries.length)
            log.aiRetries = err.aiRetries;
        throw new CheckinError(log.error, log);
    }
    finally {
        // GramJS throws TIMEOUT when the update loop stops; always swallow here.
        // destroy, not disconnect -- only destroy stops the ping loop (issue #14)
        try {
            await client.destroy();
        }
        catch { /* ignore */ }
    }
}
