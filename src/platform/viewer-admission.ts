import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler } from "express";
import { ipKeyGenerator } from "express-rate-limit";

type Lane = "read" | "grant" | "report" | "issue";
type Window = { expires: number; counts: Record<Lane, number> };
const cookie = "yap_media_guard";
const duration = 15 * 60_000;
const empty = (): Record<Lane, number> => ({
  read: 0,
  grant: 0,
  report: 0,
  issue: 0,
});

// Allowlisted delivery/bootstrapping reads leave the ordinary mutation/auth budget.
export function mediaDeliveryLane(
  request: Pick<Request, "method" | "path">,
): Exclude<Lane, "issue"> | undefined {
  if (
    request.method === "GET" &&
    ([
      "/",
      "/about",
      "/privacy",
      "/terms",
      "/debates",
      "/topics",
      "/people",
      "/sw.js",
      "/api/auth/me",
      "/api/me/roles",
    ].includes(request.path) ||
      /^\/(?:debates|topics|people)\/[a-z0-9][a-z0-9-]{2,79}(?:\/qr\.svg)?$/.test(
        request.path,
      ) ||
      /^\/assets\/[a-zA-Z0-9._/-]+$/.test(request.path) ||
      /^\/api\/public\/(?:debates|topics|people)(?:\/[a-z0-9][a-z0-9-]{2,79})?$/.test(
        request.path,
      ) ||
      /^\/api\/me\/follows\/(?:topics|people)\/[a-z0-9][a-z0-9-]{2,79}$/.test(
        request.path,
      ) ||
      /^\/api\/community\/events\/[0-9a-f-]{36}(?:\/(?:updates|my-like|chat(?:\/(?:sync|submissions))?))?$/i.test(
        request.path,
      ) ||
      /^\/api\/media\/events\/[0-9a-f-]{36}(?:\/(?:replay|captions\.vtt|speaker-seat))?$/i.test(
        request.path,
      ))
  )
    return "read";
  if (
    request.method === "POST" &&
    /^\/api\/media\/events\/[0-9a-f-]{36}\/viewer-token$/i.test(request.path)
  )
    return "grant";
  if (
    request.method === "POST" &&
    /^\/api\/media\/events\/[0-9a-f-]{36}\/playback$/i.test(request.path)
  )
    return "report";
  return undefined;
}

