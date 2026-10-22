"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const safeFetch_1 = require("../tg/safeFetch");
const webviewTickets_1 = require("../tg/webviewTickets");
// Serves a framed page at the ROOT of the viewer origin (see webviewPublicOrigin), which is
// what makes a Mini App work at all: it reads `location.pathname` to route itself, so its own
// paths have to be its own paths. Everything the page asks for then maps one to one, and the
// rewriting an under-a-prefix copy needs -- of every URL it ships with -- mostly disappears.
//
// The ticket arrives once, in the claim redirect, and lives on as an HttpOnly cookie: scripts
// on the page cannot read it, and it authorises nothing but fetching from their own site.
//
// This origin is distinct from the panel's, so the frame may safely have `allow-same-origin`:
// the page gets a real origin with working storage, cookies and crypto, while the panel's
// session token -- kept in the panel origin's localStorage -- stays out of reach.
const router = (0, express_1.Router)();
router.use((0, express_1.raw)({ type: () => true, limit: "10mb" }));
const UA_APP = "Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/120 Mobile Safari/537.36 Telegram/10.0";
/** Headers belonging to this hop, or to Bemby, which must not be passed upstream. */
const DROP_REQUEST_HEADERS = new Set([
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "proxy-authorization",
    "content-length",
    "accept-encoding",
    // Rewritten below rather than forwarded
    "cookie",
    "origin",
    "referer",
]);
function readCookie(header, name) {
    if (!header)
        return undefined;
    for (const part of header.split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1)
            continue;
        if (part.slice(0, eq).trim() === name)
            return decodeURIComponent(part.slice(eq + 1).trim());
    }
    return undefined;
}
/** The site's own cookies, with Bemby's viewer cookie held back. */
function siteCookies(header) {
    if (!header)
        return undefined;
    const kept = header
        .split(";")
        .filter((part) => part.split("=")[0]?.trim() !== webviewTickets_1.WEBVIEW_COOKIE)
        .map((part) => part.trim())
        .filter(Boolean);
    return kept.length ? kept.join("; ") : undefined;
}
/**
 * Re-scopes a Set-Cookie for this origin: the site's Domain is not ours, and its Secure and
 * SameSite=None would be dropped outright when the viewer is served over plain http.
 */
function rewriteSetCookie(value, secure) {
    const parts = value
        .split(";")
        .map((p) => p.trim())
        .filter((p) => !/^domain=/i.test(p) && !/^secure$/i.test(p) && !/^samesite=/i.test(p));
    parts.push("SameSite=Lax");
    if (secure)
        parts.push("Secure");
    return parts.join("; ");
}
/**
 * Injected ahead of the page's own scripts. Far less to do than under a path prefix: relative
 * and root-relative URLs are already correct here. What remains is an absolute URL the app
 * wrote for its own origin -- that would leave this one and be refused by CORS -- and the
 * Telegram bridge, which has no host client to talk to inside a frame.
 */
