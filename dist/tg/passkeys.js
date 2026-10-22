"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPasskeyRegistration = buildPasskeyRegistration;
exports.invokeGetPasskeys = invokeGetPasskeys;
exports.invokeDeletePasskey = invokeDeletePasskey;
exports.invokeRegisterPasskey = invokeRegisterPasskey;
exports.invokePasskeyLogin = invokePasskeyLogin;
exports.invokeVerifyPasskeyLogin = invokeVerifyPasskeyLogin;
const crypto_1 = require("crypto");
const telegram_1 = require("telegram");
const generationHelpers_1 = require("telegram/tl/generationHelpers");
// GramJS (TL layer 198) does not yet ship Telegram's passkey types, so we build
// these requests and parse their responses by hand from the documented schema:
//   account.getPasskeys#ea1f0c52 = account.Passkeys;
//   account.passkeys#f8e0aa1c passkeys:Vector<Passkey> = account.Passkeys;
//   passkey#98613ebf flags:# id:string name:string date:int
//                    software_emoji_id:flags.0?long last_usage_date:flags.1?int = Passkey;
//   account.deletePasskey#f5b5563f id:string = Bool;
//   account.initPasskeyRegistration#429547e8 = account.PasskeyRegistrationOptions;
//   account.passkeyRegistrationOptions#e16b5ce1 options:DataJSON = account.PasskeyRegistrationOptions;
//   account.registerPasskey#55b41fd6 credential:InputPasskeyCredential = Passkey;
//   inputPasskeyCredentialPublicKey#3c27b78f id:string raw_id:string response:InputPasskeyResponse = InputPasskeyCredential;
//   inputPasskeyResponseRegister#3e63935c client_data:DataJSON attestation_data:bytes = InputPasskeyResponse;
//   dataJSON#7d748d04 data:string = DataJSON;
//   auth.initPasskeyLogin#518ad0b7 api_id:int api_hash:string = auth.PasskeyLoginOptions;
//   auth.passkeyLoginOptions#e2037789 options:DataJSON = auth.PasskeyLoginOptions;
//   auth.finishPasskeyLogin#9857ad07 flags:# credential:InputPasskeyCredential from_dc_id:flags.0?int from_auth_key_id:flags.0?long = auth.Authorization;
//   inputPasskeyResponseLogin#c31fc14a client_data:DataJSON authenticator_data:bytes signature:bytes user_handle:string = InputPasskeyResponse;
// See https://core.telegram.org/api/passkeys
const GET_PASSKEYS_ID = 0xea1f0c52;
const DELETE_PASSKEY_ID = 0xf5b5563f;
const INIT_REGISTRATION_ID = 0x429547e8;
const REGISTER_PASSKEY_ID = 0x55b41fd6;
const INPUT_CREDENTIAL_PUBKEY_ID = 0x3c27b78f;
const INPUT_RESPONSE_REGISTER_ID = 0x3e63935c;
const INPUT_RESPONSE_LOGIN_ID = 0xc31fc14a;
const INIT_LOGIN_ID = 0x518ad0b7;
const FINISH_LOGIN_ID = 0x9857ad07;
const DATA_JSON_ID = 0x7d748d04;
const BOOL_TRUE_ID = 0x997275b5;
const u32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v, 0);
    return b;
};
const i32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v, 0);
    return b;
};
// A minimal request object shaped like a GramJS TLRequest: invoke() only needs
// classType, resolve(), getBytes() and readResult().
class GetPasskeysRequest {
    constructor() {
        this.CONSTRUCTOR_ID = GET_PASSKEYS_ID;
        this.SUBCLASS_OF_ID = 0;
        this.className = "account.getPasskeys";
        this.classType = "request";
    }
    async resolve() {
        /* no entity params to resolve */
    }
    getBytes() {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(this.CONSTRUCTOR_ID, 0);
        return b;
    }
    // Returns an object (not a bare array) so GramJS's post-invoke entity
    // processing safely finds no users/chats and no-ops.
    readResult(reader) {
        reader.readInt(false); // account.passkeys#f8e0aa1c
        reader.readInt(false); // Vector 0x1cb5c415
        const count = reader.readInt();
        const passkeys = [];
        for (let i = 0; i < count; i++)
            passkeys.push(readPasskey(reader));
        return { passkeys };
    }
}
// passkey#98613ebf flags:# id:string name:string date:int
//                  software_emoji_id:flags.0?long last_usage_date:flags.1?int
function readPasskey(reader) {
    reader.readInt(false); // passkey#98613ebf
    const flags = reader.readInt();
    const id = reader.tgReadString();
    const name = reader.tgReadString();
    const date = reader.readInt();
    const softwareEmojiId = flags & 1 ? reader.readLong() : null;
    const lastUsageDate = flags & 2 ? reader.readInt() : null;
    return {
        id,
        name,
        date,
        softwareEmojiId: softwareEmojiId != null ? String(softwareEmojiId) : null,
        lastUsageDate: lastUsageDate ?? null,
    };
}
class DeletePasskeyRequest {
    constructor(passkeyId) {
        this.passkeyId = passkeyId;
        this.CONSTRUCTOR_ID = DELETE_PASSKEY_ID;
        this.SUBCLASS_OF_ID = 0;
        this.className = "account.deletePasskey";
        this.classType = "request";
    }
    async resolve() {
        /* no entity params to resolve */
    }
    getBytes() {
        const head = Buffer.alloc(4);
        head.writeUInt32LE(this.CONSTRUCTOR_ID, 0);
        return Buffer.concat([head, (0, generationHelpers_1.serializeBytes)(this.passkeyId)]);
    }
    readResult(reader) {
        return reader.readInt(false) === BOOL_TRUE_ID;
    }
}
// account.initPasskeyRegistration -> account.passkeyRegistrationOptions (a DataJSON blob)
class InitPasskeyRegistrationRequest {
    constructor() {
        this.CONSTRUCTOR_ID = INIT_REGISTRATION_ID;
        this.SUBCLASS_OF_ID = 0;
        this.className = "account.initPasskeyRegistration";
        this.classType = "request";
    }
    async resolve() { }
    getBytes() {
        const b = Buffer.alloc(4);
        b.writeUInt32LE(this.CONSTRUCTOR_ID, 0);
        return b;
    }
    // Returns the WebAuthn PublicKeyCredentialCreationOptions JSON (as a string).
    readResult(reader) {
        reader.readInt(false); // account.passkeyRegistrationOptions#e16b5ce1
        reader.readInt(false); // dataJSON#7d748d04
        return { options: reader.tgReadString() };
    }
}
// account.registerPasskey credential:inputPasskeyCredentialPublicKey -> Passkey
class RegisterPasskeyRequest {
    constructor(cred) {
        this.cred = cred;
        this.CONSTRUCTOR_ID = REGISTER_PASSKEY_ID;
        this.SUBCLASS_OF_ID = 0;
        this.className = "account.registerPasskey";
        this.classType = "request";
    }
    async resolve() { }
    getBytes() {
        return Buffer.concat([
            u32(this.CONSTRUCTOR_ID),
            u32(INPUT_CREDENTIAL_PUBKEY_ID),
            (0, generationHelpers_1.serializeBytes)(this.cred.id), // id:string
            (0, generationHelpers_1.serializeBytes)(this.cred.rawId), // raw_id:string
            u32(INPUT_RESPONSE_REGISTER_ID),
            u32(DATA_JSON_ID), // client_data:DataJSON
            (0, generationHelpers_1.serializeBytes)(this.cred.clientDataJson), // dataJSON.data:string
            (0, generationHelpers_1.serializeBytes)(this.cred.attestationData), // attestation_data:bytes
        ]);
    }
    readResult(reader) {
        return readPasskey(reader);
    }
}
// auth.initPasskeyLogin -> auth.passkeyLoginOptions (a DataJSON blob) on a fresh session
class InitPasskeyLoginRequest {
    constructor(apiId, apiHash) {
        this.apiId = apiId;
        this.apiHash = apiHash;
        this.CONSTRUCTOR_ID = INIT_LOGIN_ID;
        this.SUBCLASS_OF_ID = 0;
        this.className = "auth.initPasskeyLogin";
        this.classType = "request";
    }
    async resolve() { }
    getBytes() {
        return Buffer.concat([
            u32(this.CONSTRUCTOR_ID),
            i32(this.apiId), // api_id:int
            (0, generationHelpers_1.serializeBytes)(this.apiHash), // api_hash:string
        ]);
    }
    readResult(reader) {
        reader.readInt(false); // auth.passkeyLoginOptions#e2037789
        reader.readInt(false); // dataJSON#7d748d04
        return { options: reader.tgReadString() };
    }
}
// auth.finishPasskeyLogin credential:inputPasskeyCredentialPublicKey -> auth.Authorization
class FinishPasskeyLoginRequest {
    constructor(a) {
        this.a = a;
        this.CONSTRUCTOR_ID = FINISH_LOGIN_ID;
        this.SUBCLASS_OF_ID = 0;
        this.className = "auth.finishPasskeyLogin";
        this.classType = "request";
    }
    async resolve() { }
    getBytes() {
        return Buffer.concat([
            u32(this.CONSTRUCTOR_ID),
            i32(0), // flags:# (no from_dc_id / from_auth_key_id)
            u32(INPUT_CREDENTIAL_PUBKEY_ID),
            (0, generationHelpers_1.serializeBytes)(this.a.id), // id:string
            (0, generationHelpers_1.serializeBytes)(this.a.rawId), // raw_id:string
            u32(INPUT_RESPONSE_LOGIN_ID),
            u32(DATA_JSON_ID), // client_data:DataJSON
            (0, generationHelpers_1.serializeBytes)(this.a.clientDataJson), // dataJSON.data:string
            (0, generationHelpers_1.serializeBytes)(this.a.authenticatorData), // authenticator_data:bytes
            (0, generationHelpers_1.serializeBytes)(this.a.signature), // signature:bytes
            (0, generationHelpers_1.serializeBytes)(this.a.userHandle), // user_handle:string
        ]);
    }
    // auth.Authorization is a known GramJS type, so let the reader parse it (incl. user).
    readResult(reader) {
        return reader.tgReadObject();
    }
}
// ── Minimal CBOR encoder (only what the attestation object and COSE key need) ──
const cborUint = (major, n) => {
    if (n < 24)
        return Buffer.from([(major << 5) | n]);
    if (n < 0x100)
        return Buffer.from([(major << 5) | 24, n]);
    if (n < 0x10000) {
        const b = Buffer.alloc(3);
        b[0] = (major << 5) | 25;
        b.writeUInt16BE(n, 1);
        return b;
    }
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
};
const cborInt = (v) => (v >= 0 ? cborUint(0, v) : cborUint(1, -1 - v));
const cborBytes = (buf) => Buffer.concat([cborUint(2, buf.length), buf]);
const cborText = (s) => {
    const b = Buffer.from(s, "utf8");
    return Buffer.concat([cborUint(3, b.length), b]);
};
const cborMap = (pairs) => Buffer.concat([cborUint(5, pairs.length), ...pairs.flat()]);
function buildPasskeyRegistration(optionsJson, originOverride) {
    const parsed = JSON.parse(optionsJson);
    const publicKey = parsed.publicKey ?? parsed;
    const challenge = publicKey.challenge;
    const rpId = publicKey.rp?.id;
    const userHandle = publicKey.user?.id;
    if (!challenge || !rpId || !userHandle) {
        throw new Error("passkey registration options missing challenge, rp.id or user.id");
    }
    const origin = originOverride ?? `https://${rpId}`;
    // ES256 (alg -7) keypair; we are the authenticator.
    const { publicKey: pub, privateKey } = (0, crypto_1.generateKeyPairSync)("ec", {
        namedCurve: "P-256",
    });
    const jwk = pub.export({ format: "jwk" });
    const x = Buffer.from(jwk.x, "base64url");
    const y = Buffer.from(jwk.y, "base64url");
    // COSE_Key for EC2/P-256: {1:2, 3:-7, -1:1, -2:x, -3:y}
    const cose = cborMap([
        [cborInt(1), cborInt(2)],
        [cborInt(3), cborInt(-7)],
        [cborInt(-1), cborInt(1)],
        [cborInt(-2), cborBytes(x)],
        [cborInt(-3), cborBytes(y)],
    ]);
    const credentialId = (0, crypto_1.randomBytes)(32);
    // authenticatorData = rpIdHash | flags | signCount | attestedCredentialData
    const rpIdHash = (0, crypto_1.createHash)("sha256").update(rpId).digest();
    const flags = Buffer.from([0x5d]); // UP | UV | BE | BS | AT (synced passkey)
    const signCount = Buffer.alloc(4); // 0
    const aaguid = Buffer.alloc(16); // zeros for "none" attestation
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(credentialId.length, 0);
    const authData = Buffer.concat([
        rpIdHash,
        flags,
        signCount,
        aaguid,
        credIdLen,
        credentialId,
        cose,
    ]);
    // attestationObject = {fmt:"none", attStmt:{}, authData}
    const attestationData = cborMap([
        [cborText("fmt"), cborText("none")],
        [cborText("attStmt"), cborMap([])],
        [cborText("authData"), cborBytes(authData)],
    ]);
    const clientDataJson = JSON.stringify({
        type: "webauthn.create",
        challenge, // base64url, echoed verbatim from the options
        origin,
        crossOrigin: false,
    });
    const credIdB64 = credentialId.toString("base64url");
    return {
        credential: {
            id: credIdB64,
            rawId: credIdB64,
            clientDataJson,
            attestationData,
        },
        credentialId: credIdB64,
        privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        publicKeyCoseHex: cose.toString("hex"),
        rpId,
        userHandle,
    };
}
// Runs the WebAuthn get() ceremony ourselves: sign the login challenge with the
// stored private key and emit the assertion Telegram expects.
function buildPasskeyAssertion(optionsJson, secret, originOverride) {
    const parsed = JSON.parse(optionsJson);
    const publicKey = parsed.publicKey ?? parsed;
    const challenge = publicKey.challenge;
    if (!challenge)
        throw new Error("passkey login options missing challenge");
    const rpId = publicKey.rpId ?? secret.rpId;
    const origin = originOverride ?? `https://${rpId}`;
    const clientDataJson = JSON.stringify({
        type: "webauthn.get",
        challenge,
        origin,
        crossOrigin: false,
    });
    // authenticatorData for an assertion: rpIdHash | flags | signCount (no AT).
    const rpIdHash = (0, crypto_1.createHash)("sha256").update(rpId).digest();
    const flags = Buffer.from([0x1d]); // UP | UV | BE | BS
    const signCount = Buffer.alloc(4);
    const authenticatorData = Buffer.concat([rpIdHash, flags, signCount]);
    const clientDataHash = (0, crypto_1.createHash)("sha256").update(clientDataJson).digest();
    const signature = (0, crypto_1.sign)("sha256", Buffer.concat([authenticatorData, clientDataHash]), (0, crypto_1.createPrivateKey)(secret.privateKeyPem)); // DER-encoded ECDSA (ES256), as WebAuthn expects
    return {
        id: secret.credentialId,
        rawId: secret.credentialId,
        clientDataJson,
        authenticatorData,
        signature,
        // user_handle is the raw decoded bytes of user.id, not the base64url string
        userHandle: Buffer.from(secret.userHandle, "base64url"),
    };
}
async function invokeGetPasskeys(client) {
    const result = (await client.invoke(new GetPasskeysRequest()));
    return result.passkeys;
}
async function invokeDeletePasskey(client, passkeyId) {
    return client.invoke(new DeletePasskeyRequest(passkeyId));
}
// Full registration: init options -> run the ceremony -> register the credential.
async function invokeRegisterPasskey(client, originOverride) {
    const { options } = (await client.invoke(new InitPasskeyRegistrationRequest()));
    const material = buildPasskeyRegistration(options, originOverride);
    const passkey = (await client.invoke(new RegisterPasskeyRequest(material.credential)));
    return {
        passkey,
        credentialId: material.credentialId,
        privateKeyPem: material.privateKeyPem,
        publicKeyCoseHex: material.publicKeyCoseHex,
        rpId: material.rpId,
        userHandle: material.userHandle,
    };
}
// Performs the passkey login factor: init options -> sign assertion -> finish.
// Returns the raw auth.Authorization; throws SESSION_PASSWORD_NEEDED when the
// account also has a 2FA cloud password (the credential itself was accepted).
async function invokePasskeyLogin(client, apiId, apiHash, secret, originOverride) {
    const { options } = (await client.invoke(new InitPasskeyLoginRequest(apiId, apiHash)));
    const assertion = buildPasskeyAssertion(options, secret, originOverride);
    return client.invoke(new FinishPasskeyLoginRequest(assertion));
}
// Proves a passkey works by performing a full passkey login on a fresh session,
// then logging that throwaway authorisation straight back out.
async function invokeVerifyPasskeyLogin(client, apiId, apiHash, secret, originOverride) {
    let auth;
    try {
        auth = await invokePasskeyLogin(client, apiId, apiHash, secret, originOverride);
    }
    catch (err) {
        const msg = err?.errorMessage ?? err?.message ?? "";
        // The credential was accepted; only the second factor (cloud password) remains.
        // That is conclusive proof the passkey works, and no session was created.
        if (msg.includes("SESSION_PASSWORD_NEEDED")) {
            return {
                ok: true,
                passwordRequired: true,
                userId: "",
                firstName: null,
                username: null,
            };
        }
        throw err;
    }
    const user = auth?.user;
    // Clean up the authorisation this login just created so it does not linger.
    await client.invoke(new telegram_1.Api.auth.LogOut()).catch(() => undefined);
    return {
        ok: !!user,
        passwordRequired: false,
        userId: user?.id != null ? String(user.id) : "",
        firstName: user?.firstName ?? null,
        username: user?.username ?? null,
    };
}