export function createViewerAdmission({
  secret = randomBytes(32).toString("hex"),
  secure = true,
  now = Date.now,
  maxViewers = 6000,
  maxNetworks = 2000,
  maxInFlight = 128,
  refused = (_reason: "viewer" | "network" | "process" | "capacity") => {
    void _reason;
  },
}: {
  secret?: string;
  secure?: boolean;
  now?: () => number;
  maxViewers?: number;
  maxNetworks?: number;
  maxInFlight?: number;
  refused?: (reason: "viewer" | "network" | "process" | "capacity") => void;
} = {}) {
  const viewers = new Map<string, Window>();
  const networks = new Map<string, Window>();
  const prunedAt = new WeakMap<Map<string, Window>, number>();
  let processWindow: Window = { expires: 0, counts: empty() };
  let inFlight = 0;
  const limits = {
    viewer: { read: 90, grant: 8, report: 30, issue: 1 },
    browser: { read: 450, grant: 40, report: 150, issue: 1 },
    network: { read: 45000, grant: 3000, report: 15000, issue: 2000 },
    process: { read: 60000, grant: 6000, report: 30000, issue: 6000 },
  };
  const sign = (value: string) =>
    createHmac("sha256", secret)
      .update(`yaparena-media-admission-v1:${value}`)
      .digest("base64url");
  function entry(
    map: Map<string, Window>,
    key: string,
    cap: number,
    time: number,
  ) {
    const old = map.get(key);
    if (old && old.expires > time) return old;
    if (!old && map.size >= cap) {
      if (time - (prunedAt.get(map) ?? 0) >= 1000) {
        prunedAt.set(map, time);
        for (const [id, value] of map)
          if (value.expires <= time) map.delete(id);
      }
      if (map.size >= cap) return undefined;
    }
    const value = { expires: time + 60_000, counts: empty() };
    map.set(key, value);
    return value;
  }
  function verify(value: string | undefined, time: number) {
    if (!value || value.length > 160) return undefined;
    const [id, expiry, signature, extra] = value.split(".");
    if (
      extra ||
      !id ||
      !/^[a-f0-9]{32}$/.test(id) ||
      !expiry ||
      !/^\d{13}$/.test(expiry) ||
      !signature ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature)
    )
      return undefined;
    if (Number(expiry) <= time || Number(expiry) > time + duration)
      return undefined;
    const actual = Buffer.from(signature);
    if (!timingSafeEqual(actual, Buffer.from(sign(`${id}.${expiry}`))))
      return undefined;
    return id;
  }
  const middleware: RequestHandler = (request, response, next) => {
    const lane = mediaDeliveryLane(request);
    if (!lane) return next();
    const time = now();
    if (inFlight >= maxInFlight) {
      refused("capacity");
      return response
        .set("Retry-After", "1")
        .status(503)
        .json({ error: "media temporarily busy; retry shortly" });
    }
    if (processWindow.expires <= time)
      processWindow = { expires: time + 60_000, counts: empty() };
    // Hash IPs only for bounded in-memory abuse controls; never emit them as labels/logs.
    const network = sign(ipKeyGenerator(request.ip ?? "unknown"));
    const peer = entry(networks, network, maxNetworks, time);
    const value = request.headers.cookie
      ?.split(";")
      .find((part) => part.trim().startsWith(`${cookie}=`))
      ?.trim()
      .slice(cookie.length + 1);
    let viewer = verify(value, time);
    let rejection: "viewer" | "network" | "process" | "capacity" | undefined;
    if (!peer) rejection = "capacity";
    else if (
      !viewer &&
      (peer.counts.issue >= limits.network.issue ||
        processWindow.counts.issue >= limits.process.issue)
    )
      rejection = "network";
    if (!rejection && !viewer) {
      viewer = randomBytes(16).toString("hex");
      const unsigned = `${viewer}.${time + duration}`;
      response.cookie(cookie, `${unsigned}.${sign(unsigned)}`, {
        httpOnly: true,
        secure,
        sameSite: "strict",
        maxAge: duration,
        path: "/",
      });
      peer!.counts.issue++;
      processWindow.counts.issue++;
    }
    const room = request.path
      .match(
        /^\/api\/(?:media|community)\/events\/([0-9a-f-]{36})(?:\/|$)/i,
      )?.[1]
      ?.toLowerCase();
    const browser = viewer
      ? entry(viewers, viewer, maxViewers, time)
      : undefined;
    const actor =
      viewer && room
        ? entry(viewers, `${viewer}:${room}`, maxViewers, time)
        : browser;
    if (!rejection) {
      if (!actor) rejection = "capacity";
      else if (!browser || browser.counts[lane] >= limits.browser[lane])
        rejection = "viewer";
      else if (actor !== browser && actor.counts[lane] >= limits.viewer[lane])
        rejection = "viewer";
      else if (peer!.counts[lane] >= limits.network[lane])
        rejection = "network";
      else if (processWindow.counts[lane] >= limits.process[lane])
        rejection = "process";
    }
    if (rejection) {
      refused(rejection);
      return response
        .set("Retry-After", "60")
        .status(rejection === "capacity" ? 503 : 429)
        .json({ error: "media request limit reached; retry shortly" });
    }
    actor!.counts[lane]++;
    if (actor !== browser) browser!.counts[lane]++;
    peer!.counts[lane]++;
    processWindow.counts[lane]++;
    inFlight++;
    let finished = false;
    const release = () => {
      if (!finished) {
        finished = true;
        inFlight--;
      }
    };
    response.once("finish", release);
    response.once("close", release);
    next();
  };
  return middleware;
}
