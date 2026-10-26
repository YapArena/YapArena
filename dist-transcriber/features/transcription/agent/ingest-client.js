import { setTimeout as delay } from "node:timers/promises";
import { ingestHeaders, signIngest, } from "../protocol.js";
export function createIngestClient({ origin, secret, debateId, fetch: send = fetch, now = Date.now, wait = (ms) => delay(ms), attempts = 3, timeoutMs = 5000, }) {
    async function post(path, value) {
        const body = JSON.stringify(value);
        const url = new URL(`/api/internal/transcription/debates/${debateId}/${path}`, origin);
        let failure;
        for (let attempt = 0; attempt < attempts; attempt++) {
            if (attempt)
                await wait(250 * 2 ** attempt);
            const timestamp = String(now());
            try {
                const response = await send(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        [ingestHeaders.timestamp]: timestamp,
                        [ingestHeaders.signature]: signIngest(secret, timestamp, body),
                    },
                    body,
                    signal: AbortSignal.timeout(timeoutMs),
                });
                if (response.status >= 500) {
                    failure = new Error(`ingest answered ${response.status}`);
                    continue;
                }
                let parsed = {};
                try {
                    parsed = (await response.json());
                }
                catch {
                    // An empty or invalid body still reports its status.
                }
                return { status: response.status, body: parsed };
            }
            catch (error) {
                failure = error;
            }
        }
        throw failure;
    }
    return Object.freeze({
        async session(jobId) {
            const answer = await post("session", { jobId });
            return answer.status === 200
                ? answer.body
                : null;
        },
        update(update) {
            return post("updates", update);
        },
        /** The window cleanup; the server accepts one per window. */
        cleanup(cleanup) {
            return post("cleanup", cleanup);
        },
    });
}
