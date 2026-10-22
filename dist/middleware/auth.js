"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOKEN_EPOCH_KEY = void 0;
exports.getJwtSecret = getJwtSecret;
exports.getTokenEpoch = getTokenEpoch;
exports.bumpTokenEpoch = bumpTokenEpoch;
exports.sessionClaims = sessionClaims;
exports.verifySessionToken = verifySessionToken;
exports.requireAuth = requireAuth;
exports.requireMediaAuth = requireMediaAuth;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const database_1 = require("../db/database");
const mediaTickets_1 = require("../auth/mediaTickets");
// Publicly known placeholder secrets that must never sign real tokens
const KNOWN_DEFAULT_SECRETS = new Set(['change-me-in-production', 'changeme', 'secret']);
function getJwtSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
        console.error('FATAL: JWT_SECRET env var is not set. Set it before starting Bemby.');
        process.exit(1);
    }
    if (KNOWN_DEFAULT_SECRETS.has(secret.trim())) {
        console.error('FATAL: JWT_SECRET is set to a publicly known default. Generate a unique secret, e.g. `openssl rand -hex 32`.');
        process.exit(1);
    }
    return secret;
}
exports.TOKEN_EPOCH_KEY = 'token_epoch';
/**
 * A signed token cannot be withdrawn, so revocation needs a value the server can move: every
 * session token carries the epoch it was issued under, and changing credentials (or signing
 * out everywhere) advances it, which retires every token behind it at once. Without this a
 * stolen token outlived a password change by its full seven days.
 *
 * Zero means no epoch has ever been set, and tokens from before this existed carry no `ep`
 * at all. Both are accepted while the epoch is still zero, so an upgrade does not sign the
 * operator out; the first credential change moves it and they stop being accepted.
 */
function getTokenEpoch() {
    try {
        const row = database_1.db.prepare('SELECT value FROM settings WHERE key = ?').get(exports.TOKEN_EPOCH_KEY);
        return Number(row?.value) || 0;
    }
    catch {
        return 0;
    }
}
/** Advances the epoch, retiring every session token issued before now. Returns the new value. */
function bumpTokenEpoch() {
    // Date.now() alone can repeat within a millisecond, which would leave a token signed in the
    // same tick still valid; stepping past the stored value guarantees it moves.
    const next = Math.max(Date.now(), getTokenEpoch() + 1);
    database_1.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(exports.TOKEN_EPOCH_KEY, String(next));
    return next;
}
/** The claims every freshly issued session token carries. */
function sessionClaims(username, requirePasswordChange = false) {
    const base = { sub: username, typ: 'auth', ep: getTokenEpoch() };
    if (requirePasswordChange)
        base.requirePasswordChange = true;
    return base;
}
/**
 * Verifies a JWT is a genuine session token, not another token signed with the
 * same secret (e.g. the legacy captcha token, which carried `cap` and no `sub`).
 * Returns the payload, or null if invalid. Shared by the HTTP guard and the
 * WebSocket handshake so the two can't drift apart.
 */
function verifySessionToken(token) {
    try {
        const decoded = jsonwebtoken_1.default.verify(token, getJwtSecret(), { algorithms: ['HS256'] });
        if (!decoded.sub || decoded.cap !== undefined || (decoded.typ !== undefined && decoded.typ !== 'auth')) {
            return null;
        }
        if ((decoded.ep ?? 0) !== getTokenEpoch())
            return null;
        return decoded;
    }
    catch {
        return null;
    }
}
function requireAuth(req, res, next) {
    // Header only. The session token used to be accepted from ?token= as well, which put a
    // seven-day credential into image addresses and from there into access logs and browser
    // history; the routes that genuinely cannot set a header use a media ticket instead
    // (see auth/mediaTickets and requireMediaAuth below).
    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) {
        res.status(401).json({ error: 'Unauthorised' });
        return;
    }
    const decoded = verifySessionToken(token);
    if (!decoded) {
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
    }
    // Restrict access until the default password is changed
    if (decoded.requirePasswordChange) {
        const path = req.originalUrl.split('?')[0];
        if (!(req.method === 'PUT' && path === '/api/auth/credentials')) {
            res.status(403).json({ error: 'Password change required', requirePasswordChange: true });
            return;
        }
    }
    next();
}
/**
 * For the handful of routes a browser loads by address rather than by fetch, where no header
 * can be set: a normal session token in the header still works, and a `?ticket=` naming a
 * live media ticket is accepted in its place. Never the session token in the query.
 */
function requireMediaAuth(req, res, next) {
    if ((0, mediaTickets_1.isValidMediaTicket)(req.query.ticket)) {
        next();
        return;
    }
    requireAuth(req, res, next);
}
