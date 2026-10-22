"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const checkin_1 = require("../jobs/checkin");
const router = express_1.default.Router();
router.post('/ai', async (req, res) => {
    const { images = [], prompt, maxTokens = 5000, model } = req.body;
    if (!prompt?.trim()) {
        res.status(400).json({ error: 'prompt is required' });
        return;
    }
    const t0 = Date.now();
    try {
        const { response } = await (0, checkin_1.callAI)(images, prompt.trim(), maxTokens, model);
        res.json({ response, durationMs: Date.now() - t0 });
    }
    catch (err) {
        res.status(500).json({ error: err?.message ?? String(err) });
    }
});
exports.default = router;
