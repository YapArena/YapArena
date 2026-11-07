import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  ECDH,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";

// Web Push (RFC 8030): the server posts a message to the address the browser's push service
// gave it, and the push service wakes the browser's service worker. Each message is encrypted
// for that browser (RFC 8291, "aes128gcm" from RFC 8188) and signed with the site's VAPID key
// (RFC 8292), so push services accept it only from this site. node:crypto does all of it.

const CURVE = "prime256v1";
// One record holds the whole message: the push services accept 4096 bytes.
const RECORD_SIZE = 4096;
const HEADER_SIZE = 16 + 4 + 1 + 65;
const MAX_PLAINTEXT = RECORD_SIZE - HEADER_SIZE - 1 - 16;
const VAPID_SECONDS = 12 * 60 * 60;

export interface PushSubscriptionRecord {
  endpoint: string;
  // The browser's P-256 public key (65 bytes) and its 16-byte secret, base64url.
  p256dh: string;
  auth: string;
}

// The browsers' push services. A saved address must be HTTPS on one of these hosts, so the
// worker never posts to an address chosen by whoever saved it.
const pushHosts = [
  /^fcm\.googleapis\.com$/, // Chrome, Android, Opera, Samsung Internet
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^web\.push\.apple\.com$/, // Safari, and Home Screen apps on iPhone and iPad
  /^[a-z0-9-]+\.notify\.windows\.com$/, // Edge
];

// Base64url text of exactly `bytes` bytes, in canonical form; null otherwise. Browsers send
// base64url, sometimes padded.
function decodeKey(value: unknown, bytes: number) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(value))
    return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === bytes ? decoded : null;
}

function isCurvePoint(key: Buffer) {
  try {
    ECDH.convertKey(key, CURVE, undefined, undefined, "uncompressed");
    return key[0] === 4;
  } catch {
    return false;
  }
}

// The push service address, normalized; null unless it is HTTPS on a known push service.
export function pushEndpoint(value: unknown) {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !pushHosts.some((host) => host.test(url.hostname))
  )
    return null;
  return url.href.length <= 2048 ? url.href : null;
}

// A browser's PushSubscription.toJSON() output, checked; null when anything is off.
export function parsePushSubscription(
  value: unknown,
): PushSubscriptionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: unknown };
  const address = pushEndpoint(endpoint);
  if (!address || typeof keys !== "object" || keys === null) return null;
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown };
  const publicKey = decodeKey(p256dh, 65);
  const secret = decodeKey(auth, 16);
  if (!publicKey || !secret || !isCurvePoint(publicKey)) return null;
  return {
    endpoint: address,
    p256dh: publicKey.toString("base64url"),
    auth: secret.toString("base64url"),
  };
}

// The VAPID public key in canonical base64url; throws when it isn't a P-256 public key.
export function vapidPublicKey(value: string) {
  const key = decodeKey(value, 65);
  if (!key || !isCurvePoint(key))
    throw new Error(
      "WEB_PUSH_PUBLIC_KEY must be a P-256 public key in base64url (87 characters)",
    );
  return key.toString("base64url");
}

// The signing key for a VAPID key pair; throws unless the private key belongs to the public one.
export function vapidSigningKey(publicKey: string, privateKey: string) {
  const point = Buffer.from(vapidPublicKey(publicKey), "base64url");
  const secret = decodeKey(privateKey, 32);
  if (!secret)
    throw new Error(
      "WEB_PUSH_PRIVATE_KEY must be a P-256 private key in base64url (43 characters)",
    );
  const derived = createECDH(CURVE);
  try {
    derived.setPrivateKey(secret);
  } catch {
    throw new Error("WEB_PUSH_PRIVATE_KEY is not a valid P-256 private key");
  }
  if (!derived.getPublicKey().equals(point))
    throw new Error(
      "WEB_PUSH_PRIVATE_KEY does not belong to WEB_PUSH_PUBLIC_KEY; paste both from one generated pair",
    );
  return createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: secret.toString("base64url"),
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
}

