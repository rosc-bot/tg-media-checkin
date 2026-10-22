"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toMinutes = toMinutes;
exports.pickNextRun = pickNextRun;
const luxon_1 = require("luxon");
function toMinutes(hhmm) {
    return Math.floor(hhmm / 100) * 60 + (hhmm % 100);
}
const MAX_RANDOM_ATTEMPTS = 20;
function atMinute(day, minuteOfDay) {
    return day.set({
        hour: Math.floor(minuteOfDay / 60),
        minute: minuteOfDay % 60,
        second: 0,
        millisecond: 0,
    });
}
/**
 * Picks a random minute in [startMin, endMin) on the given day, staying at
 * least gapMinutes away from every occupied slot. When the window is too
 * crowded to honour the gap, falls back to the minute furthest from its
 * nearest neighbour so behaviour degrades gracefully.
 */
function pickMinute(day, startMin, endMin, opts) {
    const span = Math.max(1, endMin - startMin);
    const randomPick = () => atMinute(day, startMin + Math.floor(Math.random() * span));
    const gapMs = (opts.gapMinutes ?? 0) * 60000;
    const occupied = opts.occupied ?? [];
    if (gapMs <= 0 || occupied.length === 0)
        return randomPick();
    const clearance = (candidate) => {
        const ms = candidate.toMillis();
        return Math.min(...occupied.map((slot) => Math.abs(slot - ms)));
    };
    for (let i = 0; i < MAX_RANDOM_ATTEMPTS; i++) {
        const candidate = randomPick();
        if (clearance(candidate) >= gapMs)
            return candidate;
    }
    let best = atMinute(day, startMin);
    let bestClearance = clearance(best);
    for (let m = startMin + 1; m < endMin; m++) {
        const candidate = atMinute(day, m);
        const c = clearance(candidate);
        if (c > bestClearance) {
            best = candidate;
            bestClearance = c;
        }
    }
    return best;
}
function pickNextRun(windowStart, windowEnd, tz, daysAhead = 0, options = {}) {
    const startMin = toMinutes(windowStart);
    const endMin = toMinutes(windowEnd);
    const now = luxon_1.DateTime.now().setZone(tz);
    const nowMin = now.hour * 60 + now.minute;
    if (daysAhead === 0) {
        if (nowMin < startMin)
            return pickMinute(now, startMin, endMin, options);
        if (nowMin + 1 < endMin)
            return pickMinute(now, nowMin + 1, endMin, options);
        // Past window or under a minute left -- schedule tomorrow
        daysAhead = 1;
    }
    return pickMinute(now.plus({ days: daysAhead }), startMin, endMin, options);
}
