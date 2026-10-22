"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
// GramJS throws TIMEOUT from its background _updateLoop after disconnect — suppress it
process.on("unhandledRejection", (reason) => {
    if (reason?.message === "TIMEOUT")
        return;
    console.error("Unhandled rejection:", reason);
});
const cors_1 = __importDefault(require("cors"));
const path_1 = __importDefault(require("path"));
const auth_1 = __importDefault(require("./routes/auth"));
const accounts_1 = __importDefault(require("./routes/accounts"));
const jobs_1 = __importDefault(require("./routes/jobs"));
const logs_1 = __importDefault(require("./routes/logs"));
const status_1 = __importDefault(require("./routes/status"));
const settings_1 = __importDefault(require("./routes/settings"));
const data_1 = __importDefault(require("./routes/data"));
const debug_1 = __importDefault(require("./routes/debug"));
const ai_suppliers_1 = __importDefault(require("./routes/ai-suppliers"));
const templates_1 = __importDefault(require("./routes/templates"));
const tgClient_1 = __importStar(require("./routes/tgClient"));
const webviewProxy_1 = __importDefault(require("./routes/webviewProxy"));
const webviewSite_1 = __importDefault(require("./routes/webviewSite"));
const webviewTickets_1 = require("./tg/webviewTickets");
const auth_2 = require("./middleware/auth");
const scheduler_1 = require("./scheduler");
const wsHandler_1 = require("./tg/wsHandler");
const memory_1 = require("./monitor/memory");
// Validate critical env vars before accepting any requests
(0, auth_2.getJwtSecret)();
const app = (0, express_1.default)();
const PORT = Number(process.env.PORT ?? 3000);
const BIND_HOST = process.env.HOST ?? "0.0.0.0";
const DISPLAY_HOST = process.env.DISPLAY_HOST ?? BIND_HOST;
// TRUST_PROXY: set to the number of proxy hops in front of this app.
// 0/false = direct internet (no proxy) -- clients cannot spoof X-Forwarded-For
// 1       = one reverse proxy (nginx, Caddy, Railway, etc.)
// 2+      = multiple proxies (e.g. Cloudflare + nginx)
const trustProxy = process.env.TRUST_PROXY ?? '0';
app.set('trust proxy', /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
// CORS: the SPA is served same-origin in production, so no wildcard is needed.
// CORS_ORIGIN (comma-separated) whitelists extra origins; defaults to the local
// dev frontend. Same-origin requests don't require CORS headers regardless.
const corsOrigins = (process.env.CORS_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const allowedOrigins = corsOrigins.length
    ? corsOrigins
    : ["http://localhost:5173", "http://127.0.0.1:5173"];
// A request naming the viewer origin is a framed page asking for itself, not a call on
// Bemby: the whole host belongs to that page, from the root down, which is the only way its
// router works. Mounted first so nothing else claims a path from it.
const viewerOrigin = (0, webviewTickets_1.webviewPublicOrigin)();
if (viewerOrigin) {
    console.log(`[webview] serving framed pages on ${viewerOrigin}`);
    app.use((req, res, next) => (0, webviewTickets_1.isWebviewHost)(req.headers.host, viewerOrigin) ? (0, webviewSite_1.default)(req, res, next) : next());
}
// The messenger's page viewer, mounted ahead of everything else on purpose. It authenticates
// with its own ticket rather than a session token (see routes/webviewProxy), answers its own
// preflights -- the sandboxed page is an opaque origin, which the CORS whitelist below would
// turn away -- and forwards request bodies untouched, which needs the raw bytes rather than
// the JSON parser's object.
app.use("/api/webview", express_1.default.raw({ type: "*/*", limit: "10mb" }), webviewProxy_1.default);
app.use((0, cors_1.default)({ origin: allowedOrigins }));
app.use(express_1.default.json({ limit: "5mb" }));
// Baseline security headers. Kept dependency-free and conservative so the SPA
// and the mini-app iframe keep working; the mini-app proxy strips these itself.
//
// The policy is more than `frame-ancestors` on purpose. The panel renders bot- and
// site-authored content through `v-html` in the logs and the messenger, and the session
// token lives in this origin's localStorage, so one escaping slip would otherwise be worth
// the whole API. `script-src 'self'` means injected markup cannot execute, whatever gets
// past the escaping upstream.
//
// The two loosenings are load-bearing rather than habit:
//   'unsafe-inline' in style-src -- the log and messenger renderers emit inline styles, and
//     Vue's own scoped-style handling sets them too
//   data: and blob: in img-src/media-src -- avatars, message photos and inline media are
//     served to the page as data or object URLs rather than fetched by address
const CSP = [
    "default-src 'self'",
    // Cloudflare injects its Web Analytics beacon into HTML it proxies, so an install sitting
    // behind Cloudflare has a script on the page that the operator never put there. Allowed by
    // name: without it every such install gets a console error on load for something it cannot
    // turn off from here. Remove the origin if you do not front Bemby with Cloudflare.
    "script-src 'self' https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    // The panel talks to its own API and its own WebSocket, and nothing else
    "connect-src 'self' ws: wss:",
    // Any http(s) origin, because framing third-party pages is the feature: a Mini App that
    // allows framing is shown at its own address, and only one that refuses is served through
    // the proxy on this origin. Narrowing this to 'self' broke every app of the first kind.
    //
    // This is not the loose end it looks like. A framed document gets its own origin and its
    // own CSP, so nothing here is what keeps it away from the panel; `script-src 'self'`
    // above is, and it is untouched by this.
    "frame-src 'self' https: http:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].join("; ");
app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", CSP);
    if (process.env.NODE_ENV === "production") {
        res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
});
// Health check -- no auth required
app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
// Public routes
app.use("/api/auth", auth_1.default);
// Protected API routes
app.use("/api/accounts", auth_2.requireAuth, accounts_1.default);
app.use("/api/jobs", auth_2.requireAuth, jobs_1.default);
app.use("/api/logs", auth_2.requireAuth, logs_1.default);
app.use("/api/status", auth_2.requireAuth, status_1.default);
app.use("/api/settings", auth_2.requireAuth, settings_1.default);
app.use("/api/data", auth_2.requireAuth, data_1.default);
app.use("/api/debug", auth_2.requireAuth, debug_1.default);
app.use("/api/ai-suppliers", auth_2.requireAuth, ai_suppliers_1.default);
app.use("/api/templates", auth_2.requireAuth, templates_1.default);
// Inline chat media is loaded straight by the browser, which cannot set an Authorization
// header, so it authenticates with a short-lived media ticket instead. Mounted ahead of
// `requireAuth` because that guard would otherwise refuse the request before the ticket was
// ever looked at; anything this router does not match falls through to the guarded one.
app.use("/api/tg-client", tgClient_1.mediaRouter);
app.use("/api/tg-client", auth_2.requireAuth, tgClient_1.default);
// Serve Vue SPA
const publicDir = path_1.default.join(__dirname, "..", "public");
app.use(express_1.default.static(publicDir));
app.get("*", (req, res) => {
    res.sendFile(path_1.default.join(publicDir, "index.html"));
});
// Final error handler -- log the detail server-side, never leak stack traces to the client
app.use((err, _req, res, _next) => {
    console.error("[server] Unhandled error:", err);
    if (res.headersSent)
        return;
    res.status(500).json({ error: "Internal server error" });
});
const server = (0, http_1.createServer)(app);
(0, wsHandler_1.attachWebSocket)(server);
server.listen(PORT, BIND_HOST, () => {
    console.log(`Bemby admin: http://${DISPLAY_HOST}:${PORT}`);
    // Before the scheduler, so the "previous process died at NNN MB" line prints above the
    // interrupted-runs line it explains
    (0, memory_1.startMemoryMonitor)();
    (0, scheduler_1.startScheduler)();
});
// An OOM kill is SIGKILL and cannot be trapped, which is the point: a clean stop leaves
// this marker, so its absence on the next boot means the process was killed rather than
// asked to stop.
for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
        (0, memory_1.markCleanShutdown)();
        server.close(() => process.exit(0));
        // Don't wait on lingering keep-alive sockets past the usual container stop grace
        setTimeout(() => process.exit(0), 5000).unref();
    });
}
