"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isBlockedIp = isBlockedIp;
exports.assertPublicUrl = assertPublicUrl;
exports.ssrfSafeFetch = ssrfSafeFetch;
exports.headersAllowFraming = headersAllowFraming;
exports.isFrameable = isFrameable;
const dns_1 = __importDefault(require("dns"));
const net_1 = __importDefault(require("net"));
const undici_1 = require("undici");
// Fetching an address the operator supplied means the server can be pointed at anything it
// can reach, so every such fetch goes through here. Two things guard it: the URL is checked
// before the request is made, and the socket's own name resolution is checked again as it
// connects. The second is what closes the gap the first cannot -- between a check and a
// connection the same name can resolve somewhere else, and only the address actually dialled
// decides where the bytes go.
/** Reserved and private IPv4 ranges, as [first octet, mask, match] rules where it helps. */
function isBlockedIpv4(ip) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        return true;
    }
    const [a, b] = parts;
    return (a === 0 || // "this network"
        a === 10 || // RFC1918
        a === 127 || // loopback
        (a === 100 && b >= 64 && b <= 127) || // RFC6598 carrier-grade NAT
        (a === 169 && b === 254) || // link-local, and the cloud metadata service with it
        (a === 172 && b >= 16 && b <= 31) || // RFC1918
        (a === 192 && b === 0) || // IETF protocol assignments and TEST-NET-1
        (a === 192 && b === 168) || // RFC1918
        (a === 198 && (b === 18 || b === 19)) || // benchmarking
        (a === 198 && b === 51) || // TEST-NET-2
        (a === 203 && b === 0) || // TEST-NET-3
        a >= 224 // multicast and everything reserved above it, broadcast included
    );
}
/**
 * Expands an IPv6 address to its 16 bytes, or null when it does not parse. Written out rather
 * than matched by prefix string: `::ffff:127.0.0.1` and `::ffff:7f00:1` are the same address,
 * and a check that only reads the text form sees two different ones and lets one through.
 */
