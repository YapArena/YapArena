import {
  ServerOptions,
  WorkerPermissions,
  cli,
  defineAgent,
  type JobContext,
} from "@livekit/agents";
import { fileURLToPath } from "node:url";
import { loadAgentConfig } from "./config.ts";
import { runDebateTranscriber } from "./session.ts";

// Decision 0012: the YapArena transcriber worker for LiveKit Cloud. It has an
// agent name, so LiveKit sends it only debates the server dispatches
// explicitly. It joins hidden and may subscribe and publish data, never tracks
// or metadata.
export default defineAgent({
  entry: async (ctx: JobContext) => {
    await runDebateTranscriber(ctx, loadAgentConfig());
  },
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadAgentConfig();
  cli.runApp(
    new ServerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: config.agentName,
      permissions: new WorkerPermissions(false, true, true, false, [], true),
      requestFunc: async (job) =>
        job.accept("YapArena transcriber", `agent-${job.id}`),
    }),
  );
}
