"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.issueMediaTicket = issueMediaTicket;
exports.isValidMediaTicket = isValidMediaTicket;
exports.resetMediaTickets = resetMediaTickets;
const crypto_1 = require("crypto");
const TTL_MS = 15 * 60000;
/** Bounds the map on a long messenger session; oldest go first. */
const MAX_TICKETS = 100;
const tickets = new Map();
function sweep() {
    const now = Date.now();
    for (const [id, ticket] of tickets)
        if (ticket.expiresAt <= now)
            tickets.delete(id);
    while (tickets.size >= MAX_TICKETS) {
        const oldest = tickets.keys().next();
        if (oldest.done)
            break;
        tickets.delete(oldest.value);
    }
}
function issueMediaTicket() {
    sweep();
    const ticket = (0, crypto_1.randomBytes)(24).toString('base64url');
    const expiresAt = Date.now() + TTL_MS;
    tickets.set(ticket, { expiresAt });
    return { ticket, expiresAt };
}
/** Unlike the captcha, this is not consumed: one page renders many images from one ticket. */
function isValidMediaTicket(ticket) {
    if (!ticket)
        return false;
    const found = tickets.get(ticket);
    if (!found)
        return false;
    if (found.expiresAt <= Date.now()) {
        tickets.delete(ticket);
        return false;
    }
    return true;
}
/** Test hook: drops every outstanding ticket. */
function resetMediaTickets() {
    tickets.clear();
}
