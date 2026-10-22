"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerJob = registerJob;
exports.unregisterJob = unregisterJob;
exports.cancelJob = cancelJob;
exports.isJobRunning = isJobRunning;
exports.runningLogIds = runningLogIds;
exports.registerLiveDetail = registerLiveDetail;
exports.getLiveDetail = getLiveDetail;
exports.clearLiveDetail = clearLiveDetail;
const registry = new Map();
function registerJob(logId) {
    const ctrl = new AbortController();
    registry.set(logId, ctrl);
    return ctrl.signal;
}
function unregisterJob(logId) {
    registry.delete(logId);
}
/** Returns false if no running job was found for this logId. */
function cancelJob(logId) {
    const ctrl = registry.get(logId);
    if (!ctrl)
        return false;
    ctrl.abort();
    return true;
}
function isJobRunning(logId) {
    return registry.has(logId);
}
/** Log ids of the runs currently in flight, so a memory spike can be attributed. */
function runningLogIds() {
    return [...registry.keys()];
}
// Live detail registry — holds a reference to the in-progress detailLogs array
// so the logs API can stream partial results while a job is running.
const liveDetails = new Map();
function registerLiveDetail(logId, detail) {
    liveDetails.set(logId, detail);
}
function getLiveDetail(logId) {
    return liveDetails.get(logId);
}
function clearLiveDetail(logId) {
    liveDetails.delete(logId);
}
