"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.attachWebSocket = attachWebSocket;
const ws_1 = require("ws");
const auth_1 = require("../middleware/auth");
const liveClient_1 = require("./liveClient");
// How often (ms) to poll for new messages in the active chat as a GramJS event fallback
const SYNC_INTERVAL_MS = 4000;
function attachWebSocket(server) {
    const wss = new ws_1.WebSocketServer({ server, path: "/ws" });
    wss.on("connection", (ws, req) => {
        const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
        const accountId = Number(url.searchParams.get("accountId") ?? "0");
        if (!accountId) {
            ws.close(1008, "Missing accountId");
            return;
        }
        // Authenticate via the first message (not the URL) so tokens never appear in access logs
        const authTimeout = setTimeout(() => {
            ws.close(1008, "Auth timeout");
        }, 5000);
        ws.once("message", async (rawData) => {
            clearTimeout(authTimeout);
            let msg;
            try {
                msg = JSON.parse(rawData.toString());
            }
            catch {
                ws.close(1008, "Invalid auth message");
                return;
            }
            if (msg.type !== "auth" || !msg.token) {
                ws.close(1008, "Expected auth message");
                return;
            }
            // Same validation as the HTTP guard: reject captcha/non-session tokens,
            // and block access while a default-password change is still pending
            const decoded = (0, auth_1.verifySessionToken)(msg.token);
            if (!decoded || decoded.requirePasswordChange) {
                ws.close(1008, "Unauthorised");
                return;
            }
            ws.send(JSON.stringify({ type: "authenticated" }));
            await setupConnection(ws, accountId);
        });
    });
}
async function setupConnection(ws, accountId) {
    try {
        await (0, liveClient_1.getLiveClient)(accountId);
    }
    catch (err) {
        ws.send(JSON.stringify({ type: "error", error: "Failed to connect to Telegram" }));
        ws.close();
        return;
    }
    const unsubscribeMsgs = (0, liveClient_1.subscribeToMessages)(accountId, (msg) => {
        if (ws.readyState === ws_1.WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "message", ...msg }));
        }
    });
    const unsubscribeDialogs = (0, liveClient_1.subscribeToDialogs)(accountId, (dialogs) => {
        if (ws.readyState === ws_1.WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "dialogs", dialogs }));
        }
    });
    const unsubscribeReadOutbox = (0, liveClient_1.subscribeToReadOutbox)(accountId, (chatId, maxId) => {
        if (ws.readyState === ws_1.WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "readOutbox", chatId, maxId }));
        }
    });
    const unsubscribeTyping = (0, liveClient_1.subscribeToTyping)(accountId, (event) => {
        if (ws.readyState === ws_1.WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "typing", ...event }));
        }
    });
    // Track which chat the frontend currently has open
    let activeChatId = null;
    // Periodic sync -- fallback for when GramJS NewMessage events don't fire
    const syncInterval = setInterval(() => {
        if (activeChatId && ws.readyState === ws_1.WebSocket.OPEN) {
            (0, liveClient_1.syncMessagesInBackground)(accountId, activeChatId).catch(() => { });
        }
    }, SYNC_INTERVAL_MS);
    ws.on("message", (rawData) => {
        try {
            const data = JSON.parse(rawData.toString());
            if (data.type === "activateChat" && typeof data.chatId === "string") {
                activeChatId = data.chatId;
            }
        }
        catch {
            /* ignore malformed messages */
        }
    });
    // Native ping/pong keepalive -- terminate if the client stops responding
    let isAlive = true;
    const pingInterval = setInterval(() => {
        if (!isAlive) {
            ws.terminate();
            return;
        }
        isAlive = false;
        ws.ping();
    }, 25000);
    ws.on("pong", () => {
        isAlive = true;
    });
    const cleanup = () => {
        clearInterval(pingInterval);
        clearInterval(syncInterval);
        unsubscribeMsgs();
        unsubscribeDialogs();
        unsubscribeReadOutbox();
        unsubscribeTyping();
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
}
