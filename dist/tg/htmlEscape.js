"use strict";
// Bot and channel text is attacker-controlled: whoever runs the bot on the other side writes
// it. Two places render it as HTML for the panel (the job log in jobs/checkin, the messenger
// in tg/liveClient), and each had its own copy of these two functions. The renderers around
// them differ on purpose -- the log opens links in a new tab, the messenger routes them back
// through the app -- but the escaping does not, and a fix to one copy did not reach the other.
Object.defineProperty(exports, "__esModule", { value: true });
exports.escapeHtml = escapeHtml;
exports.safeHref = safeHref;
function escapeHtml(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
/**
 * The href to render for a URL out of a message, or an empty string to render none.
 *
 * Only http, https and tg survive, so `javascript:` and `data:` cannot become a link. The
 * value returned is the parsed URL's normalised form rather than the input, which is what
 * keeps a quote or an angle bracket smuggled into the original out of the attribute even
 * before the escaping above runs.
 */
function safeHref(url) {
    try {
        const parsed = new URL(url);
        return /^(https?|tg):$/i.test(parsed.protocol) ? parsed.href : "";
    }
    catch {
        return "";
    }
}
