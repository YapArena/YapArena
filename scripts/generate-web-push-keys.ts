// One-time owner command (first-run build plan PR 10): makes the VAPID key pair that signs web
// push for "Notify me". Run it once per environment, with Node.js 24 and nothing installed:
//   node scripts/generate-web-push-keys.ts
// It prints WEB_PUSH_PUBLIC_KEY and WEB_PUSH_PRIVATE_KEY lines to paste into the hosting
// dashboard (docs/staging-rollout.md, step 9). It reads nothing and stores nothing; the private
// key exists only in its output. A new pair later invalidates every saved browser subscription.
import { createECDH } from "node:crypto";
import { pathToFileURL } from "node:url";

export function generateWebPushKeys() {
  const pair = createECDH("prime256v1");
  pair.generateKeys();
  const secret = pair.getPrivateKey();
  return {
    publicKey: pair.getPublicKey().toString("base64url"),
    // Always 32 bytes (43 characters), with any leading zero bytes kept.
    privateKey: Buffer.concat([
      Buffer.alloc(32 - secret.length),
      secret,
    ]).toString("base64url"),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { publicKey, privateKey } = generateWebPushKeys();
  process.stdout.write(
    `WEB_PUSH_PUBLIC_KEY=${publicKey}\nWEB_PUSH_PRIVATE_KEY=${privateKey}\n`,
  );
}
