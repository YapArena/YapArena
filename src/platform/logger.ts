import { randomUUID } from "node:crypto";
import * as dns from "node:dns";
import { fileURLToPath } from "node:url";
import { getSystemErrorMap } from "node:util";

import pino from "pino";
import { pinoHttp } from "pino-http";
import type { DestinationStream, Logger } from "pino";

import { OperatorError } from "./operator-error.ts";

// F01: messages, stack headers, causes and provider properties can all contain
// credentials, so a logged error never keeps its text. It keeps only values
// whose shape no credential has: the class, a recognised code, an HTTP status
// and stack frames (function and file:line), then the same for its causes.
// The one exception is an OperatorError, whose message is written in code.
export interface SafeError {
  redacted: true;
  type?: string;
  message?: string;
  name?: string;
  code?: string;
  status?: number;
  frames?: string[];
  cause?: SafeError;
  errors?: SafeError[];
}

const maxFrames = 10;
const maxCauses = 3;
const maxAggregated = 3;

// libuv and DNS codes (ECONNREFUSED, EAI_AGAIN, ENOTFOUND), listed exactly.
const systemCodes = new Set<string>([
  ...[...getSystemErrorMap().values()].map(([name]) => name),
  ...Object.values<unknown>(dns).filter(
    (value): value is string =>
      typeof value === "string" && /^E[A-Z]+$/.test(value),
  ),
]);
// SQLSTATE (57014) and constant-style library codes with at least one
// underscore (ERR_INVALID_ARG_TYPE, UND_ERR_CONNECT_TIMEOUT).
const sqlState = /^[0-9A-Z]{5}$/;
const constantCode = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,8}$/;
const className = /^[A-Za-z_$][\w$]{0,63}$/;
// Capitalised words only (AbortError, NoSuchKey). Tokens have digits,
// symbols or capitals in a row.
const wordName = /^(?:[A-Z][a-z]{1,20}){1,6}$/;

// Frames are reported relative to the repository root; V8 writes ES module
// locations as file URLs and CommonJS ones as paths.
const rootUrl = new URL("../../", import.meta.url).href;
const rootPath = fileURLToPath(rootUrl);
const location = String.raw`((?:file:\/\/\/|\/|node:)[^\s()?#]{1,500})(?:[?#][^\s()]*)?:(\d{1,7}):\d{1,7}`;
const namedFrame = new RegExp(
  String.raw`^ {4}at ([\w$.<>[\] ]{1,200}) \(${location}\)$`,
);
const bareFrame = new RegExp(String.raw`^ {4}at ${location}$`);

function codeLocation(path: string, line: string) {
  if (path.startsWith("node:")) return `${path}:${line}`;
  if (path.startsWith(rootUrl)) return `${path.slice(rootUrl.length)}:${line}`;
  if (path.startsWith(rootPath))
    return `${path.slice(rootPath.length)}:${line}`;
  return undefined;
}

function frame(line: string) {
  if (line.length > 1000) return undefined;
  const named = namedFrame.exec(line);
  if (named) {
    const place = codeLocation(named[2]!, named[3]!);
    return place ? `${named[1]} (${place})` : "[external]";
  }
  const bare = bareFrame.exec(line);
  return bare ? (codeLocation(bare[1]!, bare[2]!) ?? "[external]") : undefined;
}

function stackFrames(error: object) {
  const stack: unknown = Reflect.get(error, "stack");
  const message: unknown = Reflect.get(error, "message");
  if (typeof stack !== "string" || typeof message !== "string")
    return undefined;
  // V8 opens the stack with "name: message", written with the message current
  // when the stack is first read. A message can span lines, so frames are read
  // only after it; a stack that no longer contains its message (a rewritten
  // message or a replaced stack) keeps no frames. Frames are then the trailing
  // lines that start with "    at " and match a frame exactly.
  const at = message ? stack.indexOf(message) : stack.indexOf("\n");
  if (at === -1) return undefined;
  const lines = stack.slice(at + message.length).split("\n");
  let start = lines.length;
  while (start > 0 && lines[start - 1]?.startsWith("    at ")) start--;
  const frames: string[] = [];
  for (const line of lines.slice(start)) {
    const parsed = frame(line);
    if (parsed) frames.push(parsed);
    if (frames.length === maxFrames) break;
  }
  return frames.length ? frames : undefined;
}

function code(value: unknown) {
  return typeof value === "string" &&
    value.length <= 64 &&
    (sqlState.test(value) || systemCodes.has(value) || constantCode.test(value))
    ? value
    : undefined;
}

