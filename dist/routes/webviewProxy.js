"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const safeFetch_1 = require("../tg/safeFetch");
const webviewTickets_1 = require("../tg/webviewTickets");
// Serves a page that refuses to be framed -- most Mini Apps now send
// `frame-ancestors 'self' https://web.telegram.org` -- so the messenger viewer can still
// show it. The copy is served from Bemby's own origin with those headers dropped, which is
// only safe because of two things, and both must stay true:
//
//  1. The iframe gets no `allow-same-origin`, so the page runs in an opaque origin and
//     cannot reach Bemby's storage, cookies or DOM.
//  2. The address carries a ticket rather than a session token. Scripts on the page can read
//     their own URL, so anything in it is theirs; a ticket only authorises fetching from the
//     site it was issued for. This router is therefore mounted outside `requireAuth` -- the
//     ticket is the whole credential, and it grants nothing of Bemby's.
//
// The address is shaped as a path -- /api/webview/r/<ticket>/https/host/rest -- rather than a
// query, because everything the page loads is resolved against it. A query-shaped address
// cannot stand in for a directory: relative imports resolve to the wrong place and an import
// map naming it is rejected outright ("since specifierKey ended in a slash, so must the
// address"), which is what stopped an earlier version loading anything but the first file.
//
// Because the origin is opaque, the page's own requests reach us cross-origin (`Origin:
// null`), which is why the responses carry `Access-Control-Allow-Origin: *` and preflights
// are answered here.
const router = (0, express_1.Router)();
/** Headers that belong to this hop, or to Bemby, and must not be passed upstream. */
const DROP_REQUEST_HEADERS = new Set([
    "host",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "proxy-authorization",
    "content-length",
    // Bemby's own cookies must never reach the site
    "cookie",
    // Ours to set, below
    "origin",
    "referer",
    "accept-encoding",
]);
const UA_APP = "Mozilla/5.0 (Linux; Android 11; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/120 Mobile Safari/537.36 Telegram/10.0";
const UA_PAGE = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/126 Safari/537.36";
function allowCors(res, reqHeaders, origin) {
    // The sandboxed page has an opaque origin, so it sends `Origin: null`. Echoing whatever it
    // sent -- rather than `*` -- is what lets a credentialed request through: a browser rejects
    // a wildcard outright when the fetch was made with `credentials: "include"`, and an app
    // built for a real Telegram webview commonly does exactly that. `*` remains the fallback for
    // a request that carries no origin at all.
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    if (origin)
        res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", reqHeaders || "*");
    res.setHeader("Access-Control-Expose-Headers", "*");
    res.setHeader("Access-Control-Max-Age", "600");
}
/**
 * Injected ahead of the page's own scripts.
 *
 * Rewritten HTML only covers what the page ships with. A request it builds at runtime still
 * points at Bemby, storage still throws because the origin is opaque, and the Telegram bridge
 * still has no host to talk to. Each is patched here rather than left to fail silently.
 */