function ipv6Bytes(ip) {
    let text = ip;
    const zone = text.indexOf("%");
    if (zone !== -1)
        text = text.slice(0, zone);
    // A trailing dotted quad occupies the last four bytes
    let tail = [];
    const lastColon = text.lastIndexOf(":");
    const afterColon = text.slice(lastColon + 1);
    if (afterColon.includes(".")) {
        if (!net_1.default.isIPv4(afterColon))
            return null;
        tail = afterColon.split(".").map(Number);
        text = text.slice(0, lastColon + 1) + "0:0";
    }
    const halves = text.split("::");
    if (halves.length > 2)
        return null;
    const toGroups = (s) => {
        if (!s)
            return [];
        const out = [];
        for (const group of s.split(":")) {
            if (!/^[0-9a-fA-F]{1,4}$/.test(group))
                return null;
            out.push(parseInt(group, 16));
        }
        return out;
    };
    const head = toGroups(halves[0]);
    const rest = halves.length === 2 ? toGroups(halves[1]) : [];
    if (!head || !rest)
        return null;
    // The dotted quad was rewritten to "0:0" above, so it is already counted in head/rest and
    // every form is simply eight groups once "::" is expanded.
    let groups;
    if (halves.length === 2) {
        const fill = 8 - head.length - rest.length;
        if (fill < 0)
            return null;
        groups = [...head, ...Array(fill).fill(0), ...rest];
    }
    else {
        if (head.length !== 8)
            return null;
        groups = head;
    }
    const bytes = new Uint8Array(16);
    const upper = tail.length ? 6 : 8;
    for (let i = 0; i < upper; i++) {
        const g = groups[i] ?? 0;
        bytes[i * 2] = (g >> 8) & 0xff;
        bytes[i * 2 + 1] = g & 0xff;
    }
    if (tail.length)
        bytes.set(tail, 12);
    return bytes;
}
function isBlockedIpv6(ip) {
    const b = ipv6Bytes(ip);
    if (!b)
        return true;
    const embeddedIpv4 = () => `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
    const zeroThrough = (n) => b.slice(0, n).every((x) => x === 0);
    // ::ffff:a.b.c.d -- an IPv4 address wearing an IPv6 coat. Judged as the IPv4 it is,
    // which is what stops ::ffff:127.0.0.1 reaching loopback.
    if (zeroThrough(10) && b[10] === 0xff && b[11] === 0xff)
        return isBlockedIpv4(embeddedIpv4());
    // 64:ff9b::/96 -- the well-known NAT64 prefix, likewise carrying an IPv4 destination
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) {
        return isBlockedIpv4(embeddedIpv4());
    }
    // :: (unspecified) and ::1 (loopback)
    if (zeroThrough(15) && (b[15] === 0 || b[15] === 1))
        return true;
    if ((b[0] & 0xfe) === 0xfc)
        return true; // fc00::/7 unique local
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80)
        return true; // fe80::/10 link-local
    if (b[0] === 0xff)
        return true; // ff00::/8 multicast
    return false;
}
/** Rejects IPs in private/reserved ranges, to prevent SSRF against internal services. */
function isBlockedIp(ip) {
    if (net_1.default.isIPv4(ip))
        return isBlockedIpv4(ip);
    if (net_1.default.isIPv6(ip))
        return isBlockedIpv6(ip);
    return true; // reject unrecognised formats
}
/**
 * The resolver the request's own socket uses. Every address a name offers is checked, not
 * just the first: a host that answers with one public and one private address would otherwise
 * pass the check and connect to the private one.
 */
const ssrfLookup = ((hostname, options, callback) => {
    const cb = (typeof options === "function" ? options : callback);
    const opts = typeof options === "function" ? {} : options;
    dns_1.default.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
        if (err) {
            cb(err);
            return;
        }
        const allowed = addresses.filter((a) => !isBlockedIp(a.address));
        if (!allowed.length) {
            cb(new Error("Private IP not allowed"));
            return;
        }
        if (opts.all)
            cb(null, allowed);
        else
            cb(null, allowed[0].address, allowed[0].family);
    });
});
/** One dispatcher for every operator-supplied fetch, so the check lives on the socket. */
const ssrfAgent = new undici_1.Agent({ connect: { lookup: ssrfLookup } });
async function assertPublicUrl(rawUrl) {
    const parsed = new URL(rawUrl);
    if (!/^https?:$/i.test(parsed.protocol))
        throw new Error("Only http(s) allowed");
    // A bracketed IPv6 literal keeps its brackets in `hostname`
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    if (net_1.default.isIP(hostname)) {
        // A literal address never reaches the resolver hook below, so this is its only check
        if (isBlockedIp(hostname))
            throw new Error("Private IP not allowed");
        return;
    }
    const addresses = await dns_1.default.promises.lookup(hostname, { all: true });
    if (!addresses.length || addresses.some((a) => isBlockedIp(a.address))) {
        throw new Error("Private IP not allowed");
    }
}
/**
 * Validates the initial URL and every redirect target against `assertPublicUrl` before
 * following it, so a public host cannot 3xx-redirect the request to localhost, the cloud
 * metadata service, or anything else internal. The dispatcher checks again at connect time,
 * which is what a name that changes its answer between the two would otherwise slip past.
 */
async function ssrfSafeFetch(startUrl, init, options = {}) {
    // The third argument used to be a bare hop count; still accepted so callers need not change.
    const { maxHops = 5, followRedirects = true } = typeof options === "number" ? { maxHops: options } : options;
    let current = startUrl;
    for (let hop = 0; hop <= maxHops; hop++) {
        await assertPublicUrl(current);
        const resp = (await (0, undici_1.fetch)(current, {
            ...init,
            redirect: "manual",
            dispatcher: ssrfAgent,
        }));
        if (followRedirects && resp.status >= 300 && resp.status < 400) {
            const location = resp.headers.get("location");
            if (!location)
                return resp;
            current = new URL(location, current).toString();
            continue;
        }
        return resp;
    }
    throw new Error("Too many redirects");
}
/** Whether a response's headers let another origin frame it. */
function headersAllowFraming(headers) {
    const xfo = (headers.get("x-frame-options") ?? "").toLowerCase();
    if (xfo.includes("deny") || xfo.includes("sameorigin"))
        return false;
    const csp = headers.get("content-security-policy") ?? "";
    const m = csp.match(/frame-ancestors([^;]*)/i);
    // frame-ancestors listing anything but a wildcard will not include our origin
    if (m && !m[1].trim().toLowerCase().split(/\s+/).includes("*"))
        return false;
    return true;
}
/** Probes a URL to see whether it can be shown in the messenger's webview iframe. */
async function isFrameable(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
        let resp = await ssrfSafeFetch(url, { method: "HEAD", signal: ctrl.signal });
        if (resp.status === 405 || resp.status === 501) {
            resp = await ssrfSafeFetch(url, { signal: ctrl.signal });
            resp.body?.cancel().catch(() => { });
        }
        return headersAllowFraming(resp.headers);
    }
    catch {
        // Unreachable from the backend; let the browser iframe try anyway
        return true;
    }
    finally {
        clearTimeout(timer);
    }
}
