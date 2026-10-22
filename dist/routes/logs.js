"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = require("../db/database");
const cancellation_1 = require("../jobs/cancellation");
const list_query_1 = require("./list-query");
const router = (0, express_1.Router)();
/** Parses a positive integer query param, clamped to [1, max]. */
function parsePositiveInt(value, fallback, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(max, Math.max(1, Math.floor(parsed)));
}
function parseNonNegativeInt(value, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(0, Math.floor(parsed));
}
router.get('/:id', (req, res) => {
    const id = Number(req.params.id);
    const row = database_1.db.prepare(`
    SELECT l.id, l.job_id, l.ran_at, l.status, l.message, l.detail,
           j.name AS job_name, j.job_type,
           a.name AS account_name
    FROM job_logs l
    LEFT JOIN jobs j ON l.job_id = j.id
    LEFT JOIN tg_accounts a ON j.account_id = a.id
    WHERE l.id = ?
  `).get(id);
    if (!row) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    const liveDetail = (0, cancellation_1.getLiveDetail)(id);
    res.json({
        id: row.id,
        jobId: row.job_id,
        jobName: row.job_name,
        jobType: row.job_type ?? null,
        accountName: row.account_name,
        ranAt: row.ran_at,
        status: row.status,
        message: row.message,
        detail: liveDetail ?? (row.detail ? JSON.parse(row.detail) : null),
    });
});
router.get('/', (req, res) => {
    const { jobId, limit, offset, showRetired = '0' } = req.query;
    const query = req.query;
    const paging = (0, list_query_1.parsePaging)(query);
    const search = (0, list_query_1.textParam)(query.search);
    const status = (0, list_query_1.textParam)(query.status);
    const conditions = [];
    const params = [];
    if (jobId) {
        const parsedJobId = Number(jobId);
        if (!Number.isInteger(parsedJobId) || parsedJobId <= 0) {
            res.status(400).json({ error: 'Invalid jobId' });
            return;
        }
        conditions.push('l.job_id = ?');
        params.push(parsedJobId);
    }
    if (showRetired !== '1') {
        conditions.push('l.retired = 0');
    }
    if (status) {
        conditions.push('l.status = ?');
        params.push(status);
    }
    if (search) {
        conditions.push(`(
      COALESCE(j.name, '') LIKE ? ESCAPE '\\'
      OR COALESCE(a.name, '') LIKE ? ESCAPE '\\'
      OR COALESCE(l.message, '') LIKE ? ESCAPE '\\'
    )`);
        const like = `%${(0, list_query_1.escapeLike)(search)}%`;
        params.push(like, like, like);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const baseSql = `
    FROM job_logs l
    LEFT JOIN jobs j ON l.job_id = j.id
    LEFT JOIN tg_accounts a ON j.account_id = a.id
    ${where}
  `;
    const selectSql = `
    SELECT l.id, l.job_id, l.ran_at, l.status, l.message, l.retired,
           j.name AS job_name, j.job_type,
           a.name AS account_name
    ${baseSql}
    ORDER BY l.ran_at DESC
    LIMIT ? OFFSET ?
  `;
    const toJson = (r) => ({
        id: r.id,
        jobId: r.job_id,
        jobName: r.job_name,
        jobType: r.job_type ?? null,
        accountName: r.account_name,
        ranAt: r.ran_at,
        status: r.status,
        message: r.message,
        retired: r.retired === 1,
    });
    if (!paging) {
        // Legacy limit/offset shape
        const parsedLimit = parsePositiveInt(limit, 50, 200);
        const parsedOffset = parseNonNegativeInt(offset, 0);
        const rows = database_1.db.prepare(selectSql).all(...params, parsedLimit, parsedOffset);
        res.json(rows.map(toJson));
        return;
    }
    const totalRow = database_1.db.prepare(`SELECT COUNT(*) AS total ${baseSql}`).get(...params);
    const rows = database_1.db.prepare(selectSql).all(...params, paging.limit, paging.offset);
    res.json({
        items: rows.map(toJson),
        total: totalRow.total,
        page: paging.page,
        pageSize: paging.pageSize,
    });
});
router.patch('/:id/retire', (req, res) => {
    const id = Number(req.params.id);
    const row = database_1.db.prepare('SELECT retired FROM job_logs WHERE id = ?').get(id);
    if (!row) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    const newVal = row.retired ? 0 : 1;
    database_1.db.prepare('UPDATE job_logs SET retired = ? WHERE id = ?').run(newVal, id);
    res.json({ retired: newVal === 1 });
});
router.post('/:id/cancel', (req, res) => {
    const logId = Number(req.params.id);
    if ((0, cancellation_1.isJobRunning)(logId)) {
        (0, cancellation_1.cancelJob)(logId);
        res.json({ message: 'Cancel signal sent' });
        return;
    }
    // No live process: the row is likely orphaned after a restart. Force-mark a
    // stuck 'running' row as failed so it can be cleared from the UI. (issue #18)
    const row = database_1.db.prepare('SELECT status FROM job_logs WHERE id = ?').get(logId);
    if (!row) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    if (row.status !== 'running') {
        res.status(404).json({ error: 'No running job found for this log entry' });
        return;
    }
    database_1.db.prepare("UPDATE job_logs SET status = 'failed', message = 'Force stopped' WHERE id = ?").run(logId);
    res.json({ message: 'Force stopped' });
});
exports.default = router;
