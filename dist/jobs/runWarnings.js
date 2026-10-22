"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WARNING_MARKER = void 0;
exports.collectRunWarnings = collectRunWarnings;
exports.completedMessage = completedMessage;
/**
 * Marker that turns the tail of a run message into a warning. The logs view keys
 * the amber styling off it, so keep it in step with the frontend.
 */
exports.WARNING_MARKER = 'Warning:';
const REAL_WATCH_WARNINGS = {
    'no-stream-url': 'Real Watch pulled no bytes (server serves no direct-play or transcode stream)',
    'stream-failed': 'Real Watch pulled no bytes (the server rejected every stream request)',
};
/**
 * Things worth flagging on an otherwise successful run: the job did its work,
 * part of it just didn't land. These never change the run status.
 */
function collectRunWarnings(jobType, detailLogs) {
    if (jobType !== 'embywatch')
        return [];
    const warnings = new Set();
    for (const entry of detailLogs) {
        const note = entry?.realWatchNote;
        if (note && REAL_WATCH_WARNINGS[note])
            warnings.add(REAL_WATCH_WARNINGS[note]);
    }
    return [...warnings];
}
/** Compose the message stored against a completed run. */
function completedMessage(warnings) {
    if (!warnings.length)
        return 'Completed';
    return `Completed · ${exports.WARNING_MARKER} ${warnings.join('; ')}`;
}
