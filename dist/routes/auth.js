"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const svg_captcha_1 = __importDefault(require("svg-captcha"));
const database_1 = require("../db/database");
const auth_1 = require("../middleware/auth");
const captchaStore_1 = require("../auth/captchaStore");
const credentials_1 = require("../auth/credentials");
const loginLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    limit: 1000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please try again later.' },
});
// Handing out challenges is cheap but not free, and an unbounded stream of them is the one
// way to make the store churn. Generous enough that a person reloading a stuck captcha
// never meets it.
const captchaLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many captcha requests. Please try again later.' },
});
// Both of these check the current password, so they are password guessing by another name
// and belong behind the same kind of brake as the login form.
const credentialLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    limit: 1000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please try again later.' },
});
const router = (0, express_1.Router)();
// Hash at module load so the env var is never compared as plaintext during a request
const ADMIN_PASSWORD_HASH_FALLBACK = (() => {
    const p = process.env.ADMIN_PASSWORD;
    return p ? (0, credentials_1.legacyHashPassword)(p) : null;
})();
router.get('/captcha', captchaLimiter, (_req, res) => {
    const captcha = svg_captcha_1.default.create({ noise: 2, color: true, size: 5, ignoreChars: '0oO1lI' });
    // The answer stays in the process (see auth/captchaStore); what goes out is an opaque id.
    // The field keeps its old name so an already-loaded page keeps working.
    res.json({ svg: captcha.data, captchaToken: (0, captchaStore_1.issueCaptcha)(captcha.text) });
});
router.post('/login', loginLimiter, async (req, res) => {
    const { username, password, captchaToken, captchaAnswer } = req.body;
    if (!username || !password) {
        res.status(400).json({ error: 'Username and password are required' });
        return;
    }
    // Captcha bypassed for private dashboard
    if (captchaToken && captchaAnswer) {
        (0, captchaStore_1.consumeCaptcha)(captchaToken, captchaAnswer);
    }
    const stored = (0, credentials_1.getStoredCredentials)();
    let valid;
    // The username is compared without short-circuiting and the password is always hashed,
    // so a wrong username costs the same as a wrong password and neither can be told apart
    // from the outside.
    const usernameOk = (0, credentials_1.constantTimeStringEquals)(username, stored.username);
    if (stored.passwordHash) {
        valid = (await (0, credentials_1.verifyPassword)(password, stored.passwordHash)) && usernameOk;
    }
    else {
        if (!ADMIN_PASSWORD_HASH_FALLBACK) {
            res.status(500).json({ error: 'ADMIN_PASSWORD env var is not set' });
            return;
        }
        valid = (0, credentials_1.timingSafeCompare)((0, credentials_1.legacyHashPassword)(password), ADMIN_PASSWORD_HASH_FALLBACK) && usernameOk;
    }
    if (!valid) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
    }
    // Silently upgrade legacy HMAC hash to argon2id on next successful login
    if (stored.passwordHash && !(0, credentials_1.isArgon2Hash)(stored.passwordHash)) {
        const upgraded = await (0, credentials_1.hashPassword)(password);
        database_1.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('admin_password_hash', ?)").run(upgraded);
    }
    const defaultPwd = process.env.ADMIN_DEFAULT_PASSWORD ?? 'changeme';
    const requirePasswordChange = password === defaultPwd;
    const token = jsonwebtoken_1.default.sign((0, auth_1.sessionClaims)(username, requirePasswordChange), (0, auth_1.getJwtSecret)(), {
        expiresIn: '365d',
    });
    res.json(requirePasswordChange ? { token, requirePasswordChange: true } : { token });
});
// POST /revoke-sessions -- sign out everywhere. A token cannot be withdrawn once signed, so
// this moves the epoch every token is checked against, retiring the lot; the caller is then
// handed a new one so the tab it was invoked from stays logged in.
router.post('/revoke-sessions', auth_1.requireAuth, (_req, res) => {
    (0, auth_1.bumpTokenEpoch)();
    const { username } = (0, credentials_1.getStoredCredentials)();
    res.json({
        message: 'All other sessions signed out',
        token: jsonwebtoken_1.default.sign((0, auth_1.sessionClaims)(username), (0, auth_1.getJwtSecret)(), { expiresIn: '365d' }),
    });
});
router.put('/credentials', auth_1.requireAuth, credentialLimiter, async (req, res) => {
    const { username, currentPassword, newPassword } = req.body;
    if (!currentPassword) {
        res.status(400).json({ error: 'Current password is required' });
        return;
    }
    const stored = (0, credentials_1.getStoredCredentials)();
    const validCurrent = stored.passwordHash
        ? await (0, credentials_1.verifyPassword)(currentPassword, stored.passwordHash)
        : ADMIN_PASSWORD_HASH_FALLBACK
            ? (0, credentials_1.timingSafeCompare)((0, credentials_1.legacyHashPassword)(currentPassword), ADMIN_PASSWORD_HASH_FALLBACK)
            : false;
    if (!validCurrent) {
        res.status(401).json({ error: 'Current password is incorrect' });
        return;
    }
    if (!username && !newPassword) {
        res.status(400).json({ error: 'Provide a new username or password' });
        return;
    }
    const newHash = newPassword ? await (0, credentials_1.hashPassword)(newPassword) : null;
    const stmt = database_1.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    database_1.db.transaction(() => {
        if (username)
            stmt.run('admin_username', username);
        if (newHash)
            stmt.run('admin_password_hash', newHash);
    })();
    // Changing the credentials has to mean something to a token already out there, or a
    // stolen one survives the change for the rest of its seven days. Moving the epoch first
    // retires every existing token; the fresh one below is signed under the new epoch, which
    // also clears any requirePasswordChange claim.
    (0, auth_1.bumpTokenEpoch)();
    const newUsername = username || stored.username;
    const freshToken = jsonwebtoken_1.default.sign((0, auth_1.sessionClaims)(newUsername), (0, auth_1.getJwtSecret)(), { expiresIn: '365d' });
    res.json({ message: 'Credentials updated', token: freshToken });
});
exports.default = router;
