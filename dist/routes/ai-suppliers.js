"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = require("../db/database");
const router = (0, express_1.Router)();
/** Removes the pinned-default setting when its ai_models row no longer exists. */
function clearDanglingDefaultModel() {
    const pinned = database_1.db.prepare("SELECT value FROM settings WHERE key = 'ai_default_model_id'").get();
    if (!pinned)
        return;
    if (!database_1.db.prepare('SELECT id FROM ai_models WHERE id = ?').get(Number(pinned.value))) {
        database_1.db.prepare("DELETE FROM settings WHERE key = 'ai_default_model_id'").run();
    }
}
const maskKey = (key) => {
    if (!key)
        return '';
    if (key.length <= 8)
        return '*'.repeat(key.length);
    return key.slice(0, 4) + '*'.repeat(key.length - 8) + key.slice(-4);
};
function listAll() {
    const suppliers = database_1.db.prepare('SELECT * FROM ai_suppliers ORDER BY id').all();
    const models = database_1.db.prepare('SELECT * FROM ai_models ORDER BY id').all();
    return suppliers.map(s => ({ ...s, api_key: maskKey(s.api_key), models: models.filter(m => m.supplier_id === s.id) }));
}
router.get('/', (_req, res) => {
    res.json(listAll());
});
router.post('/', (req, res) => {
    const { name, base_url, api_key = '', timeout_ms = 25000 } = req.body;
    if (!name?.trim() || !base_url?.trim()) {
        res.status(400).json({ error: 'name and base_url are required' });
        return;
    }
    const { lastInsertRowid } = database_1.db.prepare('INSERT INTO ai_suppliers (name, base_url, api_key, timeout_ms) VALUES (?, ?, ?, ?)').run(name.trim(), base_url.trim(), (api_key ?? '').trim(), Number(timeout_ms));
    const created = database_1.db.prepare('SELECT * FROM ai_suppliers WHERE id = ?').get(lastInsertRowid);
    res.json({ ...created, api_key: maskKey(created.api_key) });
});
router.put('/:id', (req, res) => {
    const id = Number(req.params.id);
    const existing = database_1.db.prepare('SELECT * FROM ai_suppliers WHERE id = ?').get(id);
    if (!existing) {
        res.status(404).json({ error: 'Supplier not found' });
        return;
    }
    const { name, base_url, api_key, timeout_ms } = req.body;
    database_1.db.prepare('UPDATE ai_suppliers SET name = ?, base_url = ?, api_key = ?, timeout_ms = ? WHERE id = ?').run(name?.trim() ?? existing.name, base_url?.trim() ?? existing.base_url, api_key !== undefined && !api_key.includes('*') ? api_key.trim() : existing.api_key, timeout_ms !== undefined ? Number(timeout_ms) : existing.timeout_ms, id);
    const updated = database_1.db.prepare('SELECT * FROM ai_suppliers WHERE id = ?').get(id);
    res.json({ ...updated, api_key: maskKey(updated.api_key) });
});
router.delete('/:id', (req, res) => {
    database_1.db.prepare('DELETE FROM ai_suppliers WHERE id = ?').run(Number(req.params.id));
    clearDanglingDefaultModel();
    res.json({ ok: true });
});
router.post('/:id/models', (req, res) => {
    const supplierId = Number(req.params.id);
    const { model_id, label } = req.body;
    if (!model_id?.trim()) {
        res.status(400).json({ error: 'model_id is required' });
        return;
    }
    if (!database_1.db.prepare('SELECT id FROM ai_suppliers WHERE id = ?').get(supplierId)) {
        res.status(404).json({ error: 'Supplier not found' });
        return;
    }
    const { lastInsertRowid } = database_1.db.prepare('INSERT INTO ai_models (supplier_id, model_id, label) VALUES (?, ?, ?)').run(supplierId, model_id.trim(), label?.trim() || null);
    res.json(database_1.db.prepare('SELECT * FROM ai_models WHERE id = ?').get(lastInsertRowid));
});
router.delete('/:id/models/:modelId', (req, res) => {
    database_1.db.prepare('DELETE FROM ai_models WHERE id = ?').run(Number(req.params.modelId));
    clearDanglingDefaultModel();
    res.json({ ok: true });
});
exports.default = router;
