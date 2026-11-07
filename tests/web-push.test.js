import assert from "node:assert/strict";
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  verify,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  createWebPush,
  encryptPushPayload,
  parsePushSubscription,
  pushEndpoint,
  pushOutcome,
  vapidAuthorization,
  vapidPublicKey,
  vapidSigningKey,
} from "../dist/platform/web-push.js";
import { loadConfig } from "../dist/platform/config.js";
import { generateWebPushKeys } from "../scripts/generate-web-push-keys.ts";

// Web push for "Notify me" (first-run build plan PR 10): the protocol, its keys and settings.
const b64 = (value) => Buffer.from(value, "base64url");

// A browser's key pair and secret, as PushSubscription.toJSON() reports them.
function browserKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    ecdh,
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: Buffer.from("0123456789abcdef").toString("base64url"),
  };
}

// The site's VAPID pair, generated the way the founder's command does.
function vapidPair() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString("base64url"),
    privateKey: ecdh.getPrivateKey().toString("base64url"),
  };
}

// RFC 8291 decryption, as the browser does it, to check what the server sends.
function decrypt(body, keys) {
  const salt = body.subarray(0, 16);
  const serverPublic = body.subarray(21, 86);
  const shared = keys.ecdh.computeSecret(serverPublic);
  const ikm = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      b64(keys.auth),
      Buffer.concat([
        Buffer.from("WebPush: info\0"),
        keys.ecdh.getPublicKey(),
        serverPublic,
      ]),
      32,
    ),
  );
  const derive = (info, length) =>
    Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(info), length));
  const record = body.subarray(86);
  const decipher = createDecipheriv(
    "aes-128-gcm",
    derive("Content-Encoding: aes128gcm\0", 16),
    derive("Content-Encoding: nonce\0", 12),
  );
  decipher.setAuthTag(record.subarray(-16));
  const plain = Buffer.concat([
    decipher.update(record.subarray(0, -16)),
    decipher.final(),
  ]);
  assert.equal(plain.at(-1), 2, "one final record");
  return JSON.parse(plain.subarray(0, -1).toString());
}

describe("web push encryption", () => {
  it("matches the worked example of RFC 8291", () => {
    const body = encryptPushPayload(
      Buffer.from("When I grow up, I want to be a watermelon"),
      {
        p256dh:
          "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        auth: "BTBZMqHH6r4Tts7J_aSIgg",
      },
      {
        salt: b64("DGv6ra1nlYgDCS1FRnbzlw"),
        serverPrivateKey: b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
      },
    );
    // Appendix A's header followed by its ciphertext.
    const header = b64(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
    );
    const ciphertext = b64(
      "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
    );
    assert.deepEqual(body, Buffer.concat([header, ciphertext]));
  });

  it("uses a fresh key and salt for every message and refuses oversized ones", () => {
    const keys = browserKeys();
    const one = encryptPushPayload(Buffer.from('{"a":1}'), keys);
    const two = encryptPushPayload(Buffer.from('{"a":1}'), keys);
    assert.notDeepEqual(one.subarray(0, 86), two.subarray(0, 86));
    assert.deepEqual(decrypt(one, keys), { a: 1 });
    assert.equal(one.readUInt32BE(16), 4096);
    assert.throws(
      () => encryptPushPayload(Buffer.alloc(3994), keys),
      /too large/,
    );
    assert.doesNotThrow(() => encryptPushPayload(Buffer.alloc(3993), keys));
  });
});

