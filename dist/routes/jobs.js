"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeRunEvery = normalizeRunEvery;
const express_1 = require("express");
const database_1 = require("../db/database");
const secretColumns_1 = require("../db/secretColumns");
const runner_1 = require("../jobs/runner");
const runWarnings_1 = require("../jobs/runWarnings");
const notify_1 = require("../jobs/notify");
const scheduler_1 = require("../scheduler");
const cancellation_1 = require("../jobs/cancellation");
const embywatch_1 = require("../jobs/embywatch");
const list_query_1 = require("./list-query");
const router = (0, express_1.Router)();
/** Credentials are resolved as a pair: the account's own if complete, else the global defaults. */
function rowToAccount(row) {
    const ownCredentials = row.api_id && row.api_hash
        ? { apiId: row.api_id, apiHash: row.api_hash }
        : null;
    const credentials = ownCredentials ?? (0, database_1.getDefaultTgApiCredentials)();
    return {
        id: row.id,
        name: row.name,
        phoneNumber: row.phone_number,
        apiId: credentials?.apiId ?? null,
        apiHash: credentials?.apiHash ?? null,
        sessionString: row.session_string,
        authStatus: row.auth_status,
        proxyId: row.proxy_id ?? null,
        disabled: Boolean(row.disabled),
        appClientId: row.app_client_id ?? null,
        createdAt: row.created_at,
    };
}
// Normalise a run-every-days range: min is clamped to >= 1; max is kept only
// when it is a valid integer strictly greater than min, otherwise null (fixed).
function normalizeRunEvery(min, max) {
    const lo = Math.max(1, Math.floor(Number(min ?? 1)) || 1);
    const hiNum = max == null || max === "" ? NaN : Math.floor(Number(max));
    const hi = Number.isFinite(hiNum) && hiNum > lo ? hiNum : null;
    return { min: lo, max: hi };
}
function rowToJob(row) {
    return {
        id: row.id,
        name: row.name,
        accountId: row.account_id ?? null,
        accountName: row.account_name,
        jobType: row.job_type,
        botUsername: row.bot_username,
        scheduleWindowStart: row.schedule_window_start,
        scheduleWindowEnd: row.schedule_window_end,
        timezone: row.timezone,
        replyTimeoutMs: row.reply_timeout_ms,
        retryMax: row.retry_max,
        enabled: Boolean(row.enabled),
        createdAt: row.created_at,
        config: row.config ?? null,
        startCommand: row.start_command || "/start",
        checkinButton: row.checkin_button || "签到",
        templateId: row.template_id ?? null,
        runEveryDays: row.run_every_days ?? 1,
        runEveryDaysMax: row.run_every_days_max ?? null,
        retired: row.retired ?? null,
        lastSuccessAt: row.last_success_at ?? null,
    };
}
const JOB_SORTS = {
    name: "j.name COLLATE NOCASE",
    account: "account_name COLLATE NOCASE",
    type: "j.job_type",
    botUrl: "j.bot_username COLLATE NOCASE",
    window: "j.schedule_window_start",
    // asc shows enabled jobs first, matching the previous client-side sort
    enabled: "CASE WHEN j.enabled = 1 THEN 0 ELSE 1 END",
    // asc puts never-succeeded jobs first, then oldest success
    lastSuccess: "j.last_success_at",
};
router.get("/", (req, res) => {
    const query = req.query;
    const paging = (0, list_query_1.parsePaging)(query);
    const search = (0, list_query_1.textParam)(query.search);
    const jobType = (0, list_query_1.textParam)(query.jobType);
    const accountId = (0, list_query_1.textParam)(query.accountId);
    const botUsername = (0, list_query_1.textParam)(query.botUsername);
    const templateId = (0, list_query_1.textParam)(query.templateId);
    const enabled = (0, list_query_1.textParam)(query.enabled);
    const conditions = ["j.retired IS NULL"];
    const params = [];
    if (search) {
        conditions.push("j.name LIKE ? ESCAPE '\\'");
        params.push(`%${(0, list_query_1.escapeLike)(search)}%`);
    }
    if (jobType) {
        conditions.push("j.job_type = ?");
        params.push(jobType);
    }
    if (accountId) {
        const parsed = Number(accountId);
        if (!Number.isInteger(parsed)) {
            res.status(400).json({ error: "Invalid accountId" });
            return;
        }
        conditions.push("j.account_id = ?");
        params.push(parsed);
    }
    if (botUsername) {
        conditions.push("j.bot_username = ?");
        params.push(botUsername);
    }
    if (templateId) {
        const parsed = Number(templateId);
        if (!Number.isInteger(parsed)) {
            res.status(400).json({ error: "Invalid templateId" });
            return;
        }
        conditions.push("j.template_id = ?");
        params.push(parsed);
    }
    if (enabled === "1" || enabled === "0") {
        conditions.push("j.enabled = ?");
        params.push(Number(enabled));
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const orderClause = (0, list_query_1.parseSort)(query, JOB_SORTS, JOB_SORTS.name);
    const baseSql = `
    FROM jobs j
    LEFT JOIN tg_accounts a ON j.account_id = a.id
    ${where}
  `;
    if (!paging) {
        const rows = database_1.db
            .prepare(`SELECT j.*, a.name AS account_name ${baseSql} ORDER BY ${orderClause}`)
            .all(...params);
        res.json(rows.map(rowToJob));
        return;
    }
    const totalRow = database_1.db
        .prepare(`SELECT COUNT(*) AS total ${baseSql}`)
        .get(...params);
    const rows = database_1.db
        .prepare(`
      SELECT j.*, a.name AS account_name
      ${baseSql}
      ORDER BY ${orderClause}
      LIMIT ? OFFSET ?
    `)
        .all(...params, paging.limit, paging.offset);
    // Facets let the client build filter dropdowns without loading every row
    const botUsernames = database_1.db
        .prepare(`
      SELECT DISTINCT bot_username FROM jobs
      WHERE retired IS NULL AND template_id IS NULL AND bot_username != ''
      ORDER BY bot_username COLLATE NOCASE
    `)
        .all();
    const templatesInUse = database_1.db
        .prepare(`
      SELECT DISTINCT t.id, t.name FROM jobs j
      JOIN job_templates t ON j.template_id = t.id
      WHERE j.retired IS NULL
      ORDER BY t.name COLLATE NOCASE
    `)
        .all();
    res.json({
        items: rows.map(rowToJob),
        total: totalRow.total,
        page: paging.page,
        pageSize: paging.pageSize,
        facets: {
            botUsernames: botUsernames.map((r) => r.bot_username),
            templates: templatesInUse,
        },
    });
});
// Verify Emby server reachability and credentials without creating a job
router.post("/test-emby", async (req, res) => {
    const { serverUrl, username, password, userAgent, proxyId } = req.body;
    if (!serverUrl || !username || !password) {
        res
            .status(400)
            .json({ error: "serverUrl, username and password are required" });
        return;
    }
    if (!/^https?:\/\//i.test(serverUrl)) {
        res
            .status(400)
            .json({ error: "serverUrl must start with http:// or https://" });
        return;
    }
    const result = await (0, embywatch_1.testEmbyConnection)(serverUrl, {
        username,
        password,
        userAgent,
        proxyId,
    });
    res.json(result);
});
router.post("/", (req, res) => {
    const { name, accountId, jobType, botUsername, scheduleWindowStart, scheduleWindowEnd, timezone, replyTimeoutMs, retryMax, enabled, config, startCommand, checkinButton, templateId, runEveryDays, runEveryDaysMax, } = req.body;
    const resolvedType = jobType ?? "checkin";
    const needsAccount = resolvedType === "checkin" ||
        resolvedType === "custom" ||
        resolvedType === "autoreg";
    // A custom job need not target a bot at all: its actions can each name their own
    // contact, or drive a page that never touches Telegram.
    if (!name || (needsAccount && !accountId) || (resolvedType !== "custom" && !botUsername)) {
        res.status(400).json({
            error: "name is required; botUsername is required for every type except custom; " +
                "accountId is required for checkin, custom and autoreg jobs",
        });
        return;
    }
    const runEvery = normalizeRunEvery(runEveryDays, runEveryDaysMax);
    const result = database_1.db
        .prepare(`
    INSERT INTO jobs
      (name, account_id, job_type, bot_username, schedule_window_start, schedule_window_end,
       timezone, reply_timeout_ms, retry_max, enabled, config, start_command, checkin_button, template_id, run_every_days, run_every_days_max)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
        .run(name, accountId ? Number(accountId) : null, resolvedType, botUsername.replace(/^@+/, ""), Number(scheduleWindowStart ?? 1400), Number(scheduleWindowEnd ?? 1600), timezone ?? "", Number(replyTimeoutMs ?? 40000), Number(retryMax ?? 5), enabled !== false ? 1 : 0, config != null ? JSON.stringify(config) : null, startCommand?.trim() || "/start", checkinButton?.trim() || "签到", templateId ? Number(templateId) : null, runEvery.min, runEvery.max);
    const row = database_1.db
        .prepare("SELECT j.*, a.name AS account_name FROM jobs j LEFT JOIN tg_accounts a ON j.account_id = a.id WHERE j.id = ?")
        .get(result.lastInsertRowid);
    (0, scheduler_1.refreshScheduler)();
    res.status(201).json(rowToJob(row));
});
router.put("/:id", (req, res) => {
    const existing = database_1.db
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(req.params.id);
    if (!existing) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    const { name, accountId, jobType, botUsername, scheduleWindowStart, scheduleWindowEnd, timezone, replyTimeoutMs, retryMax, enabled, config, startCommand, checkinButton, templateId, runEveryDays, runEveryDaysMax, } = req.body;
    // When linked to a template, template-controlled fields are read-only
    const isLinked = existing.template_id != null && templateId === undefined;
    const resolvedTemplateId = templateId !== undefined
        ? (templateId ? Number(templateId) : null)
        : existing.template_id;
    const updatedType = isLinked ? existing.job_type : (jobType ?? existing.job_type);
    const runEvery = normalizeRunEvery(runEveryDays !== undefined ? runEveryDays : existing.run_every_days, runEveryDaysMax !== undefined ? runEveryDaysMax : existing.run_every_days_max);
    database_1.db.prepare(`
    UPDATE jobs SET
      name = ?, account_id = ?, job_type = ?, bot_username = ?,
      schedule_window_start = ?, schedule_window_end = ?, timezone = ?,
      reply_timeout_ms = ?, retry_max = ?, enabled = ?, config = ?,
      start_command = ?, checkin_button = ?, template_id = ?, run_every_days = ?, run_every_days_max = ?
    WHERE id = ?
  `).run(name ?? existing.name, accountId !== undefined ? (accountId ? Number(accountId) : null) : (existing.account_id ?? null), updatedType, isLinked ? existing.bot_username : (botUsername?.replace(/^@+/, "") ?? existing.bot_username), Number(scheduleWindowStart ?? existing.schedule_window_start), Number(scheduleWindowEnd ?? existing.schedule_window_end), isLinked ? existing.timezone : (timezone ?? existing.timezone), isLinked ? existing.reply_timeout_ms : Number(replyTimeoutMs ?? existing.reply_timeout_ms), isLinked ? existing.retry_max : Number(retryMax ?? existing.retry_max), enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled, 
    // embywatch template-linked jobs store credentials in the job; allow config updates
    (isLinked && existing.job_type !== 'embywatch') ? existing.config : (config !== undefined
        ? config != null
            ? JSON.stringify(config)
            : null
        : existing.config), isLinked ? existing.start_command : (startCommand !== undefined ? (startCommand.trim() || "/start") : existing.start_command), isLinked ? existing.checkin_button : (checkinButton !== undefined ? (checkinButton.trim() || "签到") : existing.checkin_button), resolvedTemplateId, runEvery.min, runEvery.max, req.params.id);
    const row = database_1.db
        .prepare("SELECT j.*, a.name AS account_name FROM jobs j LEFT JOIN tg_accounts a ON j.account_id = a.id WHERE j.id = ?")
        .get(req.params.id);
    (0, scheduler_1.refreshScheduler)();
    res.json(rowToJob(row));
});
router.delete("/:id", (req, res) => {
    database_1.db.prepare("DELETE FROM jobs WHERE id = ?").run(req.params.id);
    (0, scheduler_1.refreshScheduler)();
    res.status(204).send();
});
// Manual trigger
router.post("/:id/run", async (req, res) => {
    const jobRow = database_1.db
        .prepare("SELECT * FROM jobs WHERE id = ?")
        .get(req.params.id);
    if (!jobRow) {
        res.status(404).json({ error: "Not found" });
        return;
    }
    const job = rowToJob(jobRow);
    let account = null;
    if (job.jobType === "checkin" || job.jobType === "custom" || job.jobType === "autoreg") {
        const accountRow = database_1.db
            .prepare("SELECT * FROM tg_accounts WHERE id = ?")
            .get(jobRow.account_id);
        if (accountRow)
            (0, secretColumns_1.decryptAccountRow)(accountRow);
        if (!accountRow?.session_string) {
            res.status(400).json({ error: "Account is not authenticated" });
            return;
        }
        account = rowToAccount(accountRow);
        if (!account.apiId || !account.apiHash) {
            res.status(400).json({
                error: "No API credentials available for this account. Add credentials to the account or configure global defaults in Settings.",
            });
            return;
        }
    }
    else if (job.accountId) {
        // Optional linked account (e.g. embywatch) — used for notifications only; don't block if not authenticated
        const accountRow = database_1.db
            .prepare("SELECT * FROM tg_accounts WHERE id = ?")
            .get(job.accountId);
        if (accountRow)
            (0, secretColumns_1.decryptAccountRow)(accountRow);
        if (accountRow?.session_string) {
            account = rowToAccount(accountRow);
        }
    }
    const ranAt = new Date().toISOString();
    const logResult = database_1.db
        .prepare("INSERT INTO job_logs (job_id, ran_at, status, message, source) VALUES (?, ?, 'running', 'Manual run', 'manual')")
        .run(job.id, ranAt);
    const logId = logResult.lastInsertRowid;
    res.json({ message: "Job triggered", logId });
    const detailLogs = [];
    const signal = (0, cancellation_1.registerJob)(Number(logId));
    (0, cancellation_1.registerLiveDetail)(Number(logId), detailLogs);
    (0, runner_1.runJob)(job, account, detailLogs, signal)
        .then(() => {
        const detail = detailLogs.length ? JSON.stringify(detailLogs) : null;
        const warnings = (0, runWarnings_1.collectRunWarnings)(job.jobType, detailLogs);
        database_1.db.prepare("UPDATE job_logs SET status = 'success', message = ?, detail = ? WHERE id = ?").run((0, runWarnings_1.completedMessage)(warnings), detail, logId);
        // Durable stamp; job_logs is pruned by log_retention_days. Only moves
        // forward so a slow run finishing after a later one can't rewind it.
        // Isolated: a failure here must not demote an otherwise successful run.
        try {
            database_1.db.prepare(`UPDATE jobs SET last_success_at = ?
           WHERE id = ? AND (last_success_at IS NULL OR last_success_at < ?)`).run(ranAt, job.id, ranAt);
        }
        catch (e) {
            console.warn(`[jobs] "${job.name}" last_success_at stamp failed:`, e);
        }
        void (0, notify_1.notifyJobEvent)("success", (0, notify_1.buildSuccessMessage)(job.name, job.jobType, detailLogs), account, undefined, job.jobType);
    })
        .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        const isCancelled = message === "Job cancelled";
        const detail = detailLogs.length ? JSON.stringify(detailLogs) : null;
        database_1.db.prepare("UPDATE job_logs SET status = 'failed', message = ?, detail = ? WHERE id = ?").run(isCancelled ? "Cancelled" : message, detail, logId);
        if (!isCancelled) {
            void (0, notify_1.notifyJobEvent)("failed", (0, notify_1.buildFailureMessage)(job.name, job.jobType, message), account);
        }
    })
        .finally(() => { (0, cancellation_1.unregisterJob)(Number(logId)); (0, cancellation_1.clearLiveDetail)(Number(logId)); });
});
exports.default = router;
