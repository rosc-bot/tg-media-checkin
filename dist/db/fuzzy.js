"use strict";
// Fuzzy text scoring for server-side search. Pure function so it can be unit tested and
// registered as a custom SQLite function.
Object.defineProperty(exports, "__esModule", { value: true });
exports.fuzzyScore = fuzzyScore;
// Scores how well a single token matches the haystack. 0 = no match; higher = better.
// Substring matches beat subsequence matches; earlier and tighter matches score higher.
function scoreToken(token, hay) {
    if (!token)
        return 1;
    const idx = hay.indexOf(token);
    if (idx >= 0) {
        // Direct substring: strong score, better when the match starts earlier
        return 1000 - Math.min(idx, 400);
    }
    // Subsequence walk: all token chars must appear in order
    let hayPos = 0;
    let firstPos = -1;
    let lastPos = -1;
    for (const ch of token) {
        const found = hay.indexOf(ch, hayPos);
        if (found < 0)
            return 0;
        if (firstPos < 0)
            firstPos = found;
        lastPos = found;
        hayPos = found + 1;
    }
    const spread = lastPos - firstPos + 1;
    // Tighter clusters and earlier starts score higher; always at least 1 when matched
    return Math.max(1, 400 - (spread - token.length) * 5 - Math.min(firstPos, 100));
}
// Multi-word query: every whitespace-separated token must match somewhere in the haystack.
function fuzzyScore(needle, haystack) {
    if (typeof needle !== "string" || needle.trim() === "")
        return 1;
    if (typeof haystack !== "string" || haystack === "")
        return 0;
    const hay = haystack.toLowerCase();
    let total = 0;
    for (const token of needle.toLowerCase().split(/\s+/).filter(Boolean)) {
        const s = scoreToken(token, hay);
        if (s === 0)
            return 0;
        total += s;
    }
    return total;
}