function runtimeShim(domain, mode) {
    const telegramBridge = mode === "app"
        ? `
  window.TelegramWebviewProxy = window.TelegramWebviewProxy || {
    postEvent: function (type, data) {
      try {
        window.dispatchEvent(new CustomEvent("tg-post", { detail: { type: type, data: data } }));
      } catch (e) {}
    }
  };`
        : "";
    return `<script>(function () {
  var DOMAIN = ${JSON.stringify(domain)};
  var here = location.origin;

  function sameParty(host) {
    host = String(host).toLowerCase();
    return host === DOMAIN || host.slice(-(DOMAIN.length + 1)) === "." + DOMAIN;
  }

  // Fold an address on the site onto this origin, where the proxy will answer it. Anything
  // already here, or belonging to someone else, is left exactly as it is.
  function route(raw) {
    var s = String(raw == null ? "" : raw);
    if (!s || /^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i.test(s)) return raw;
    var abs;
    try { abs = new URL(s, document.baseURI); } catch (e) { return raw; }
    if (!/^https?:$/i.test(abs.protocol)) return raw;
    if (abs.origin === here) return raw;
    if (!sameParty(abs.hostname)) return raw;
    return abs.pathname + abs.search + abs.hash;
  }

  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === "string" || input instanceof URL) {
          return origFetch.call(this, route(input), init);
        }
        if (input && typeof input.url === "string") {
          var routed = route(input.url);
          if (routed !== input.url) return origFetch.call(this, new Request(routed, input), init);
        }
      } catch (e) {}
      return origFetch.call(this, input, init);
    };
  }

  var xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function () {
    var args = Array.prototype.slice.call(arguments);
    if (args.length > 1) args[1] = route(args[1]);
    return xhrOpen.apply(this, args);
  };

  if (navigator.sendBeacon) {
    var beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) { return beacon(route(url), data); };
  }

  function patchUrlProperty(proto, name) {
    var desc = Object.getOwnPropertyDescriptor(proto, name);
    if (!desc || !desc.set) return;
    Object.defineProperty(proto, name, {
      configurable: true,
      enumerable: desc.enumerable,
      get: desc.get,
      set: function (value) { desc.set.call(this, route(value)); }
    });
  }
  if (window.HTMLLinkElement) patchUrlProperty(HTMLLinkElement.prototype, "href");
  if (window.HTMLScriptElement) patchUrlProperty(HTMLScriptElement.prototype, "src");
  if (window.HTMLImageElement) patchUrlProperty(HTMLImageElement.prototype, "src");${telegramBridge}
})();</script>`;
}
/** Only the site's absolute URLs need moving; a relative one already points here. */
function rewriteHtml(html, finalUrl, ticket) {
    const domain = (0, webviewTickets_1.registrableDomain)(new URL(finalUrl).hostname);
    const fold = (raw) => {
        try {
            const abs = new URL(raw, finalUrl);
            if (!/^https?:$/i.test(abs.protocol))
                return raw;
            if (!(0, webviewTickets_1.sameParty)(abs.hostname, domain))
                return raw;
            return `${abs.pathname}${abs.search}`;
        }
        catch {
            return raw;
        }
    };
    // A <base href> naming the site would send every relative URL straight there, where an
    // opaque-origin request is refused; a meta CSP was written for the original origin
    let out = html.replace(/<base\b[^>]*>/gi, "");
    out = out.replace(/<meta\b[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
    out = out.replace(/(\b(?:src|href|action|poster)\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (_m, attr, q, val) => `${attr}${q}${fold(val)}${q}`);
    const head = runtimeShim(domain, ticket.mode);
    return /<head[^>]*>/i.test(out)
        ? out.replace(/<head[^>]*>/i, (m) => `${m}\n${head}`)
        : `${head}\n${out}`;
}
/** Trades the ticket in the address for a cookie, then redirects to the app's own path. */
router.get(webviewTickets_1.WEBVIEW_CLAIM_PATH, (req, res) => {
    const ticket = (0, webviewTickets_1.resolveWebviewTicket)(req.query.t);
    if (!ticket) {
        res.status(401).type("html").send("<p>This viewer session has expired. Open the app again.</p>");
        return;
    }
    const to = typeof req.query.to === "string" && req.query.to.startsWith("/") ? req.query.to : "/";
    const secure = req.protocol === "https";
    res.setHeader("Set-Cookie", `${webviewTickets_1.WEBVIEW_COOKIE}=${encodeURIComponent(ticket.id)}; Path=/; HttpOnly; SameSite=Lax` +
        (secure ? "; Secure" : ""));
    // 302 without a fragment of its own, so the browser carries the original one across
    res.redirect(302, to);
});
router.all(/.*/, async (req, res) => {
    const ticket = (0, webviewTickets_1.resolveWebviewTicket)(readCookie(req.headers.cookie, webviewTickets_1.WEBVIEW_COOKIE));
    if (!ticket) {
        res
            .status(401)
            .type("html")
            .send("<p>This viewer session has expired. Open the app again from the chat.</p>");
        return;
    }
    const url = `${ticket.origin}${req.url}`;
    if (!(0, webviewTickets_1.ticketAllowsUrl)(ticket, url)) {
        console.warn(`[webview] 403 ${url.slice(0, 140)} is outside ${ticket.origin}`);
        res.status(403).json({ error: "outside this viewer session" });
        return;
    }
    try {
        await (0, safeFetch_1.assertPublicUrl)(url);
    }
    catch {
        res.status(400).json({ error: "URL not allowed" });
        return;
    }
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
        if (DROP_REQUEST_HEADERS.has(name.toLowerCase()) || value === undefined)
            continue;
        headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    headers["user-agent"] = ticket.mode === "app" ? UA_APP : headers["user-agent"] ?? UA_APP;
    // The site sees a request from its own page, which is what its own checks expect
    headers["origin"] = ticket.origin;
    headers["referer"] = `${ticket.origin}/`;
    const cookies = siteCookies(req.headers.cookie);
    if (cookies)
        headers["cookie"] = cookies;
    const body = req.method === "GET" || req.method === "HEAD" || !Buffer.isBuffer(req.body) || !req.body.length
        ? undefined
        : new Uint8Array(req.body);
    try {
        // The redirect is relayed rather than resolved here: the browser has to see it, or the
        // app's address never changes and its router stays on the page it was told to leave.
        // The Location rewriting below is what needs the 3xx to actually arrive.
        const upstream = await (0, safeFetch_1.ssrfSafeFetch)(url, { method: req.method, headers, body }, { followRedirects: false });
        const contentType = upstream.headers.get("content-type") ?? "text/html";
        res.status(upstream.status);
        res.setHeader("Content-Type", contentType);
        for (const header of ["cache-control", "etag", "last-modified", "content-disposition"]) {
            const value = upstream.headers.get(header);
            if (value)
                res.setHeader(header, value);
        }
        // A redirect to the site is one to this origin: the app must stay inside the viewer
        const location = upstream.headers.get("location");
        if (location) {
            try {
                const abs = new URL(location, url);
                const domain = (0, webviewTickets_1.registrableDomain)(new URL(ticket.origin).hostname);
                res.setHeader("Location", (0, webviewTickets_1.sameParty)(abs.hostname, domain) ? `${abs.pathname}${abs.search}` : abs.toString());
            }
            catch {
                res.setHeader("Location", location);
            }
        }
        const setCookies = upstream.headers.getSetCookie?.();
        if (setCookies?.length) {
            res.setHeader("Set-Cookie", setCookies.map((c) => rewriteSetCookie(c, req.protocol === "https")));
        }
        // Only the panel may frame this, and the panel is a sibling host on the same domain.
        // X-Frame-Options is deliberately absent: it cannot express that, and SAMEORIGIN here
        // would refuse the very frame this exists for.
        //
        // The domain comes from the configured viewer origin, not from the request's Host. A
        // Host header is written by whoever is calling, so deriving the policy from it let a
        // caller name the domain that would then be allowed to frame the page.
        const configured = (0, webviewTickets_1.webviewPublicOrigin)();
        const viewerDomain = configured ? (0, webviewTickets_1.registrableDomain)(new URL(configured).hostname) : "";
        res.setHeader("Content-Security-Policy", viewerDomain
            ? `frame-ancestors 'self' http://${viewerDomain}:* https://${viewerDomain}:* ` +
                `http://*.${viewerDomain}:* https://*.${viewerDomain}:*`
            : "frame-ancestors 'self'");
        if (!contentType.includes("text/html")) {
            res.send(Buffer.from(await upstream.arrayBuffer()));
            return;
        }
        const finalUrl = (upstream.url || url).split("#")[0];
        res.send(rewriteHtml(await upstream.text(), finalUrl, ticket));
    }
    catch (err) {
        console.warn(`[webview] ${req.method} failed for ${url.slice(0, 140)}: ${err?.message ?? err}`);
        res.status(502).json({ error: err?.message ?? "proxy failed" });
    }
});
exports.default = router;
