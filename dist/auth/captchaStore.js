"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.issueCaptcha = issueCaptcha;
exports.consumeCaptcha = consumeCaptcha;
exports.resetCaptchas = resetCaptchas;
const crypto_1 = require("crypto");
const TTL_MS = 5 * 60000;
/** Bounds the map when challenges are requested and never used; oldest go first. */
const MAX_CHALLENGES = 500;
const challenges = new Map();
function sweep() {
    const now = Date.now();
    for (const [id, challenge] of challenges) {
        if (challenge.expiresAt <= now)
            challenges.delete(id);
    }
    while (challenges.size >= MAX_CHALLENGES) {
        const oldest = challenges.keys().next();
        if (oldest.done)
            break;
        challenges.delete(oldest.value);
    }
}
/** Stores an answer and returns the opaque id the client quotes back. */
function issueCaptcha(answer) {
    sweep();
    const id = (0, crypto_1.randomBytes)(24).toString('base64url');
    challenges.set(id, { answer: answer.toLowerCase(), expiresAt: Date.now() + TTL_MS });
    return id;
}
/**
 * Checks an answer and burns the challenge, whether or not it matched. Returns false for an
 * unknown, expired or already-used id, so a caller cannot tell those apart from a wrong answer.
 */
function consumeCaptcha(id, answer) {
    if (!id || answer == null)
        return false;
    const challenge = challenges.get(id);
    challenges.delete(id);
    if (!challenge || challenge.expiresAt <= Date.now())
        return false;
    const expected = Buffer.from(challenge.answer);
    const given = Buffer.from(answer.toLowerCase().trim());
    return expected.length === given.length && (0, crypto_1.timingSafeEqual)(expected, given);
}
/** Test hook: drops every outstanding challenge. */
function resetCaptchas() {
    challenges.clear();
}
