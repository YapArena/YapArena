import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, it } from "node:test";
import supertest from "supertest";
import request from "../scripts/test-http-request.ts";

const servers = [];
async function listen(server, options) {
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options, resolve);
  });
  return server;
}
after(async () => {
  for (const server of servers) {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
});

it("uses its IPv6 fixture when a different IPv4 service occupies the same port", async () => {
  const other = await listen(
    createServer((_req, res) => {
      res.writeHead(401).end("different IPv4 service");
    }),
    { port: 0, host: "127.0.0.1" },
  );
  const owned = await listen(
    createServer((req, res) => {
      if (req.url === "/cookie") {
        res.setHeader("Set-Cookie", "session=synthetic; Path=/");
        res.end("cookie set");
      } else {
        res.writeHead(req.headers.cookie === "session=synthetic" ? 200 : 403);
        res.end("owned IPv6 fixture");
      }
    }),
    { port: other.address().port, host: "::1", ipv6Only: true },
  );
  // Supertest 7.3 connects to the listener's own address, so plain supertest now
  // reaches the IPv6 fixture too (403 without the cookie). Earlier versions reached
  // the IPv4 service (401), which is why the adapter remains.
  assert.equal((await supertest(owned).get("/")).status, 403);
  const response = await request(owned)
    .get("/")
    .set("Cookie", "session=synthetic");
  assert.equal(response.status, 200);
  assert.equal(response.text, "owned IPv6 fixture");
  const agent = request.agent(owned);
  assert.equal((await agent.get("/cookie")).status, 200);
  assert.equal((await agent.get("/")).status, 200);
});