function runtimeShim(base, domain, prefix, mode) {
    const config = JSON.stringify({ base, domain, prefix });
    // telegram-web-app.js posts its events to the host client. In a frame it would postMessage
    // to a Telegram origin, which is not us, so the message is dropped and calls made during
    // boot can throw. This is the bridge a Telegram mobile webview exposes, so the script takes
    // that path instead and reads the signed initData from the URL fragment as normal. Events
    // the client would send back (a main button press, a popup answer) have no sender here.
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
  var CFG = ${config};
  var here = location.origin;

  function sameParty(host) {
    host = String(host).toLowerCase();
    return host === CFG.domain || host.slice(-(CFG.domain.length + 1)) === "." + CFG.domain;
  }

  function viaProxy(u) {
    return CFG.prefix + u.protocol.replace(":", "") + "/" + u.host + u.pathname + u.search;
  }

  // Where a request should really go. A relative URL already resolves through the proxy path,
  // so it comes back here untouched; one the page built from its own root is read as a path on
  // the site; a third party's is left to go direct, since the ticket would refuse it anyway.
  function route(raw) {
    var s = String(raw == null ? "" : raw);
    if (!s || /^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i.test(s)) return raw;
    var abs;
    try { abs = new URL(s, document.baseURI).toString(); } catch (e) { return raw; }
    if (abs.indexOf(here) === 0) {
      var rest = abs.slice(here.length);
      if (rest.indexOf(CFG.prefix) === 0) return raw;
      try { abs = new URL(rest, CFG.base).toString(); } catch (e) { return raw; }
    }
    var parsed;
    try { parsed = new URL(abs); } catch (e) { return raw; }
    if (!/^https?:$/i.test(parsed.protocol)) return raw;
    if (!sameParty(parsed.hostname)) return abs;
    return viaProxy(parsed);
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

  if (window.EventSource) {
    var ES = window.EventSource;
    window.EventSource = function (url, cfg) { return new ES(route(url), cfg); };
    window.EventSource.prototype = ES.prototype;
  }

  // A bundle preloads its own chunks and stylesheets by building <link> and <script> elements
  // as it runs. Those carry a URL rather than an import specifier, so no import map covers
  // them and they would be asked of Bemby's root. Both ways a URL reaches an element are
  // patched: the property and the attribute.
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
  if (window.HTMLImageElement) patchUrlProperty(HTMLImageElement.prototype, "src");

  var setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (typeof name === "string" && (name.toLowerCase() === "src" || name.toLowerCase() === "href")) {
      return setAttribute.call(this, name, route(value));
    }
    return setAttribute.apply(this, arguments);
  };

  // Storage throws outright in an opaque origin, and an app that keeps a token dies on the
  // first line that touches it. In-memory stand-ins last as long as the panel is open, which
  // is the life of the session anyway.
  function memoryStore() {
    var map = {};
    return {
      getItem: function (k) { var s = String(k); return Object.prototype.hasOwnProperty.call(map, s) ? map[s] : null; },
      setItem: function (k, v) { map[String(k)] = String(v); },
      removeItem: function (k) { delete map[String(k)]; },
      clear: function () { map = {}; },
      key: function (i) { var ks = Object.keys(map); return i < ks.length ? ks[i] : null; },
      get length() { return Object.keys(map).length; }
    };
  }
  ["localStorage", "sessionStorage"].forEach(function (name) {
    var usable = false;
    try {
      var store = window[name];
      store.setItem("__bemby_probe", "1");
      store.removeItem("__bemby_probe");
      usable = true;
    } catch (e) {}
    if (!usable) {
      try { Object.defineProperty(window, name, { value: memoryStore(), configurable: true }); } catch (e) {}
    }
  });${telegramBridge}
})();</script>`;
}
/** Rewrites a page so what it ships with comes back through this proxy. */
function rewriteHtml(html, finalUrl, ticket) {
    const prefix = `${(0, webviewTickets_1.webviewProxyPath)(ticket.id)}/`;
    const domain = (0, webviewTickets_1.registrableDomain)(new URL(finalUrl).hostname);
    // Only the site's own resources are proxied. A third party's stay as they are: the ticket
    // covers one site, so proxying them would earn a 403 -- which is exactly how the Telegram
    // SDK went missing and took the whole app down with it.
    const toProxy = (raw) => {
        if (!raw || /^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i.test(raw))
            return raw;
        // Idempotent: several rules below touch the same attribute -- a `<script src>` is matched
        // by the script rule and again by the generic one -- and prefixing twice produces an
        // address the site answers with its index page, which fails as a module for its MIME type.
        if (raw.startsWith(prefix))
            return raw;
        let abs;
        try {
            abs = new URL(raw, finalUrl);
        }
        catch {
            return raw;
        }
        if (!/^https?:$/i.test(abs.protocol))
            return raw;
        if (!(0, webviewTickets_1.sameParty)(abs.hostname, domain))
            return abs.toString();
        return `${prefix}${abs.protocol.replace(":", "")}/${abs.host}${abs.pathname}${abs.search}`;
    };
    // A <base href> would resolve the page's own relative URLs off the proxy path, and a meta
    // CSP would hold the copy to rules written for the original origin
    let out = html.replace(/<base\b[^>]*>/gi, "");
    out = out.replace(/<meta\b[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
    // Scripts and stylesheets: the whole opening tag is rewritten rather than the attributes
    // before `src`, since `crossorigin` is as likely to sit after it -- and a module fetched
    // with CORS is one the site will not grant an opaque origin.
    out = out.replace(/<script\b[^>]*>/gi, (tag) => {
        if (!/\ssrc\s*=\s*["']/i.test(tag))
            return tag;
        return tag
            .replace(/\bcrossorigin\b(?:\s*=\s*["'][^"']*["'])?/gi, "")
            .replace(/(\ssrc\s*=\s*)(["'])([^"']+)\2/i, (_m, attr, q, src) => `${attr}${q}${toProxy(src)}${q}`);
    });
    out = out.replace(/<link\b[^>]+>/gi, (linkTag) => linkTag
        .replace(/\bcrossorigin\b(?:\s*=\s*["'][^"']*["'])?/gi, "")
        .replace(/(href\s*=\s*)(["'])([^"']+)\2/i, (_m, attr, q, href) => `${attr}${q}${toProxy(href)}${q}`));
    out = out.replace(/(\b(?:src|action|poster)\s*=\s*)(["'])([^"']+)\2/gi, (_m, attr, q, val) => `${attr}${q}${toProxy(val)}${q}`);
    out = out.replace(/(\bsrcset\s*=\s*)(["'])([^"']+)\2/gi, (_m, attr, q, val) => {
        const rewritten = val
            .split(",")
            .map((part) => {
            const [u, ...rest] = part.trim().split(/\s+/);
            if (!u)
                return part.trim();
            return [toProxy(u), ...rest].join(" ");
        })
            .join(", ");
        return `${attr}${q}${rewritten}${q}`;
    });
    // A plain page is browsed, so its links stay inside the viewer. An app routes its own
    // navigation through the shim instead.
    if (ticket.mode === "page") {
        out = out.replace(/(<a\b[^>]*?\shref\s*=\s*)(["'])([^"']+)\2/gi, (m, before, q, href) => {
            if (/^(#|mailto:|tel:|javascript:|data:)/i.test(href))
                return m;
            return `${before}${q}${toProxy(href)}${q}`;
        });
    }
    // A bundle splits itself with `import("/assets/chunk.js")`, and the browser resolves that
    // specifier itself -- no patched fetch sees it -- so an absolute path would be asked of
    // Bemby's root. The map sends those to the site instead. Both sides must end in a slash or
    // the whole map is discarded ("since specifierKey ended in a slash, so must the address"),
    // which a query-shaped address could never satisfy.
    //
    // The identity entry earns its place: a bundle's preload helper derives a chunk's specifier
    // from its own address, which is already a proxy path, and "/" alone would prefix it a
    // second time. Import maps resolve by longest matching prefix, so naming the proxy path and
    // mapping it to itself leaves those alone while "/" still catches the site's own roots.
    const siteRoot = `${prefix}https/${new URL(finalUrl).host}/`;
    const entries = { "/": siteRoot, [prefix]: prefix };
    const importMap = JSON.stringify({ imports: entries, scopes: { [siteRoot]: entries } });
    const head = `<script type="importmap">${importMap}</script>\n` +
        runtimeShim(finalUrl, domain, prefix, ticket.mode);
    // Must precede every script on the page, module or not
    return /<head[^>]*>/i.test(out)
        ? out.replace(/<head[^>]*>/i, (m) => `${m}\n${head}`)
        : `${head}\n${out}`;
}
/** The ticket named by a viewer address, or undefined when there is no usable one. */
function ticketFromUrl(rawUrl) {
    const id = /^\/r\/([^/?#]+)\//.exec(rawUrl)?.[1];
    return id ? (0, webviewTickets_1.resolveWebviewTicket)(decodeURIComponent(id)) : undefined;
}
router.options(/^\/r\//, (req, res) => {
    // Answered only for an address holding a live ticket. Echoing an arbitrary Origin back
    // with `Allow-Credentials` is a standing offer to every site on the web, and this router
    // sits outside the session guard, so it should say nothing at all to a caller with no
    // ticket to show.
    if (!ticketFromUrl(req.url)) {
        res.status(401).end();
        return;
    }
    allowCors(res, req.headers["access-control-request-headers"], req.headers.origin);
    res.status(204).end();
});
router.all(/^\/r\//, async (req, res) => {
    // Parsed off the raw URL rather than route params, so percent-encoding in the path and the
    // query reaches the site exactly as the page wrote it
    const parts = /^\/r\/([^/?#]+)\/(https?)\/([^/?#]+)([^?#]*)(\?[^#]*)?$/.exec(req.url);
    if (!parts) {
        res.status(400).json({ error: "malformed viewer address" });
        return;
    }
    const [, ticketId, scheme, host, rawPath, search] = parts;
    const ticket = (0, webviewTickets_1.resolveWebviewTicket)(decodeURIComponent(ticketId));
    if (!ticket) {
        res.status(401).json({ error: "This viewer session has expired. Open the app again." });
        return;
    }
    // Only now, with a live ticket in hand, is the caller told anything cross-origin
    allowCors(res, req.headers["access-control-request-headers"], req.headers.origin);
    const url = `${scheme}://${host}${rawPath || "/"}${search ?? ""}`;
    // The ticket is what bounds the proxy: without this it would fetch anything for anyone
    // holding one, which is a relay rather than a viewer.
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
    // Lowercase throughout: Express delivers them that way, and a record holding both cases of
    // one name is filled into Headers by appending, which would send the value twice.
    headers["user-agent"] = ticket.mode === "app" ? UA_APP : UA_PAGE;
    // The site is entitled to think the request came from its own page
    headers["referer"] = `${ticket.origin}/`;
    headers["origin"] = ticket.origin;
    headers["accept-language"] ?? (headers["accept-language"] = "en-US,en;q=0.9");
    // Raw bytes, so a body of any content type reaches the site as the page sent it
    const body = req.method === "GET" || req.method === "HEAD" || !Buffer.isBuffer(req.body) || !req.body.length
        ? undefined
        : new Uint8Array(req.body);
    try {
        const upstream = await (0, safeFetch_1.ssrfSafeFetch)(url, { method: req.method, headers, body });
        const contentType = upstream.headers.get("content-type") ?? "text/html";
        res.status(upstream.status);
        res.setHeader("Content-Type", contentType);
        // Only Bemby may frame the copy: the proxy is not a way to launder framing for the web
        res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
        res.setHeader("X-Frame-Options", "SAMEORIGIN");
        res.setHeader("Cache-Control", "no-store");
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
