import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentPackages,
  runtimeDirectories,
  runtimeQuery,
} from "../scripts/transcriber-runtime-modules.ts";

// Decision 0012: the transcriber image copies only the agent's runtime
// packages and their dependencies.

describe("transcriber runtime packages", () => {
  it("selects the agent's packages and their whole dependency tree", () => {
    assert.equal(
      runtimeQuery(["a", "@b/c"]),
      ":is(#a, #@b/c), :is(#a, #@b/c) *",
    );
    assert.ok(agentPackages.includes("@livekit/agents"));
    assert.ok(agentPackages.includes("@anthropic-ai/sdk"));
  });

  it("copies each package once, without directories nested in another", () => {
    assert.deepEqual(
      runtimeDirectories([
        { location: "node_modules/@livekit/agents" },
        { location: "node_modules/@livekit/agents/node_modules/ws" },
        { location: "node_modules/zod" },
        { location: "node_modules/zod" },
        { location: "node_modules/zod-to-json-schema" },
        { location: "" },
        { location: 3 },
        {},
      ]),
      [
        "node_modules/@livekit/agents",
        "node_modules/zod",
        "node_modules/zod-to-json-schema",
      ],
    );
  });
});