describe("VAPID keys", () => {
  it("signs a 12-hour ES256 token for the push service's origin", () => {
    const pair = vapidPair();
    const key = vapidSigningKey(pair.publicKey, pair.privateKey);
    const header = vapidAuthorization(
      "https://fcm.googleapis.com/fcm/send/abc",
      { publicKey: pair.publicKey, key, subject: "https://yaparena.com" },
      1_800_000_000_500,
    );
    const [, token, publicKey] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    assert.equal(publicKey, pair.publicKey);
    const [head, claims, signature] = token.split(".");
    assert.deepEqual(JSON.parse(b64(head).toString()), {
      typ: "JWT",
      alg: "ES256",
    });
    assert.deepEqual(JSON.parse(b64(claims).toString()), {
      aud: "https://fcm.googleapis.com",
      exp: 1_800_000_000 + 12 * 60 * 60,
      sub: "https://yaparena.com",
    });
    assert.equal(b64(signature).length, 64);
    assert.ok(
      verify(
        "sha256",
        Buffer.from(`${head}.${claims}`),
        { key: createPublicKey(key), dsaEncoding: "ieee-p1363" },
        b64(signature),
      ),
    );
  });

  it("refuses malformed keys and a private key from another pair", () => {
    const pair = vapidPair();
    assert.equal(vapidPublicKey(`${pair.publicKey}=`), pair.publicKey);
    for (const bad of ["", "abc", pair.privateKey, `B${"A".repeat(86)}`])
      assert.throws(() => vapidPublicKey(bad), /WEB_PUSH_PUBLIC_KEY/);
    assert.throws(
      () => vapidSigningKey(pair.publicKey, "short"),
      /WEB_PUSH_PRIVATE_KEY must be/,
    );
    assert.throws(
      () =>
        vapidSigningKey(pair.publicKey, Buffer.alloc(32).toString("base64url")),
      /not a valid P-256 private key/,
    );
    assert.throws(
      () => vapidSigningKey(pair.publicKey, vapidPair().privateKey),
      /does not belong to WEB_PUSH_PUBLIC_KEY/,
    );
  });
});

describe("push subscriptions from browsers", () => {
  const keys = browserKeys();
  const json = (endpoint, extra = {}) => ({
    endpoint,
    expirationTime: null,
    keys: { p256dh: keys.p256dh, auth: keys.auth, ...extra },
  });

  it("accepts the browsers' push services and normalizes the keys", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc:def",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://web.push.apple.com/QGxV9tq",
      "https://wns2-par02p.notify.windows.com/w/?token=BQYAAA%2b",
    ])
      assert.deepEqual(parsePushSubscription(json(endpoint)), {
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      });
    // Padded or standard base64 comes back in canonical base64url.
    const padded = parsePushSubscription(
      json("https://web.push.apple.com/x", {
        auth: Buffer.from("0123456789abcdef").toString("base64"),
      }),
    );
    assert.equal(padded.auth, keys.auth);
  });

  it("refuses any other address and malformed keys", () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "https://user:pass@fcm.googleapis.com/x",
      "https://example.com/push",
      "https://169.254.169.254/latest",
      "https://fcm.googleapis.com.example.com/x",
      `https://web.push.apple.com/${"a".repeat(2048)}`,
      "not a url",
      42,
    ])
      assert.equal(parsePushSubscription(json(endpoint)), null, endpoint);
    const endpoint = "https://web.push.apple.com/x";
    const offCurve = Buffer.alloc(65, 1);
    offCurve[0] = 4;
    for (const extra of [
      { p256dh: undefined },
      { p256dh: keys.p256dh.slice(1) },
      { p256dh: offCurve.toString("base64url") },
      { p256dh: "*".repeat(87) },
      { auth: "AAAA" },
      { auth: 16 },
    ])
      assert.equal(parsePushSubscription(json(endpoint, extra)), null);
    for (const value of [null, "x", { endpoint }, { endpoint, keys: null }])
      assert.equal(parsePushSubscription(value), null);
    assert.equal(pushEndpoint("https://web.push.apple.com/x"), endpoint);
  });
});

