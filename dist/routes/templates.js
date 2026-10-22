"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = require("../db/database");
const scheduler_1 = require("../scheduler");
const list_query_1 = require("./list-query");
const router = (0, express_1.Router)();
// Normalise a run-every-days range: min >= 1; max kept only when a valid integer
// strictly greater than min, else null (fixed interval).
function normalizeRunEvery(min, max) {
    const lo = Math.max(1, Math.floor(Number(min ?? 1)) || 1);
    const hiNum = max == null || max === '' ? NaN : Math.floor(Number(max));
    const hi = Number.isFinite(hiNum) && hiNum > lo ? hiNum : null;
    return { min: lo, max: hi };
}
function rowToTemplate(row) {
    return {
        id: row.id,
        name: row.name,
        jobType: row.job_type,
        botUsername: row.bot_username,
        timezone: row.timezone,
        replyTimeoutMs: row.reply_timeout_ms,
        retryMax: row.retry_max,
        enabled: Boolean(row.enabled),
        config: row.config ?? null,
        startCommand: row.start_command || '/start',
        checkinButton: row.checkin_button || '签到',
        createdAt: row.created_at,
        runEveryDays: row.run_every_days ?? 1,
        runEveryDaysMax: row.run_every_days_max ?? null,
    };
}
// Sync template fields to all linked jobs (enabled is job-specific, not synced)
function syncLinkedJobs(templateId, t) {
    if (t.job_type === 'embywatch') {
        // Per-job credentials (username, password) must not be overwritten by the template config.
        // Update all non-config fields in bulk, then merge config per-job.
        database_1.db.prepare(`
      UPDATE jobs SET
        job_type = ?,
        bot_username = ?,
        timezone = ?,
        reply_timeout_ms = ?,
        retry_max = ?,
        start_command = ?,
        checkin_button = ?,
        run_every_days = ?,
        run_every_days_max = ?
      WHERE template_id = ?
    `).run(t.job_type, t.bot_username, t.timezone, t.reply_timeout_ms, t.retry_max, t.start_command, t.checkin_button, t.run_every_days ?? 7, t.run_every_days_max ?? null, templateId);
        const tplCfg = t.config ? JSON.parse(t.config) : {};
        const linkedJobs = database_1.db.prepare('SELECT id, config FROM jobs WHERE template_id = ?').all(templateId);
        for (const job of linkedJobs) {
            const jobCfg = job.config ? JSON.parse(job.config) : {};
            // Spread template config first, then restore per-job credentials on top
            const merged = { ...tplCfg, username: jobCfg.username, password: jobCfg.password };
            database_1.db.prepare('UPDATE jobs SET config = ? WHERE id = ?').run(JSON.stringify(merged), job.id);
        }
    }
    else {
        database_1.db.prepare(`
      UPDATE jobs SET
        job_type = ?,
        bot_username = ?,
        timezone = ?,
        reply_timeout_ms = ?,
        retry_max = ?,
        config = ?,
        start_command = ?,
        checkin_button = ?,
        run_every_days = ?,
        run_every_days_max = ?
      WHERE template_id = ?
    `).run(t.job_type, t.bot_username, t.timezone, t.reply_timeout_ms, t.retry_max, t.config, t.start_command, t.checkin_button, t.run_every_days ?? 7, t.run_every_days_max ?? null, templateId);
    }
    (0, scheduler_1.refreshScheduler)();
}
const TEMPLATE_SORTS = {
    name: 't.name COLLATE NOCASE',
    type: 't.job_type',
    // asc shows enabled templates first, matching the previous client-side sort
    enabled: 'CASE WHEN t.enabled = 1 THEN 0 ELSE 1 END',
    botUrl: 't.bot_username COLLATE NOCASE',
    linkedJobs: 'linked_job_count',
};
router.get('/', (req, res) => {
    const query = req.query;
    const paging = (0, list_query_1.parsePaging)(query);
    const search = (0, list_query_1.textParam)(query.search);
    const jobType = (0, list_query_1.textParam)(query.jobType);
    const enabled = (0, list_query_1.textParam)(query.enabled);
    const sortKey = (0, list_query_1.textParam)(query.sortKey);
    const conditions = [];
    const params = [];
    if (search) {
        // Fuzzy match against name and bot username (see db/fuzzy.ts)
        conditions.push("fuzzy_score(?, t.name || ' ' || t.bot_username) > 0");
        params.push(search);
    }
    if (jobType) {
        conditions.push('t.job_type = ?');
        params.push(jobType);
    }
    if (enabled === '1' || enabled === '0') {
        conditions.push('t.enabled = ?');
        params.push(Number(enabled));
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    // With a search active and no explicit column sort, order by match relevance
    const useRelevance = search && (!sortKey || sortKey === 'relevance');
    const orderClause = useRelevance
        ? 'search_score DESC, t.name COLLATE NOCASE'
        : (0, list_query_1.parseSort)(query, TEMPLATE_SORTS, TEMPLATE_SORTS.name);
    const scoreSelect = search
        ? ", fuzzy_score(?, t.name || ' ' || t.bot_username) AS search_score"
        : '';
    const scoreParams = search ? [search] : [];
    const baseSql = `
    FROM job_templates t
    LEFT JOIN jobs j ON j.template_id = t.id AND j.retired IS NULL
    ${where}
    GROUP BY t.id
  `;
    if (!paging) {
        const rows = database_1.db.prepare(`
      SELECT t.*, COUNT(j.id) AS linked_job_count ${scoreSelect}
      ${baseSql}
      ORDER BY ${orderClause}
    `).all(...scoreParams, ...params);
        res.json(rows.map(r => ({ ...rowToTemplate(r), linkedJobCount: r.linked_job_count })));
        return;
    }
    const totalRow = database_1.db.prepare(`
    SELECT COUNT(*) AS total FROM job_templates t ${where}
  `).get(...params);
    const rows = database_1.db.prepare(`
    SELECT t.*, COUNT(j.id) AS linked_job_count ${scoreSelect}
    ${baseSql}
    ORDER BY ${orderClause}
    LIMIT ? OFFSET ?
  `).all(...scoreParams, ...params, paging.limit, paging.offset);
    res.json({
        items: rows.map(r => ({ ...rowToTemplate(r), linkedJobCount: r.linked_job_count })),
        total: totalRow.total,
        page: paging.page,
        pageSize: paging.pageSize,
    });
});
router.post('/', (req, res) => {
    const { name, jobType, botUsername, timezone, replyTimeoutMs, retryMax, config, startCommand, checkinButton, runEveryDays, runEveryDaysMax, } = req.body;
    if (!name) {
        res.status(400).json({ error: 'name is required' });
        return;
    }
    const runEvery = normalizeRunEvery(runEveryDays, runEveryDaysMax);
    const result = database_1.db.prepare(`
    INSERT INTO job_templates
      (name, job_type, bot_username, timezone, reply_timeout_ms, retry_max, config, start_command, checkin_button, run_every_days, run_every_days_max)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, jobType ?? 'checkin', botUsername?.replace(/^@+/, '') ?? '', timezone ?? '', Number(replyTimeoutMs ?? 40000), Number(retryMax ?? 5), config != null ? JSON.stringify(config) : null, startCommand?.trim() || '/start', checkinButton?.trim() || '签到', runEvery.min, runEvery.max);
    const row = database_1.db.prepare('SELECT * FROM job_templates WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(rowToTemplate(row));
});
/**
 * `<name> (copy)`, or `(copy 2)` and up when that is taken. Templates are picked from a
 * list by name, so a duplicate reading exactly like its source is of little use.
 */
function copyName(name) {
    const taken = new Set(database_1.db.prepare('SELECT name FROM job_templates').all().map(r => r.name));
    let candidate = `${name} (copy)`;
    for (let n = 2; taken.has(candidate); n++)
        candidate = `${name} (copy ${n})`;
    return candidate;
}
router.post('/:id/duplicate', (req, res) => {
    const source = database_1.db.prepare('SELECT * FROM job_templates WHERE id = ?').get(req.params.id);
    if (!source) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    // Everything the source configures, nothing about its identity: the copy starts with no
    // linked jobs, which stay with the original.
    const result = database_1.db.prepare(`
    INSERT INTO job_templates
      (name, job_type, bot_username, timezone, reply_timeout_ms, retry_max, enabled, config, start_command, checkin_button, run_every_days, run_every_days_max)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(copyName(source.name), source.job_type, source.bot_username, source.timezone, source.reply_timeout_ms, source.retry_max, source.enabled, source.config, source.start_command, source.checkin_button, source.run_every_days, source.run_every_days_max);
    const row = database_1.db.prepare('SELECT * FROM job_templates WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(rowToTemplate(row));
});
router.put('/:id', (req, res) => {
    const existing = database_1.db.prepare('SELECT * FROM job_templates WHERE id = ?').get(req.params.id);
    if (!existing) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    const { name, jobType, botUsername, timezone, replyTimeoutMs, retryMax, enabled, config, startCommand, checkinButton, runEveryDays, runEveryDaysMax, } = req.body;
    const runEvery = normalizeRunEvery(runEveryDays !== undefined ? runEveryDays : existing.run_every_days, runEveryDaysMax !== undefined ? runEveryDaysMax : existing.run_every_days_max);
    const updated = {
        ...existing,
        name: name ?? existing.name,
        job_type: jobType ?? existing.job_type,
        bot_username: botUsername?.replace(/^@+/, '') ?? existing.bot_username,
        timezone: timezone ?? existing.timezone,
        reply_timeout_ms: Number(replyTimeoutMs ?? existing.reply_timeout_ms),
        retry_max: Number(retryMax ?? existing.retry_max),
        enabled: enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled,
        config: config !== undefined
            ? (config != null ? JSON.stringify(config) : null)
            : existing.config,
        start_command: startCommand !== undefined
            ? (startCommand.trim() || '/start')
            : existing.start_command,
        checkin_button: checkinButton !== undefined
            ? (checkinButton.trim() || '签到')
            : existing.checkin_button,
        run_every_days: runEvery.min,
        run_every_days_max: runEvery.max,
    };
    database_1.db.prepare(`
    UPDATE job_templates SET
      name = ?, job_type = ?, bot_username = ?, timezone = ?,
      reply_timeout_ms = ?, retry_max = ?, enabled = ?,
      config = ?, start_command = ?, checkin_button = ?, run_every_days = ?, run_every_days_max = ?
    WHERE id = ?
  `).run(updated.name, updated.job_type, updated.bot_username, updated.timezone, updated.reply_timeout_ms, updated.retry_max, updated.enabled, updated.config, updated.start_command, updated.checkin_button, updated.run_every_days, updated.run_every_days_max, req.params.id);
    syncLinkedJobs(Number(req.params.id), updated);
    const row = database_1.db.prepare('SELECT * FROM job_templates WHERE id = ?').get(req.params.id);
    res.json(rowToTemplate(row));
});
router.delete('/:id', (req, res) => {
    // ON DELETE SET NULL handles unlinking jobs
    database_1.db.prepare('DELETE FROM job_templates WHERE id = ?').run(req.params.id);
    res.status(204).send();
});
// ── Bulk enable / disable linked jobs ────────────────────────────────────────
router.put('/:id/jobs/enabled', (req, res) => {
    const { enabled } = req.body;
    database_1.db.prepare('UPDATE jobs SET enabled = ? WHERE template_id = ?').run(enabled ? 1 : 0, req.params.id);
    (0, scheduler_1.refreshScheduler)();
    res.json({ ok: true });
});
// ── Candidate accounts (no existing job for this template) ───────────────────
router.get('/:id/available-accounts', (req, res) => {
    const rows = database_1.db.prepare(`
    SELECT id, name, phone_number, auth_status, disabled, tg_display_name
    FROM tg_accounts
    WHERE (disabled = 0 OR disabled IS NULL)
      AND id NOT IN (
        SELECT account_id FROM jobs
        WHERE template_id = ? AND account_id IS NOT NULL AND retired IS NULL
      )
    ORDER BY name COLLATE NOCASE
  `).all(req.params.id);
    res.json(rows.map(r => ({
        id: r.id,
        name: r.name,
        phoneNumber: r.phone_number,
        authStatus: r.auth_status,
        tgDisplayName: r.tg_display_name ?? null,
    })));
});
router.post('/:id/create-jobs', (req, res) => {
    const template = database_1.db.prepare('SELECT * FROM job_templates WHERE id = ?').get(req.params.id);
    if (!template) {
        res.status(404).json({ error: 'Not found' });
        return;
    }
    const { jobs, scheduleWindowStart, scheduleWindowEnd } = req.body;
    if (!Array.isArray(jobs) || !jobs.length) {
        res.status(400).json({ error: 'jobs array is required' });
        return;
    }
    const createdIds = [];
    database_1.db.transaction(() => {
        for (const j of jobs) {
            // For embywatch, merge per-job credentials into template config
            let jobConfig = template.config;
            if (j.config && template.job_type === 'embywatch') {
                const tplCfg = template.config ? JSON.parse(template.config) : {};
                jobConfig = JSON.stringify({ ...tplCfg, ...j.config });
            }
            const result = database_1.db.prepare(`
        INSERT INTO jobs (
          name, account_id, job_type, bot_username,
          schedule_window_start, schedule_window_end, timezone,
          reply_timeout_ms, retry_max, enabled, config,
          start_command, checkin_button, template_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
      `).run(j.name, j.accountId, template.job_type, template.bot_username, Number(scheduleWindowStart), Number(scheduleWindowEnd), template.timezone, template.reply_timeout_ms, template.retry_max, jobConfig, template.start_command, template.checkin_button, template.id);
            createdIds.push(Number(result.lastInsertRowid));
        }
    })();
    (0, scheduler_1.refreshScheduler)();
    res.status(201).json({ created: createdIds.length, ids: createdIds });
});
exports.default = router;
