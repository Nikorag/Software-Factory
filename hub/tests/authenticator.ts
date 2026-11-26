import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

// A minimal software WebAuthn authenticator (ES256, "none" attestation, user-verifying) for tests.
const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest();

function cborBytes(b: Buffer) { return b.length < 24 ? Buffer.concat([Buffer.from([0x40 + b.length]), b]) : b.length < 256 ? Buffer.concat([Buffer.from([0x58, b.length]), b]) : Buffer.concat([Buffer.from([0x59, b.length >> 8, b.length & 255]), b]); }
const cborText = (s: string) => Buffer.concat([Buffer.from([0x60 + s.length]), Buffer.from(s)]);

export class SoftAuthenticator {
  readonly credentialId = randomBytes(32);
  private keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  counter = 0;
  constructor(private rpId: string, private origin: string) {}

  private clientData(type: string, challenge: string, origin = this.origin) { return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })); }

  register(options: { challenge: string }, opts: { uv?: boolean } = {}) {
    const jwk = this.keys.publicKey.export({ format: "jwk" });
    const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x!, "base64url"), Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y!, "base64url")]);
    const flags = 0x01 | (opts.uv === false ? 0 : 0x04) | 0x40;
    const authData = Buffer.concat([sha(this.rpId), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, this.credentialId.length]), this.credentialId, cose]);
    const att = Buffer.concat([Buffer.from([0xa3]), cborText("fmt"), cborText("none"), cborText("attStmt"), Buffer.from([0xa0]), cborText("authData"), cborBytes(authData)]);
    return { id: b64u(this.credentialId), rawId: b64u(this.credentialId), type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(this.clientData("webauthn.create", options.challenge)), attestationObject: b64u(att), transports: ["internal"] } };
  }

  assert(options: { challenge: string }, opts: { origin?: string; uv?: boolean; counter?: number } = {}) {
    this.counter = opts.counter ?? this.counter + 1;
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha(this.rpId), Buffer.from([0x01 | (opts.uv === false ? 0 : 0x04)]), cnt]);
    const cd = this.clientData("webauthn.get", options.challenge, opts.origin);
    const signature = sign("sha256", Buffer.concat([authData, sha(cd)]), this.keys.privateKey);
    return { id: b64u(this.credentialId), rawId: b64u(this.credentialId), type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature) } };
  }
}