// RFC 8291 message encryption in one aes128gcm record. A fresh server key and salt protect
// every message; tests pass fixed ones to check the RFC's own example.
export function encryptPushPayload(
  plaintext: Buffer,
  keys: Pick<PushSubscriptionRecord, "p256dh" | "auth">,
  {
    salt = randomBytes(16),
    serverPrivateKey,
  }: { salt?: Buffer; serverPrivateKey?: Buffer } = {},
) {
  if (plaintext.length > MAX_PLAINTEXT)
    throw new Error("push message is too large");
  const userPublic = Buffer.from(keys.p256dh, "base64url");
  const authSecret = Buffer.from(keys.auth, "base64url");
  const server = createECDH(CURVE);
  if (serverPrivateKey) server.setPrivateKey(serverPrivateKey);
  else server.generateKeys();
  const serverPublic = server.getPublicKey();
  const shared = server.computeSecret(userPublic);
  const ikm = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      authSecret,
      Buffer.concat([Buffer.from("WebPush: info\0"), userPublic, serverPublic]),
      32,
    ),
  );
  const cek = Buffer.from(
    hkdfSync(
      "sha256",
      ikm,
      salt,
      Buffer.from("Content-Encoding: aes128gcm\0"),
      16,
    ),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 0x02 marks the last (here the only) record.
  const record = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(serverPublic.length, 20);
  return Buffer.concat([header, serverPublic, record]);
}

const jsonPart = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

// The VAPID Authorization header for one push service: a JWT signed with ES256 for the
// service's origin, valid 12 hours, naming the site as the contact.
export function vapidAuthorization(
  endpoint: string,
  vapid: { publicKey: string; key: KeyObject; subject: string },
  now: number,
) {
  const unsigned = `${jsonPart({ typ: "JWT", alg: "ES256" })}.${jsonPart({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + VAPID_SECONDS,
    sub: vapid.subject,
  })}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: vapid.key,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${unsigned}.${signature.toString("base64url")}, k=${vapid.publicKey}`;
}

// What a push service answered: delivered; gone (404/410: the browser unsubscribed or the
// address expired, so the subscription is deleted); refused (a message the service will never
// take); or worth one more try later (no answer, 429 or a server error).
export type PushOutcome = "sent" | "gone" | "refused" | "retry";

export function pushOutcome(status: number): PushOutcome {
  if (status >= 200 && status < 300) return "sent";
  if (status === 404 || status === 410) return "gone";
  if (status === 429 || status >= 500) return "retry";
  return "refused";
}

export function createWebPush({
  publicKey,
  privateKey,
  subject,
  fetch: send = fetch,
  now = Date.now,
  timeoutMs = 10_000,
}: {
  publicKey: string;
  privateKey: string;
  // The VAPID contact: the site's HTTPS origin.
  subject: string;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}) {
  const vapid = {
    publicKey: vapidPublicKey(publicKey),
    key: vapidSigningKey(publicKey, privateKey),
    subject,
  };
  return Object.freeze({
    publicKey: vapid.publicKey,
    async send(
      subscription: PushSubscriptionRecord,
      message: object,
      ttlSeconds: number,
    ): Promise<{ outcome: PushOutcome; status?: number }> {
      const body = encryptPushPayload(
        Buffer.from(JSON.stringify(message)),
        subscription,
      );
      try {
        const response = await send(subscription.endpoint, {
          method: "POST",
          headers: {
            Authorization: vapidAuthorization(
              subscription.endpoint,
              vapid,
              now(),
            ),
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            TTL: String(ttlSeconds),
            Urgency: "high",
          },
          body,
          // A push service never redirects; following one could reach any address.
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.body?.cancel().catch(() => {});
        return {
          outcome: pushOutcome(response.status),
          status: response.status,
        };
      } catch {
        return { outcome: "retry" };
      }
    },
  });
}

export type WebPush = ReturnType<typeof createWebPush>;