function status(error: object) {
  const metadata: unknown = Reflect.get(error, "$metadata");
  for (const value of [
    Reflect.get(error, "status"),
    Reflect.get(error, "statusCode"),
    metadata && typeof metadata === "object"
      ? Reflect.get(metadata, "httpStatusCode")
      : undefined,
  ] as unknown[])
    if (Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 599)
      return Number(value);
  return undefined;
}

export function serializeError(value: unknown, depth = 0): SafeError {
  const summary: SafeError = { redacted: true };
  try {
    if (typeof value !== "object" && typeof value !== "function") {
      summary.type = typeof value;
      return summary;
    }
    if (value === null) {
      summary.type = "null";
      return summary;
    }
    // The constructor's name comes from code; an instance's own properties
    // (name, code, message) can come from data.
    const prototype: unknown = Object.getPrototypeOf(value);
    const constructor: unknown =
      prototype && typeof prototype === "object"
        ? Reflect.get(prototype, "constructor")
        : undefined;
    if (typeof constructor === "function" && className.test(constructor.name))
      summary.type = constructor.name;
    if (value instanceof OperatorError) summary.message = value.message;
    const name: unknown = Reflect.get(value, "name");
    if (
      typeof name === "string" &&
      name !== summary.type &&
      name !== "Error" &&
      wordName.test(name)
    )
      summary.name = name;
    summary.code = code(Reflect.get(value, "code"));
    summary.status = status(value);
    summary.frames = stackFrames(value);
    if (depth < maxCauses) {
      const cause: unknown = Reflect.get(value, "cause");
      if (cause !== undefined) summary.cause = serializeError(cause, depth + 1);
      const errors: unknown = Reflect.get(value, "errors");
      if (Array.isArray(errors) && errors.length)
        summary.errors = errors
          .slice(0, maxAggregated)
          .map((error: unknown) => serializeError(error, depth + 1));
    }
  } catch {
    // A throwing getter or proxy trap keeps what was already gathered.
  }
  return summary;
}

export function createLogger({
  level = "info",
  enabled = true,
  destination,
}: {
  level?: string;
  enabled?: boolean;
  destination?: DestinationStream;
} = {}) {
  return pino(
    {
      level,
      enabled,
      serializers: {
        err: serializeError,
        error: serializeError,
        permissionError: serializeError,
        pauseError: serializeError,
        stopError: serializeError,
      },
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          'req.headers["x-yap-signature"]',
          'req.headers["x-yaparena-expected-account"]',
          'req.headers["x-yaparena-session"]',
          'res.headers["set-cookie"]',
          // Sign-in redirects carry state, nonce and PKCE challenges.
          "res.headers.location",
        ],
        censor: "[REDACTED]",
      },
    },
    destination,
  );
}

export function createHttpLogger(logger: Logger) {
  return pinoHttp({
    logger,
    // Honor the parent's safe err serializer; pino-http otherwise replaces it.
    wrapSerializers: false,
    serializers: {
      req(request) {
        const record = pino.stdSerializers.req(request);
        // Sign-in routes carry one-use codes, state and return paths. Keep the
        // route useful for operations without persisting query values.
        if (
          /^\/account(?:[/?]|$)/.test(record.url ?? "") ||
          /^\/api\/auth\/(?:login|callback|confirm)(?:[/?]|$)/.test(
            record.url ?? "",
          )
        ) {
          record.url = record.url.replace(/\?.*$/, "");
          record.query = {};
        }
        return record;
      },
      res: pino.stdSerializers.res,
    },
    quietReqLogger: true,
    autoLogging: {
      ignore(request) {
        return (
          request.url === "/health" ||
          request.url === "/ready" ||
          request.url === "/ready/jobs" ||
          request.url === "/metrics" ||
          /^\/api\/community\/events\/[^/]+\/(?:stream|chat\/submissions)(?:\?|$)/.test(
            request.url ?? "",
          )
        );
      },
    },
    genReqId(request, response) {
      const incomingId = request.headers["x-request-id"];
      const requestId = Array.isArray(incomingId)
        ? (incomingId[0] ?? randomUUID())
        : incomingId || randomUUID();

      response.setHeader("X-Request-Id", requestId);
      return requestId;
    },
    customLogLevel(_request, response, error) {
      if (error || response.statusCode >= 500) return "error";
      if (response.statusCode >= 400) return "warn";
      return "info";
    },
  });
}
