"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.dataDir = dataDir;
const node_path_1 = __importDefault(require("node:path"));
/**
 * The directory the database sits in. Everything the Cloudflare solver downloads on demand
 * (browser, profiles, fonts) goes here, because it is the one place that is a volume and so
 * survives a restart and an upgrade. Read on every call: tests move DB_PATH around.
 */
function dataDir() {
    return node_path_1.default.dirname(process.env.DB_PATH ?? node_path_1.default.resolve(process.cwd(), "data/bemby.db"));
}
