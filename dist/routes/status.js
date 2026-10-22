"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const scheduler_1 = require("../scheduler");
const memory_1 = require("../monitor/memory");
const router = (0, express_1.Router)();
router.get('/', (req, res) => {
    res.json((0, scheduler_1.getSchedulerStatus)());
});
// POST /skip/:jobId -- give up the pending run and arm the one after it. The job keeps its
// schedule; this is calling off one occurrence, not disabling anything.
router.post('/skip/:jobId', (req, res) => {
    const jobId = Number(req.params.jobId);
    if (!Number.isInteger(jobId) || jobId <= 0) {
        res.status(400).json({ error: 'Invalid job id' });
        return;
    }
    const result = (0, scheduler_1.skipNextRun)(jobId);
    if (!result.ok) {
        res.status(404).json({ error: 'That job has no scheduled run' });
        return;
    }
    res.json(result);
});
// Separate path so the schedule list above keeps returning a bare array
router.get('/memory', (req, res) => {
    res.json((0, memory_1.memoryReport)());
});
exports.default = router;
