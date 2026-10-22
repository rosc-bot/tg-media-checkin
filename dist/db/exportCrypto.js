"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.encryptPayload = encryptPayload;
exports.decryptPayload = decryptPayload;
const crypto_1 = __importDefault(require("crypto"));
function encryptPayload(plaintext, secret) {
    const salt = crypto_1.default.randomBytes(16);
    const key = crypto_1.default.scryptSync(secret, salt, 32);
    const iv = crypto_1.default.randomBytes(12);
    const cipher = crypto_1.default.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
        encrypted: true,
        version: "1",
        salt: salt.toString("hex"),
        iv: iv.toString("hex"),
        tag: cipher.getAuthTag().toString("hex"),
        data: encrypted.toString("base64"),
    };
}
function decryptPayload(envelope, secret) {
    const salt = Buffer.from(envelope.salt, "hex");
    const key = crypto_1.default.scryptSync(secret, salt, 32);
    const iv = Buffer.from(envelope.iv, "hex");
    const tag = Buffer.from(envelope.tag, "hex");
    const decipher = crypto_1.default.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(Buffer.from(envelope.data, "base64")) + decipher.final("utf8");
}
