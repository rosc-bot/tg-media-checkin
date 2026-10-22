"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.testEmbyConnection = testEmbyConnection;
exports.runEmbywatch = runEmbywatch;
const undici_1 = require("undici");
const node_dns_1 = require("node:dns");
const database_1 = require("../db/database");
const checkin_1 = require("./checkin");
// Per-username cache of the expanded device name. Persisting it keeps random
// tokens (e.g. {word:4}) stable across runs; we only re-expand when the template
// changes (captured by `sig`). Keyed by Emby username since {username} varies.
const DEVICE_NAMES_KEY = 'emby_device_names';
function readDeviceNames() {
    try {
        const row = database_1.db.prepare('SELECT value FROM settings WHERE key = ?').get(DEVICE_NAMES_KEY);
        if (!row?.value)
            return {};
        return JSON.parse(row.value);
    }
    catch {
        return {};
    }
}
function saveDeviceName(username, entry) {
    const map = readDeviceNames();
    map[username] = entry;
    database_1.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(DEVICE_NAMES_KEY, JSON.stringify(map));
}
// Expand template variables in the device name. {username} is the Emby account
// username for the job; random tokens ({word:N}, {num:N}, {alpha:N}, {uuid})
// come from expandCommand. The expanded value is persisted per username so random
// tokens stay stable across runs, and is only re-rolled when the template changes.
function resolveDeviceName(template, username) {
    if (!template.includes('{'))
        return template;
    const sig = template;
    const cached = readDeviceNames()[username];
    if (cached && cached.sig === sig)
        return cached.deviceName;
    const deviceName = (0, checkin_1.expandCommand)(template, { username });
    saveDeviceName(username, { sig, deviceName });
    return deviceName;
}
// Forces IPv4-only DNS resolution so Happy Eyeballs doesn't waste the connect
// timeout on broken IPv6 routes in container environments.
const ipv4Agent = new undici_1.Agent({
    connect: { lookup: (hostname, opts, cb) => (0, node_dns_1.lookup)(hostname, { ...opts, family: 4 }, cb) },
});
// One dispatcher per proxy URL, reused for the life of the process. A fresh ProxyAgent
// per request leaves its keep-alive sockets open until they time out, so a long watch
// session paid a new tunnel handshake every call and dragged RSS up with it. The map is
// bounded by the number of configured proxies.
const proxyAgents = new Map();
function dispatcherFor(proxyUrl) {
    if (!proxyUrl)
        return ipv4Agent;
    let agent = proxyAgents.get(proxyUrl);
    if (!agent) {
        agent = new undici_1.ProxyAgent(proxyUrl);
        proxyAgents.set(proxyUrl, agent);
    }
    return agent;
}
const DEFAULT_UA = 'SenPlayer/6.1.2 CFNetwork/1490.0.4 Darwin/23.2.0';
const PROGRESS_INTERVAL_S = 30;
// Real Watch pace assumed (~4 Mbps) when the server exposes neither a file size
// nor a bitrate, so streaming still happens instead of being skipped.
const ASSUMED_BYTES_PER_SECOND = 500000;
// Emby uses 100-nanosecond ticks (same as .NET TimeSpan)
const TICKS_PER_SECOND = 10000000;
function getSetting(key) {
    const row = database_1.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row?.value;
}
// Job cancellation. The runner reports a job as "Cancelled" only when the error
// message is exactly this, so every abort path must surface it.
const CANCELLED = 'Job cancelled';
function throwIfAborted(signal) {
    if (signal?.aborted)
        throw new Error(CANCELLED);
}
/** setTimeout that rejects immediately when the job is cancelled. */
function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error(CANCELLED));
            return;
        }
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error(CANCELLED));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}
// Emby's dashboard shows the session's app name/version from the Client and
// Version fields of X-Emby-Authorization, not the HTTP User-Agent. Derive them
// from the chosen UA so a custom preset (e.g. "CapyPlayer/1.0") is reflected in
// the Emby backend instead of a hardcoded client name.
function parseUaClient(ua) {
    const match = /^([^/\s]+)\/([^\s(]+)/.exec(ua.trim());
    if (match?.[1] && match?.[2]) {
        return { client: match[1], version: match[2] };
    }
    return parseUaClient(DEFAULT_UA);
}
function buildAuthHeader(deviceName, ua, token) {
    // DeviceId must stay URL-safe: some stream proxies embed it in signed
    // redirect URLs and break on whitespace (the display name can keep spaces)
    const deviceId = `${deviceName.replace(/\s+/g, '-')}`;
    const { client, version } = parseUaClient(ua);
    const parts = [
        `MediaBrowser Client="${client}"`,
        `Device="${deviceName}"`,
        `DeviceId="${deviceId}"`,
        `Version="${version}"`,
    ];
    if (token)
        parts.push(`Token="${token}"`);
    return parts.join(', ');
}
async function embyRequest(baseUrl, path, 
// `signal` aborts the request itself (e.g. a timeout); `cancelSignal` is the
// job's cancellation signal and additionally maps the abort to a Job cancelled
// error so the runner records the run as Cancelled rather than unreachable.
opts) {
    const url = `${baseUrl.replace(/\/$/, '')}${path}`;
    const method = opts.method ?? 'GET';
    const headers = {
        'Content-Type': 'application/json',
        'User-Agent': opts.ua,
        'X-Emby-Authorization': buildAuthHeader(opts.deviceName, opts.ua, opts.token),
    };
    const body = opts.body != null ? JSON.stringify(opts.body) : undefined;
    throwIfAborted(opts.cancelSignal);
    let res;
    try {
        res = await (0, undici_1.fetch)(url, {
            method,
            headers,
            body,
            signal: opts.signal ?? opts.cancelSignal,
            dispatcher: dispatcherFor(opts.proxyUrl),
        });
    }
    catch (err) {
        throwIfAborted(opts.cancelSignal);
        // Network-level failure (ECONNREFUSED, ENOTFOUND, timeout, etc.)
        const cause = err?.cause?.message ?? err?.cause?.code ?? '';
        throw new Error(`Cannot reach Emby server at ${url}${cause ? ` — ${cause}` : ''}`);
    }
    const text = await res.text();
    if (!res.ok) {
        // Try to extract a human-readable message from Emby's JSON error body
        let detail = text;
        try {
            const json = JSON.parse(text);
            if (typeof json.Message === 'string' && json.Message)
                detail = json.Message;
            else if (typeof json.message === 'string' && json.message)
                detail = json.message;
        }
        catch { /* leave detail as raw text */ }
        throw new Error(`Emby ${method} ${path} → ${res.status} ${res.statusText}: ${detail}`);
    }
    return text ? JSON.parse(text) : null;
}
/** Resolves a configured proxy id to its URL from settings, if any. */
function resolveProxyUrl(proxyId) {
    if (!proxyId)
        return undefined;
    try {
        const raw = getSetting('proxies');
        if (!raw)
            return undefined;
        const list = JSON.parse(raw);
        return list.find(p => p.id === proxyId)?.url;
    }
    catch {
        return undefined;
    }
}
// Cap the connection test so the UI isn't stuck waiting on a dead host
const TEST_TIMEOUT_MS = 12000;
/**
 * Authenticates against the Emby server without playing anything, so the UI
 * can confirm the server is reachable and the credentials are valid before a
 * job is saved.
 */
async function testEmbyConnection(serverUrl, opts) {
    const ua = opts.userAgent || getSetting('default_ua') || DEFAULT_UA;
    const deviceName = resolveDeviceName(getSetting('default_device_name') ?? 'Mac', opts.username);
    const proxyUrl = resolveProxyUrl(opts.proxyId);
    try {
        const auth = await embyRequest(serverUrl, '/Users/AuthenticateByName', {
            method: 'POST',
            ua,
            deviceName,
            proxyUrl,
            signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
            body: { Username: opts.username, Pw: opts.password },
        });
        return { ok: true, userName: auth?.User?.Name };
    }
    catch (err) {
        return { ok: false, error: err?.message ?? 'Connection failed' };
    }
}
// Number of random items to try before giving up when verifying playability.
const MAX_PICK_ATTEMPTS = 5;
// Byte range fetched to confirm the media file is actually readable.
const PROBE_RANGE_BYTES = 65535;
/**
 * Fetch the first bytes of a stream URL, as a real player would.
 * A readable file yields 206 (partial) or 200 with body bytes.
 */
async function probeStream(url, opts) {
    try {
        const res = (await (0, undici_1.fetch)(url, {
            method: 'GET',
            headers: {
                'User-Agent': opts.ua,
                Range: `bytes=0-${PROBE_RANGE_BYTES}`,
            },
            signal: opts.signal,
            dispatcher: dispatcherFor(opts.proxyUrl),
        }));
        if (res.status !== 200 && res.status !== 206) {
            await res.body?.cancel?.();
            return false;
        }
        // Read one chunk and stop, rather than buffering the response. A 200 here means the
        // server ignored the Range header and is sending the whole file (common when a proxy
        // fronts Emby), so reading it in full would pull an entire movie into memory.
        const reader = res.body?.getReader?.();
        if (!reader)
            return false;
        try {
            const { done, value } = await reader.read();
            return !done && (value?.byteLength ?? 0) > 0;
        }
        finally {
            try {
                await reader.cancel?.();
            }
            catch { /* already closed */ }
        }
    }
    catch {
        // A cancelled job must abort, not be read as an unplayable item
        throwIfAborted(opts.signal);
        // Network-level failure reaching the stream, treat as unavailable
        return false;
    }
}
/**
 * Ask PlaybackInfo for the stream URL a real client would play. Some servers
 * front Emby with a proxy that only routes this form (e.g. redirecting
 * /videos/{id}/original.{container} to a dedicated stream host) and return
 * errors for the generic /Videos/{id}/stream path.
 */
async function getClientStreamUrl(baseUrl, itemId, mediaSourceId, opts) {
    try {
        const info = await embyRequest(baseUrl, `/Items/${itemId}/PlaybackInfo?UserId=${opts.userId}`, {
            method: 'POST',
            ua: opts.ua,
            token: opts.token,
            deviceName: opts.deviceName,
            proxyUrl: opts.proxyUrl,
            cancelSignal: opts.signal,
            body: { DeviceProfile: { MaxStreamingBitrate: 140000000 } },
        });
        const sources = info?.MediaSources ?? [];
        const source = sources.find(s => s.Id === mediaSourceId) ?? sources[0];
        // directOnly keeps Real Watch on direct play; transcodeOnly is its last-resort
        // fallback for servers that advertise no direct stream at all
        const path = opts.directOnly
            ? source?.DirectStreamUrl
            : opts.transcodeOnly
                ? source?.TranscodingUrl
                : (source?.DirectStreamUrl ?? source?.TranscodingUrl ?? undefined);
        if (!path)
            return undefined;
        if (/^https?:\/\//i.test(path))
            return path;
        return `${baseUrl.replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
    }
    catch {
        throwIfAborted(opts.signal);
        // PlaybackInfo unsupported or failed, caller falls back to the static URL
        return undefined;
    }
}
/**
 * Confirm the media file is actually streamable, mimicking what a real player
 * does: fetch the first bytes of the stream. If the disk/mount is down, Emby
 * can't read the file and returns a non-2xx (or an empty body), so we treat the
 * item as unavailable and avoid reporting a fake watch.
 */
async function isMediaAvailable(baseUrl, itemId, mediaSourceId, opts) {
    // Prefer the URL a real client would play; proxies that offload streaming
    // to another host often only route this form
    const clientUrl = await getClientStreamUrl(baseUrl, itemId, mediaSourceId, opts);
    if (clientUrl && (await probeStream(clientUrl, opts)))
        return true;
    // Fall back to the generic static stream URL
    const params = new URLSearchParams({
        static: 'true',
        mediaSourceId,
        api_key: opts.token,
    });
    const staticUrl = `${baseUrl.replace(/\/$/, '')}/Videos/${itemId}/stream?${params.toString()}`;
    return probeStream(staticUrl, opts);
}
function appendParam(url, key, value) {
    return `${url}${url.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
}
// Static direct-play stream URL, tied to the play session so the byte transfer
// registers against the reported Now Playing session on the Emby dashboard.
function buildStaticStreamUrl(baseUrl, itemId, mediaSourceId, opts) {
    const params = new URLSearchParams({
        static: 'true',
        mediaSourceId,
        api_key: opts.token,
        PlaySessionId: opts.playSessionId,
        DeviceId: opts.deviceId,
    });
    return `${baseUrl.replace(/\/$/, '')}/Videos/${itemId}/stream?${params.toString()}`;
}
// Learn whether a stream URL is servable and, when it says so, its total size, so
// we can map a playback position to a byte offset. Servers behind proxies often
// answer without a length (chunked, redirected, or transcoding), which is fine:
// the caller streams open-ended instead of skipping Real Watch.
async function probeStreamSize(url, opts) {
    try {
        const res = (await (0, undici_1.fetch)(url, {
            method: 'GET',
            headers: { 'User-Agent': opts.ua, Range: 'bytes=0-0' },
            signal: opts.signal,
            dispatcher: dispatcherFor(opts.proxyUrl),
        }));
        const contentRange = res.headers.get('content-range');
        const contentLength = res.headers.get('content-length');
        await res.body?.cancel?.();
        const ok = res.status === 200 || res.status === 206;
        if (!ok)
            return { ok: false, size: 0 };
        if (contentRange) {
            const m = /\/(\d+)\s*$/.exec(contentRange);
            if (m)
                return { ok, size: Number(m[1]) };
        }
        if (res.status === 200 && contentLength)
            return { ok, size: Number(contentLength) };
        return { ok, size: 0 };
    }
    catch {
        throwIfAborted(opts.signal);
        return { ok: false, size: 0 };
    }
}
// An HLS playlist is a text manifest, not media bytes, so its length says nothing
// about the media and it has to be drained segment by segment.
function isHlsUrl(url) {
    return /\.m3u8(\?|$)/i.test(url);
}
function withPlaySession(url, playSessionId) {
    return /PlaySessionId=/.test(url) ? url : appendParam(url, 'PlaySessionId', playSessionId);
}
/**
 * Resolve the URL Real Watch streams from, in the order a real client would
 * settle on one: the static direct-play route, then the direct-stream URL
 * PlaybackInfo advertises (some proxies only route that form), and finally the
 * transcode stream for servers that offer no direct play at all. Transcoded bytes
 * are still real traffic, they just cost the server more.
 */
async function resolveRealStreamUrl(baseUrl, itemId, mediaSourceId, opts) {
    const staticUrl = buildStaticStreamUrl(baseUrl, itemId, mediaSourceId, opts);
    const staticProbe = await probeStreamSize(staticUrl, opts);
    if (staticProbe.ok)
        return { url: staticUrl, size: staticProbe.size, transcoding: false, hls: false };
    const direct = await getClientStreamUrl(baseUrl, itemId, mediaSourceId, { ...opts, directOnly: true });
    if (direct) {
        const url = withPlaySession(direct, opts.playSessionId);
        const probe = await probeStreamSize(url, opts);
        if (probe.ok)
            return { url, size: probe.size, transcoding: false, hls: isHlsUrl(url) };
    }
    // Direct play is unavailable or unservable: fall back to the transcode stream.
    const transcode = await getClientStreamUrl(baseUrl, itemId, mediaSourceId, { ...opts, transcodeOnly: true });
    if (!transcode)
        return undefined;
    const url = withPlaySession(transcode, opts.playSessionId);
    const probe = await probeStreamSize(url, opts);
    if (!probe.ok)
        return undefined;
    const hls = isHlsUrl(url);
    return { url, size: hls ? 0 : probe.size, transcoding: true, hls };
}
/**
 * Download bytes from a URL at real playback pace and discard them, so the
 * transfer looks like a player buffering without holding the chunk in memory.
 * `end` may be omitted for an open-ended range when the file size is unknown;
 * `maxBytes` then bounds how much of it is read before the body is released.
 */
async function drainRange(url, start, end, opts) {
    const res = (await (0, undici_1.fetch)(url, {
        method: 'GET',
        headers: { 'User-Agent': opts.ua, Range: `bytes=${start}-${end ?? ''}` },
        signal: opts.signal,
        dispatcher: dispatcherFor(opts.proxyUrl),
    }));
    if (res.status !== 200 && res.status !== 206) {
        await res.body?.cancel?.();
        throw new Error(`stream returned ${res.status}`);
    }
    // Cap how much of the body is read: `end` gives the requested window, maxBytes bounds an
    // open-ended range, and an HLS segment (neither set) is read to EOF. A server that ignores
    // Range answers 200 with the whole file, so without a cap one interval would pull the
    // entire movie. Stopping only once the cap is passed lets a compliant 206 finish on `done`,
    // which leaves its socket reusable.
    const cap = Math.min(end != null ? end - start + 1 : Infinity, opts.maxBytes ?? Infinity);
    let bytes = 0;
    const reader = res.body?.getReader?.();
    if (reader) {
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                if (value)
                    bytes += value.byteLength;
                if (bytes > cap)
                    break;
            }
        }
        finally {
            try {
                await reader.cancel?.();
            }
            catch { /* already closed */ }
        }
    }
    return bytes;
}
// Fetch a text body (HLS playlists), returning undefined rather than throwing so
// a manifest hiccup only disables streaming for the segment.
async function fetchText(url, opts) {
    try {
        const res = (await (0, undici_1.fetch)(url, {
            method: 'GET',
            headers: { 'User-Agent': opts.ua },
            signal: opts.signal,
            dispatcher: dispatcherFor(opts.proxyUrl),
        }));
        if (!res.ok) {
            await res.body?.cancel?.();
            return undefined;
        }
        return await res.text();
    }
    catch {
        throwIfAborted(opts.signal);
        return undefined;
    }
}
/**
 * Resolve an HLS master/media playlist to its segment list. A master playlist
 * (variant streams only) is followed one level to its first variant.
 */
async function loadHlsSegments(playlistUrl, opts, depth = 0) {
    const body = await fetchText(playlistUrl, opts);
    if (!body)
        return [];
    const lines = body.split(/\r?\n/).map(l => l.trim());
    const abs = (uri) => new URL(uri, playlistUrl).toString();
    if (lines.some(l => l.startsWith('#EXT-X-STREAM-INF'))) {
        if (depth > 0)
            return [];
        const idx = lines.findIndex(l => l.startsWith('#EXT-X-STREAM-INF'));
        const variant = lines.slice(idx + 1).find(l => l && !l.startsWith('#'));
        return variant ? loadHlsSegments(abs(variant), opts, depth + 1) : [];
    }
    const segments = [];
    let duration = 0;
    for (const line of lines) {
        if (line.startsWith('#EXTINF:')) {
            duration = Number.parseFloat(line.slice('#EXTINF:'.length)) || 0;
        }
        else if (line && !line.startsWith('#')) {
            segments.push({ url: abs(line), duration });
            duration = 0;
        }
    }
    return segments;
}
function toSegment(candidate) {
    const itemId = candidate.Id;
    return {
        item: candidate,
        itemId,
        mediaSourceId: candidate.MediaSources?.[0]?.Id ?? itemId,
        runtimeSeconds: candidate.RunTimeTicks ? Math.floor(candidate.RunTimeTicks / TICKS_PER_SECOND) : 0,
    };
}
function reqOpts(ctx) {
    return { ua: ctx.ua, token: ctx.token, deviceName: ctx.deviceName, proxyUrl: ctx.proxyUrl, cancelSignal: ctx.signal };
}
function mediaOpts(ctx) {
    return { token: ctx.token, ua: ctx.ua, userId: ctx.userId, deviceName: ctx.deviceName, proxyUrl: ctx.proxyUrl, signal: ctx.signal };
}
/**
 * Build the Real Watch byte puller for a segment: resolve a stream URL, work out
 * a playback rate, and pick the strategy that suits what the server exposes
 * (ranged reads when the size is known, open-ended reads when it isn't, segment
 * reads for HLS). Returns undefined only when no URL is servable at all.
 */
async function buildStreamer(serverUrl, ctx, seg) {
    const { itemId, mediaSourceId, item, runtimeSeconds } = seg;
    const net = { ua: ctx.ua, proxyUrl: ctx.proxyUrl, signal: ctx.signal };
    const resolved = await resolveRealStreamUrl(serverUrl, itemId, mediaSourceId, {
        ...mediaOpts(ctx),
        playSessionId: ctx.playSessionId,
        deviceId: ctx.deviceName.replace(/\s+/g, '-'),
    });
    if (!resolved)
        return undefined;
    const source = item.MediaSources?.[0];
    const fileSize = resolved.size > 0 ? resolved.size : Number(source?.Size) || 0;
    const bytesPerSecond = fileSize > 0 && runtimeSeconds > 0
        ? fileSize / runtimeSeconds
        : Number(source?.Bitrate) > 0
            ? Number(source.Bitrate) / 8
            : ASSUMED_BYTES_PER_SECOND;
    const kind = resolved.hls ? 'HLS transcode' : resolved.transcoding ? 'transcode' : 'direct';
    const rate = `~${Math.round((bytesPerSecond * 8) / 1000)} kbps`;
    console.log(`[embywatch] Real Watch — ${rate} ${kind} stream for "${item.Name}"${fileSize > 0 ? '' : ' (size unknown)'}`);
    if (resolved.hls) {
        const segments = await loadHlsSegments(resolved.url, net);
        if (!segments.length)
            return undefined;
        // Walk the playlist in step with playback, skipping past what the reported
        // position has already covered so a resume doesn't re-download the start.
        // Only when the playlist spans that position though: a transcode session
        // started mid-item lists segments from the current position, not from zero.
        const playlistSeconds = segments.reduce((s, e) => s + e.duration, 0);
        let cursor = 0;
        let covered = 0;
        return {
            transcoding: true,
            pull: async (from, to) => {
                while (playlistSeconds > from &&
                    cursor < segments.length &&
                    covered + segments[cursor].duration <= from) {
                    covered += segments[cursor].duration;
                    cursor++;
                }
                const window = Math.max(0, to - from);
                let bytes = 0;
                let pulled = 0;
                while (cursor < segments.length && pulled < window) {
                    const s = segments[cursor];
                    bytes += await drainRange(s.url, 0, undefined, net);
                    pulled += s.duration > 0 ? s.duration : window;
                    covered += s.duration;
                    cursor++;
                }
                return bytes;
            },
        };
    }
    const offsetAt = (sec) => {
        const at = Math.max(0, Math.floor(sec * bytesPerSecond));
        return fileSize > 0 ? Math.min(fileSize - 1, at) : at;
    };
    // With an unknown size the byte offset is only an estimate, so it can land past
    // the end of the file. The first 416 drops us back to reading from the start.
    let useOffsets = true;
    return {
        transcoding: resolved.transcoding,
        pull: async (from, to) => {
            const start = useOffsets ? offsetAt(from) : 0;
            if (fileSize > 0) {
                const end = Math.max(start, offsetAt(to) - 1);
                return drainRange(resolved.url, start, end, net);
            }
            // Size unknown: read open-ended and stop at this window's byte budget.
            const maxBytes = Math.max(1, Math.floor((to - from) * bytesPerSecond));
            try {
                return await drainRange(resolved.url, start, undefined, { ...net, maxBytes });
            }
            catch (e) {
                if (start === 0 || !/416/.test(String(e?.message)))
                    throw e;
                useOffsets = false;
                return drainRange(resolved.url, 0, undefined, { ...net, maxBytes });
            }
        },
    };
}
/** POST /Sessions/Playing → progress loop (+ Real Watch byte streaming) → /Sessions/Playing/Stopped. */
async function playSegment(serverUrl, ctx, seg, startSeconds, watchSeconds) {
    const { itemId, mediaSourceId } = seg;
    const startTicks = startSeconds * TICKS_PER_SECOND;
    // 先向服务器注册播放会话：部分分支（如 SNTP Lite 4.9.5）只认它自己签发的
    // PlaySessionId，客户端自造的 ID 会被拒（400 invalid_request / 409 playback_state_unavailable）。
    // 注册失败则沿用本地 PSID，对本来正常的服务器行为完全不变。
    let playSessionId = ctx.playSessionId;
    try {
        const info = await embyRequest(serverUrl, `/Items/${itemId}/PlaybackInfo?UserId=${ctx.userId}&PlaySessionId=${ctx.playSessionId}${mediaSourceId ? `&MediaSourceId=${mediaSourceId}` : ''}&StartTimeTicks=${startTicks}`, reqOpts(ctx));
        if (info && info.PlaySessionId)
            playSessionId = info.PlaySessionId;
    }
    catch { /* 注册失败：沿用本地 PSID */ }
    const playingBody = {
        ItemId: itemId,
        MediaSourceId: mediaSourceId,
        PlaySessionId: playSessionId,
        PositionTicks: startTicks,
        IsPaused: false,
        CanSeek: true,
    };
    try {
        await embyRequest(serverUrl, '/Sessions/Playing', { method: 'POST', ...reqOpts(ctx), body: playingBody });
    }
    catch (e) {
        // 兜底：仍被拒时重新注册一次，用服务端最新签发的 PSID 再试一次，其它错误原样抛出。
        const msg = String((e && e.message) || e);
        if (!/playback_state_unavailable|invalid_request|Sessions\/Playing \u2192 (400|409)/.test(msg))
            throw e;
        try {
            const info = await embyRequest(serverUrl, `/Items/${itemId}/PlaybackInfo?UserId=${ctx.userId}&PlaySessionId=${ctx.playSessionId}${mediaSourceId ? `&MediaSourceId=${mediaSourceId}` : ''}&StartTimeTicks=${startTicks}`, reqOpts(ctx));
            if (info && info.PlaySessionId)
                playSessionId = info.PlaySessionId;
        }
        catch { }
        await embyRequest(serverUrl, '/Sessions/Playing', { method: 'POST', ...reqOpts(ctx), body: { ...playingBody, PlaySessionId: playSessionId } });
    }
    // Real Watch: resolve a stream and pull the media bytes a real client would,
    // in step with the reported position. When nothing is servable we record why,
    // so the log explains itself instead of just reporting 0 bytes.
    let streamedBytes = 0;
    let streamer;
    let note;
    if (ctx.realWatch) {
        streamer = await buildStreamer(serverUrl, ctx, seg);
        if (!streamer) {
            note = 'no-stream-url';
            console.warn('[embywatch] Real Watch: the server serves no direct-play or transcode stream — streaming skipped for this segment');
        }
    }
    let elapsed = 0;
    let progressUnsupported = false;
    try {
        while (elapsed < watchSeconds) {
            const wait = Math.min(PROGRESS_INTERVAL_S, watchSeconds - elapsed);
            if (streamer) {
                // Pull this interval's byte window while waiting, so real streaming
                // traffic tracks the reported position like an actual player.
                const from = startSeconds + elapsed;
                await Promise.all([
                    sleep(wait * 1000, ctx.signal),
                    streamer
                        .pull(from, from + wait)
                        .then(b => {
                        streamedBytes += b;
                    })
                        .catch(e => {
                        if (ctx.signal?.aborted)
                            return; // cancellation surfaces via sleep
                        console.warn('[embywatch] Real Watch stream chunk failed:', e?.message ?? e);
                    }),
                ]);
            }
            else {
                await sleep(wait * 1000, ctx.signal);
            }
            elapsed += wait;
            // Progress 是心跳；个别分支没有该接口(404)或会话租约失效(409)，只跳过并记一次日志，
            // 不能让整个保活流程失败。
            if (!progressUnsupported) {
                try {
                    await embyRequest(serverUrl, '/Sessions/Playing/Progress', {
                        method: 'POST',
                        ...reqOpts(ctx),
                        body: {
                            ItemId: itemId,
                            MediaSourceId: mediaSourceId,
                            PlaySessionId: playSessionId,
                            PositionTicks: startTicks + elapsed * TICKS_PER_SECOND,
                            IsPaused: false,
                        },
                    });
                }
                catch (err) {
                    progressUnsupported = true;
                    console.warn(`[embywatch] Progress 心跳不被该服务器支持（${String(err?.message ?? err).slice(0, 120)}）— 已跳过，不影响保活结果`);
                }
            }
        }
    }
    catch (err) {
        // Cancelled (or failed) mid-playback: still tell Emby we stopped, otherwise
        // the session lingers in Now Playing until the server times it out.
        await reportStopped(serverUrl, ctx, seg, startSeconds + elapsed, playSessionId).catch(() => { });
        throw err;
    }
    await reportStopped(serverUrl, ctx, seg, startSeconds + watchSeconds, playSessionId);
    // A resolved stream that yielded nothing means every ranged read failed.
    if (ctx.realWatch && !note && streamedBytes === 0)
        note = 'stream-failed';
    return { streamedBytes, note, transcoded: streamer?.transcoding };
}
// The Stopped report deliberately ignores the job's cancel signal — it is the
// cleanup for a cancelled run, so it gets its own timeout instead.
const STOP_REPORT_TIMEOUT_MS = 10000;
async function reportStopped(serverUrl, ctx, seg, positionSeconds, playSessionId = ctx.playSessionId) {
    await embyRequest(serverUrl, '/Sessions/Playing/Stopped', {
        method: 'POST',
        ua: ctx.ua,
        token: ctx.token,
        deviceName: ctx.deviceName,
        proxyUrl: ctx.proxyUrl,
        signal: AbortSignal.timeout(STOP_REPORT_TIMEOUT_MS),
        body: {
            ItemId: seg.itemId,
            MediaSourceId: seg.mediaSourceId,
            PlaySessionId: playSessionId,
            PositionTicks: positionSeconds * TICKS_PER_SECOND,
        },
    });
}
async function markPlayed(serverUrl, ctx, itemId) {
    try {
        await embyRequest(serverUrl, `/Users/${ctx.userId}/PlayedItems/${itemId}`, { method: 'POST', ...reqOpts(ctx) });
        return true;
    }
    catch (e) {
        throwIfAborted(ctx.signal);
        console.warn('[embywatch] Failed to mark item as watched:', e);
        return false;
    }
}
/** First streamable segment from a candidate list, honouring verifyPlayable. */
async function firstPlayable(serverUrl, ctx, candidates, verifyPlayable) {
    for (const candidate of candidates) {
        throwIfAborted(ctx.signal);
        const seg = toSegment(candidate);
        if (!verifyPlayable || (await isMediaAvailable(serverUrl, seg.itemId, seg.mediaSourceId, mediaOpts(ctx)))) {
            return seg;
        }
        console.warn(`[embywatch] "${candidate.Name}" is not streamable — trying another item`);
    }
    return undefined;
}
/**
 * Resolve a configured library (name or 1-based index) to its Emby id. Returns
 * undefined when blank or unmatched, so callers fall back to the whole server.
 */
async function resolveLibraryId(serverUrl, ctx, library) {
    const raw = (library ?? '').trim();
    if (!raw)
        return undefined;
    try {
        const views = await embyRequest(serverUrl, `/Users/${ctx.userId}/Views`, reqOpts(ctx));
        const items = views.Items ?? [];
        // Name match first, so a library literally named "4" wins over index 4.
        const byName = items.find(v => (v.Name ?? '').trim().toLowerCase() === raw.toLowerCase());
        if (byName)
            return byName.Id;
        if (/^\d+$/.test(raw)) {
            const idx = Number(raw) - 1; // 1-based
            if (idx >= 0 && idx < items.length)
                return items[idx].Id;
        }
        console.warn(`[embywatch] Library "${raw}" not found — using the whole server`);
        return undefined;
    }
    catch (e) {
        throwIfAborted(ctx.signal);
        console.warn('[embywatch] Failed to list libraries, using the whole server:', e);
        return undefined;
    }
}
// Library scoping notes: some servers (and ID-aliasing proxies) ignore ParentId
// on Resume/NextUp and on any item-selector query (Ids, SearchTerm, Filters), and
// won't recurse to Episodes under a library. Only plain ParentId *browsing* of a
// library's Series/Movies is reliable. So we never enumerate the whole library
// (that reads like scraping) — we take a small random sample to pick from, and
// scoped resume returns only in-library resumables (or nothing), never the global
// Continue Watching list.
const LIBRARY_SAMPLE_SIZE = 12;
async function available(serverUrl, ctx, seg) {
    return isMediaAvailable(serverUrl, seg.itemId, seg.mediaSourceId, mediaOpts(ctx));
}
/** A bounded random sample of a library's Series/Movies (no full enumeration). */
async function librarySample(serverUrl, ctx, parentId, limit) {
    try {
        const page = await embyRequest(serverUrl, `/Users/${ctx.userId}/Items?ParentId=${parentId}&Recursive=true&IncludeItemTypes=Series,Movie&SortBy=Random&Limit=${limit}&Fields=MediaSources,RunTimeTicks`, reqOpts(ctx));
        return page.Items ?? [];
    }
    catch {
        throwIfAborted(ctx.signal);
        return [];
    }
}
/** Expand a library member to a segment: a Series → a random episode; a Movie as-is. */
async function memberToSegment(serverUrl, ctx, member) {
    if (member.Type !== 'Series')
        return toSegment(member);
    const eps = await embyRequest(serverUrl, `/Shows/${member.Id}/Episodes?UserId=${ctx.userId}&Fields=MediaSources,RunTimeTicks`, reqOpts(ctx));
    const list = eps.Items ?? [];
    if (!list.length)
        return undefined;
    return toSegment(list[Math.floor(Math.random() * list.length)]);
}
// Pick a random streamable segment from within a library, using a bounded sample.
async function pickRandomFromLibrary(serverUrl, ctx, parentId, verifyPlayable) {
    const sample = await librarySample(serverUrl, ctx, parentId, LIBRARY_SAMPLE_SIZE);
    const maxAttempts = Math.min(sample.length, verifyPlayable ? MAX_PICK_ATTEMPTS : 1);
    const tried = new Set();
    for (let attempt = 0; attempt < maxAttempts && tried.size < sample.length; attempt++) {
        throwIfAborted(ctx.signal);
        let idx = Math.floor(Math.random() * sample.length);
        while (tried.has(idx))
            idx = (idx + 1) % sample.length;
        tried.add(idx);
        const seg = await memberToSegment(serverUrl, ctx, sample[idx]);
        if (!seg)
            continue;
        if (!verifyPlayable || (await available(serverUrl, ctx, seg)))
            return seg;
        console.warn(`[embywatch] "${seg.item.Name}" is not streamable — trying another library item`);
    }
    return undefined;
}
// Library membership for a resume candidate. The primary signal is the item's
// Ancestors chain: real Emby servers return it with the library's CollectionFolder
// (view) id, even though the physical ParentId chain runs through separate folders
// (Series -> letter folder -> disk folder -> root), so "series ParentId == view id"
// never matches there. Falls back to the series' ParentId for aliasing proxies that
// flatten the hierarchy and 404 on Ancestors. Bounded: at most one lookup per series
// (episodes of a series share the same ancestors), cached across the resume list.
async function ancestorsIncludeLibrary(serverUrl, ctx, itemId, libraryId) {
    try {
        const anc = await embyRequest(serverUrl, `/Items/${itemId}/Ancestors?UserId=${ctx.userId}`, reqOpts(ctx));
        return Array.isArray(anc) && anc.some((a) => a?.Id === libraryId);
    }
    catch {
        throwIfAborted(ctx.signal);
        return false;
    }
}
async function seriesParentId(serverUrl, ctx, seriesId) {
    try {
        const s = await embyRequest(serverUrl, `/Users/${ctx.userId}/Items/${seriesId}?Fields=ParentId`, reqOpts(ctx));
        return s?.ParentId;
    }
    catch {
        throwIfAborted(ctx.signal);
        return undefined;
    }
}
async function itemInLibrary(serverUrl, ctx, item, libraryId, cache) {
    if (!item)
        return false;
    if (item.ParentId === libraryId)
        return true; // movie/series directly under the view
    const key = item.Type === 'Episode' ? (item.SeriesId ?? item.Id) : item.Id;
    if (cache.has(key))
        return cache.get(key);
    let inLib = await ancestorsIncludeLibrary(serverUrl, ctx, item.Id, libraryId);
    if (!inLib) {
        const seriesId = item.Type === 'Episode' ? item.SeriesId : item.Id;
        if (seriesId)
            inLib = (await seriesParentId(serverUrl, ctx, seriesId)) === libraryId;
    }
    cache.set(key, inLib);
    return inLib;
}
// In-library resume: the global Continue Watching list (which the proxy returns
// unscoped) filtered to the target library by each item's series ParentId. This
// is what lets us resume the right in-library show without scanning the library.
async function libraryResumeSegment(serverUrl, ctx, parentId, verifyPlayable) {
    let res;
    try {
        res = await embyRequest(serverUrl, `/Users/${ctx.userId}/Items/Resume?Limit=25&MediaTypes=Video&Recursive=true&Fields=MediaSources,RunTimeTicks,UserData,ParentId,SeriesId`, reqOpts(ctx));
    }
    catch {
        throwIfAborted(ctx.signal);
        return undefined;
    }
    const cache = new Map();
    for (const cand of res.Items ?? []) {
        throwIfAborted(ctx.signal);
        if (Number(cand.UserData?.PlaybackPositionTicks) <= 0)
            continue;
        if (!(await itemInLibrary(serverUrl, ctx, cand, parentId, cache)))
            continue;
        const seg = toSegment(cand);
        if (!verifyPlayable || (await available(serverUrl, ctx, seg)))
            return seg;
    }
    return undefined;
}
/** Random streamable item (existing behaviour), retried up to MAX_PICK_ATTEMPTS. */
async function pickRandomSegment(serverUrl, ctx, verifyPlayable, parentId) {
    const attempts = verifyPlayable ? MAX_PICK_ATTEMPTS : 1;
    const scope = parentId ? `&ParentId=${parentId}` : '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const items = await embyRequest(serverUrl, `/Users/${ctx.userId}/Items?SortBy=Random&Limit=1&IncludeItemTypes=Episode,Movie&Recursive=true&Fields=MediaSources,RunTimeTicks${scope}`, reqOpts(ctx));
        if (!items.Items?.length)
            return undefined;
        const seg = toSegment(items.Items[0]);
        if (!verifyPlayable || (await isMediaAvailable(serverUrl, seg.itemId, seg.mediaSourceId, mediaOpts(ctx)))) {
            return seg;
        }
        console.warn(`[embywatch] "${seg.item.Name}" is not streamable (attempt ${attempt}/${attempts}) — trying another item`);
    }
    return undefined;
}
/** The next episode in the series after `item`, or undefined at the series end. */
async function getNextEpisode(serverUrl, ctx, item, verifyPlayable) {
    if (item.Type !== 'Episode' || !item.SeriesId)
        return undefined;
    const eps = await embyRequest(serverUrl, `/Shows/${item.SeriesId}/Episodes?UserId=${ctx.userId}&Fields=MediaSources,RunTimeTicks`, reqOpts(ctx));
    const list = eps.Items ?? [];
    const idx = list.findIndex(e => e.Id === item.Id);
    if (idx < 0 || idx + 1 >= list.length)
        return undefined;
    const next = toSegment(list[idx + 1]);
    if (verifyPlayable && !(await isMediaAvailable(serverUrl, next.itemId, next.mediaSourceId, mediaOpts(ctx)))) {
        return undefined;
    }
    return next;
}
// Bound the chain so a bad runtime/position can never loop forever.
const MAX_SEQUENCE_SEGMENTS = 30;
/**
 * Sequence Play: resume where the user left off (Emby "Continue Watching"),
 * else the next unwatched episode (Next Up), else a random item; then keep
 * playing the next episode each time one finishes until the play duration is
 * used up. An episode is marked watched only when it actually reaches the end,
 * so a partially-watched item stays in the resume list for next time.
 */
async function runSequencePlay(serverUrl, ctx, config, opts) {
    const { playDuration, verifyPlayable, parentId } = opts;
    const asResume = (seg) => {
        const posTicks = Number(seg.item.UserData?.PlaybackPositionTicks) || 0;
        const start = posTicks > 0 ? Math.floor(posTicks / TICKS_PER_SECOND) : 0;
        console.log(`[embywatch] Sequence Play: resuming "${seg.item.Name}" at ${start}s`);
        return { seg, start };
    };
    const asRandom = (seg, label) => {
        const start = seg.runtimeSeconds > 0 ? Math.floor(seg.runtimeSeconds * (0.05 + Math.random() * 0.05)) : 0;
        console.log(`[embywatch] Sequence Play: ${label} "${seg.item.Name}" from ${start}s`);
        return { seg, start };
    };
    // Pick within the library (bounded, no full scan). Resume is scoped and only
    // kept when it has a real playback position; otherwise start a random title.
    const pickInLibrary = async (lib) => {
        const resumeSeg = await libraryResumeSegment(serverUrl, ctx, lib, verifyPlayable);
        if (resumeSeg)
            return asResume(resumeSeg);
        const seg = await pickRandomFromLibrary(serverUrl, ctx, lib, verifyPlayable);
        return seg ? asRandom(seg, 'nothing to resume, random from library') : undefined;
    };
    // Whole-server selection (no library scope): resume → next up → random.
    const pickWholeServer = async () => {
        const resume = await embyRequest(serverUrl, `/Users/${ctx.userId}/Items/Resume?Limit=10&MediaTypes=Video&Recursive=true&Fields=MediaSources,RunTimeTicks`, reqOpts(ctx));
        let seg = await firstPlayable(serverUrl, ctx, resume.Items ?? [], verifyPlayable);
        if (seg)
            return asResume(seg);
        const nextUp = await embyRequest(serverUrl, `/Shows/NextUp?UserId=${ctx.userId}&Limit=10&Fields=MediaSources,RunTimeTicks`, reqOpts(ctx));
        seg = await firstPlayable(serverUrl, ctx, nextUp.Items ?? [], verifyPlayable);
        if (seg) {
            console.log(`[embywatch] Sequence Play: starting Next Up "${seg.item.Name}"`);
            return { seg, start: 0 };
        }
        seg = await pickRandomSegment(serverUrl, ctx, verifyPlayable);
        return seg ? asRandom(seg, 'nothing to resume, random') : undefined;
    };
    let started = parentId ? await pickInLibrary(parentId) : await pickWholeServer();
    // If the chosen library has nothing to play, fall back to the whole server.
    if (!started && parentId) {
        console.warn('[embywatch] Sequence Play: library has nothing to play — falling back to the whole server');
        started = await pickWholeServer();
    }
    if (!started) {
        throw new Error('No streamable items found on Emby server — media may be offline (disk down); skipped reporting');
    }
    let cur = started.seg;
    let curStart = started.start;
    let budget = Math.floor(playDuration * (1 + Math.random() * 0.1));
    let totalStreamed = 0;
    let episodesCompleted = 0;
    const episodes = [];
    for (let i = 0; i < MAX_SEQUENCE_SEGMENTS && cur && budget > 0; i++) {
        throwIfAborted(ctx.signal);
        const rt = cur.runtimeSeconds;
        const episodeRemaining = rt > 0 ? Math.max(0, rt - curStart) : budget;
        const watchSeconds = Math.min(budget, episodeRemaining);
        let segStreamed = 0;
        let segNote;
        let segTranscoded = false;
        if (watchSeconds > 0) {
            console.log(`[embywatch] Watching "${cur.item.Name}" (${cur.item.Type}) from ${curStart}s for ${watchSeconds}s`);
            const played = await playSegment(serverUrl, ctx, cur, curStart, watchSeconds);
            segStreamed = played.streamedBytes;
            segNote = played.note;
            segTranscoded = played.transcoded === true;
            totalStreamed += segStreamed;
        }
        const end = curStart + watchSeconds;
        const finished = rt > 0 && end >= Math.floor(rt * 0.99);
        budget -= watchSeconds;
        // Mark watched only when the episode actually reached its end.
        let marked = false;
        if (finished && config.markWatched !== false)
            marked = await markPlayed(serverUrl, ctx, cur.itemId);
        if (finished)
            episodesCompleted++;
        // Record every segment that actually played (skip zero-length resume-at-end hops).
        if (watchSeconds > 0) {
            episodes.push({
                itemType: cur.item.Type ?? 'Unknown',
                title: cur.item.Name ?? 'Unknown',
                seriesName: cur.item.SeriesName,
                seasonNumber: cur.item.ParentIndexNumber,
                episodeNumber: cur.item.IndexNumber,
                runtimeSeconds: rt,
                startSeconds: curStart,
                endSeconds: end,
                watchedSeconds: watchSeconds,
                markedWatched: marked,
                streamedBytes: ctx.realWatch ? segStreamed : undefined,
                realWatchNote: segNote,
                realWatchTranscoded: segTranscoded ? true : undefined,
            });
        }
        if (!finished)
            break; // budget exhausted mid-item; leave the partial in resume
        cur = await getNextEpisode(serverUrl, ctx, cur.item, verifyPlayable);
        curStart = 0;
    }
    // Fall back to a placeholder entry if nothing ever played (e.g. runtime unknown
    // and budget 0), so the log always has a top-level item.
    const totalWatched = episodes.reduce((s, e) => s + e.watchedSeconds, 0);
    const head = episodes[episodes.length - 1] ?? {
        itemType: 'Unknown',
        title: 'Unknown',
        runtimeSeconds: 0,
        startSeconds: 0,
        endSeconds: 0,
        watchedSeconds: 0,
        markedWatched: false,
    };
    // Surface the first segment's failure reason at the top level, so a run that
    // streamed nothing says why rather than showing a bare 0 MB.
    const runNote = episodes.find(e => e.realWatchNote)?.realWatchNote;
    const runTranscoded = episodes.some(e => e.realWatchTranscoded);
    if (ctx.realWatch) {
        console.log(`[embywatch] Real Watch streamed ${(totalStreamed / 1048576).toFixed(1)} MB across ${episodes.length} segment(s)`);
    }
    console.log(`[embywatch] Sequence Play complete — ${episodes.length} segment(s), ${episodesCompleted} finished, ${totalWatched}s total`);
    return {
        ...head,
        // watchedSeconds reflects the whole sequence so the total matches playDuration
        watchedSeconds: totalWatched,
        streamedBytes: ctx.realWatch ? totalStreamed : undefined,
        realWatchNote: totalStreamed === 0 ? runNote : undefined,
        realWatchTranscoded: runTranscoded ? true : undefined,
        sequencePlay: true,
        episodesCompleted,
        episodes,
    };
}
async function runEmbywatch(serverUrl, config, signal) {
    throwIfAborted(signal);
    const ua = config.userAgent ?? getSetting('default_ua') ?? DEFAULT_UA;
    const playDuration = config.playDuration ?? Number(getSetting('default_play_duration') ?? 300);
    const deviceName = resolveDeviceName(getSetting('default_device_name') ?? 'Yamby', config.username);
    const proxyUrl = resolveProxyUrl(config.proxyId);
    // 1. Authenticate
    const auth = await embyRequest(serverUrl, '/Users/AuthenticateByName', {
        method: 'POST',
        ua,
        deviceName,
        proxyUrl,
        cancelSignal: signal,
        body: { Username: config.username, Pw: config.password },
    });
    const token = auth.AccessToken;
    const userId = auth.User.Id;
    console.log(`[embywatch] Authenticated as "${auth.User.Name}" on ${serverUrl}`);
    // 2. Build the play context (session id, device, streaming flag).
    const verifyPlayable = config.verifyPlayable !== false;
    const ctx = {
        token,
        ua,
        userId,
        deviceName,
        proxyUrl,
        playSessionId: `bemby-${Date.now()}`,
        realWatch: config.realWatch === true,
        signal,
    };
    // Optionally scope everything to one library (name or 1-based index).
    const parentId = await resolveLibraryId(serverUrl, ctx, config.library);
    if (parentId)
        console.log(`[embywatch] Scoped to library "${config.library}"`);
    // Sequence Play resumes and chains episodes; the default path plays one random item.
    if (config.sequencePlay === true) {
        return runSequencePlay(serverUrl, ctx, config, { playDuration, verifyPlayable, parentId });
    }
    // 3. Pick a random streamable item. When the disk is down the metadata item
    // still exists, so verifying playability avoids reporting an unplayable file.
    let picked = parentId
        ? await pickRandomFromLibrary(serverUrl, ctx, parentId, verifyPlayable)
        : await pickRandomSegment(serverUrl, ctx, verifyPlayable);
    // If the chosen library has nothing to play, fall back to the whole server.
    if (!picked && parentId) {
        console.warn('[embywatch] Library has nothing to play — falling back to the whole server');
        picked = await pickRandomSegment(serverUrl, ctx, verifyPlayable);
    }
    if (!picked) {
        throw new Error('No streamable items found on Emby server — media may be offline (disk down); skipped reporting');
    }
    const { item, itemId, runtimeSeconds } = picked;
    // 4. Start at a random 5-10% into the item
    const startSeconds = runtimeSeconds > 0 ? Math.floor(runtimeSeconds * (0.05 + Math.random() * 0.05)) : 0;
    // 5. Watch playDuration + 0-10% jitter, capped so we don't overshoot the end
    const actualDuration = Math.floor(playDuration * (1 + Math.random() * 0.1));
    const maxWatchable = runtimeSeconds > 0 ? Math.max(0, Math.floor(runtimeSeconds * 0.97) - startSeconds) : Infinity;
    const watchDuration = maxWatchable < Infinity ? Math.min(actualDuration, maxWatchable) : actualDuration;
    const endSeconds = startSeconds + watchDuration;
    console.log(`[embywatch] Watching "${item.Name}" (${item.Type}) from ${startSeconds}s, duration ${watchDuration}s`);
    const { streamedBytes, note, transcoded } = await playSegment(serverUrl, ctx, picked, startSeconds, watchDuration);
    // 6. Optionally mark the item as watched (enabled by default)
    let markedWatched = false;
    if (config.markWatched !== false)
        markedWatched = await markPlayed(serverUrl, ctx, itemId);
    if (ctx.realWatch) {
        console.log(`[embywatch] Real Watch streamed ${(streamedBytes / 1048576).toFixed(1)} MB for "${item.Name}"`);
    }
    console.log(`[embywatch] Session complete for "${item.Name}" — marked watched: ${markedWatched}`);
    return {
        itemType: item.Type ?? 'Unknown',
        title: item.Name ?? 'Unknown',
        seriesName: item.SeriesName,
        seasonNumber: item.ParentIndexNumber,
        episodeNumber: item.IndexNumber,
        runtimeSeconds,
        startSeconds,
        endSeconds,
        watchedSeconds: watchDuration,
        markedWatched,
        streamedBytes: ctx.realWatch ? streamedBytes : undefined,
        realWatchNote: note,
        realWatchTranscoded: transcoded ? true : undefined,
    };
}