describe("sending web push", () => {
  it("classifies the push service's answers", () => {
    assert.equal(pushOutcome(201), "sent");
    assert.equal(pushOutcome(200), "sent");
    assert.equal(pushOutcome(404), "gone");
    assert.equal(pushOutcome(410), "gone");
    assert.equal(pushOutcome(429), "retry");
    assert.equal(pushOutcome(503), "retry");
    for (const status of [400, 401, 403, 413])
      assert.equal(pushOutcome(status), "refused");
  });

  it("posts an encrypted, signed message that only the browser can read", async () => {
    const pair = vapidPair();
    const keys = browserKeys();
    const requests = [];
    let cancelled = 0;
    const push = createWebPush({
      ...pair,
      subject: "https://yaparena.com",
      now: () => 1_800_000_000_000,
      fetch: async (url, options) => {
        requests.push({ url, options });
        return {
          status: 201,
          body: { cancel: async () => void cancelled++ },
        };
      },
    });
    assert.equal(push.publicKey, pair.publicKey);
    const endpoint = "https://web.push.apple.com/QGxV9tq";
    const message = { title: "Cities should ban cars", url: "/debates/cars" };
    assert.deepEqual(
      await push.send(
        { endpoint, p256dh: keys.p256dh, auth: keys.auth },
        message,
        600,
      ),
      { outcome: "sent", status: 201 },
    );
    const [{ url, options }] = requests;
    assert.equal(url, endpoint);
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.headers["Content-Encoding"], "aes128gcm");
    assert.equal(options.headers["Content-Type"], "application/octet-stream");
    assert.equal(options.headers.TTL, "600");
    assert.equal(options.headers.Urgency, "high");
    assert.match(
      options.headers.Authorization,
      new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${pair.publicKey}$`),
    );
    assert.deepEqual(decrypt(options.body, keys), message);
    assert.equal(cancelled, 1, "the answer's body is released");
  });

  it("reports gone, refused and unanswered deliveries", async () => {
    const pair = vapidPair();
    const keys = browserKeys();
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/x",
      p256dh: keys.p256dh,
      auth: keys.auth,
    };
    const answers = [
      { status: 410, body: null },
      { status: 403 },
      new Error("offline"),
    ];
    const push = createWebPush({
      ...pair,
      subject: "https://yaparena.com",
      fetch: async () => {
        const next = answers.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    });
    assert.deepEqual(await push.send(subscription, {}, 60), {
      outcome: "gone",
      status: 410,
    });
    assert.deepEqual(await push.send(subscription, {}, 60), {
      outcome: "refused",
      status: 403,
    });
    assert.deepEqual(await push.send(subscription, {}, 60), {
      outcome: "retry",
    });
    assert.throws(() =>
      createWebPush({
        ...pair,
        privateKey: vapidPair().privateKey,
        subject: "x",
      }),
    );
  });
});

describe("web push settings", () => {
  const databaseUrl = "postgresql://user:password@localhost:5432/database";
  const pair = vapidPair();
  const load = (env, service) =>
    loadConfig({ DATABASE_URL: databaseUrl, ...env }, { service });
  const origin = { APP_ORIGIN: "https://staging.example.com" };

  it("stays off without the public key, so a version deploys before the keys exist", () => {
    for (const service of ["web", "jobs"])
      assert.equal(load({ ...origin }, service).webPush, undefined);
    assert.throws(
      () => load({ WEB_PUSH_PRIVATE_KEY: pair.privateKey }),
      /requires WEB_PUSH_PUBLIC_KEY/,
    );
  });

  it("gives web the public key, and the jobs worker the pair and its contact", () => {
    // Staging web: RUN_BACKGROUND_JOBS=false and only the public key.
    assert.deepEqual(
      load({
        RUN_BACKGROUND_JOBS: "false",
        WEB_PUSH_PUBLIC_KEY: pair.publicKey,
      }).webPush,
      { publicKey: pair.publicKey, sender: undefined },
    );
    // A private key on a web that doesn't run the jobs is checked, then left unused.
    assert.deepEqual(
      load({
        RUN_BACKGROUND_JOBS: "false",
        WEB_PUSH_PUBLIC_KEY: pair.publicKey,
        WEB_PUSH_PRIVATE_KEY: pair.privateKey,
      }).webPush,
      { publicKey: pair.publicKey, sender: undefined },
    );
    const jobs = load(
      {
        ...origin,
        WEB_PUSH_PUBLIC_KEY: pair.publicKey,
        WEB_PUSH_PRIVATE_KEY: pair.privateKey,
      },
      "jobs",
    );
    assert.deepEqual(jobs.webPush, {
      publicKey: pair.publicKey,
      sender: {
        privateKey: pair.privateKey,
        subject: "https://staging.example.com",
      },
    });
    assert.deepEqual(jobs.unusedSecrets, []);
    // Web that runs the jobs itself (local development, or a rollback) sends too.
    assert.equal(
      load({
        ...origin,
        WEB_PUSH_PUBLIC_KEY: pair.publicKey,
        WEB_PUSH_PRIVATE_KEY: pair.privateKey,
      }).webPush.sender.subject,
      "https://staging.example.com",
    );
    // Without the private key, web running the jobs keeps push to the in-app notice.
    assert.equal(
      load({ WEB_PUSH_PUBLIC_KEY: pair.publicKey }).webPush.sender,
      undefined,
    );
  });

  it("stops a deploy with a half-set, mismatched or contactless pair", () => {
    assert.throws(
      () => load({ ...origin, WEB_PUSH_PUBLIC_KEY: pair.publicKey }, "jobs"),
      /set WEB_PUSH_PUBLIC_KEY and WEB_PUSH_PRIVATE_KEY together/,
    );
    assert.throws(
      () =>
        load({
          WEB_PUSH_PUBLIC_KEY: pair.publicKey,
          WEB_PUSH_PRIVATE_KEY: vapidPair().privateKey,
          RUN_BACKGROUND_JOBS: "false",
        }),
      /does not belong/,
    );
    assert.throws(
      () => load({ WEB_PUSH_PUBLIC_KEY: "not-a-key" }),
      /WEB_PUSH_PUBLIC_KEY must be/,
    );
    for (const APP_ORIGIN of [undefined, "ftp://example.com", "nonsense"])
      assert.throws(
        () =>
          load(
            {
              APP_ORIGIN,
              WEB_PUSH_PUBLIC_KEY: pair.publicKey,
              WEB_PUSH_PRIVATE_KEY: pair.privateKey,
            },
            "jobs",
          ),
        /requires APP_ORIGIN/,
      );
  });

  it("names the private key as unused on the encoder", () => {
    const encoder = loadConfig(
      {
        DATABASE_URL: databaseUrl,
        MEDIA_REPLAY_PACKAGING_ENABLED: "true",
        MEDIA_S3_REGION: "auto",
        MEDIA_S3_BUCKET: "bucket",
        MEDIA_S3_ACCESS_KEY: "key",
        MEDIA_S3_SECRET_KEY: "secret",
        WEB_PUSH_PUBLIC_KEY: pair.publicKey,
        WEB_PUSH_PRIVATE_KEY: pair.privateKey,
      },
      { service: "encoder" },
    );
    assert.equal(encoder.webPush, undefined);
    assert.deepEqual(encoder.unusedSecrets, ["WEB_PUSH_PRIVATE_KEY"]);
  });
});

describe("installed app", () => {
  it("opens from the Home Screen as a standalone app, which iPhone push requires", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../public/manifest.webmanifest", import.meta.url)),
    );
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.start_url, "/");
    assert.equal(manifest.id, "/");
  });
});

describe("key generator", () => {
  it("prints a fresh pair that the settings accept", () => {
    const output = execFileSync(
      process.execPath,
      [
        new URL("../scripts/generate-web-push-keys.ts", import.meta.url)
          .pathname,
      ],
      { encoding: "utf8" },
    );
    const [, publicKey, privateKey] =
      /^WEB_PUSH_PUBLIC_KEY=([\w-]{87})\nWEB_PUSH_PRIVATE_KEY=([\w-]{43})\n$/.exec(
        output,
      );
    assert.equal(vapidPublicKey(publicKey), publicKey);
    assert.doesNotThrow(() => vapidSigningKey(publicKey, privateKey));
    const again = generateWebPushKeys();
    assert.notEqual(again.privateKey, privateKey);
    assert.doesNotThrow(() =>
      vapidSigningKey(again.publicKey, again.privateKey),
    );
  });
});
