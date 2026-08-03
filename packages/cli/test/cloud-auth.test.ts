import { promises as fs } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { awaitApproval, pollForToken, whoami } from "../src/cloud-auth.js";

// The device authorization flow as the CLI sees it (DDR-075). A real HTTP
// server rather than a mocked fetch: the states that matter are the ones the
// service signals with a status code plus a body, and stubbing fetch would let
// the CLI agree with a service that does not exist.

let server: http.Server;
let base: string;
let sandbox: string;
let respond: (url: string) => { code: number; body: unknown };
const savedHome = process.env.FORGE_HOME;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-cloud-auth-"));
  process.env.FORGE_HOME = sandbox;
  respond = () => ({ code: 200, body: { status: "pending" } });
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c: string) => (raw += c));
    req.on("end", () => {
      const { code, body } = respond(req.url ?? "");
      res.statusCode = code;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await fs.rm(sandbox, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = savedHome;
});

const grant = {
  deviceCode: "dc",
  userCode: "ABCD-2468",
  verificationUri: "",
  expiresIn: 1,
  interval: 0,
};

describe("pollForToken", () => {
  it("reads an approval and the identity behind it", async () => {
    respond = () => ({
      code: 200,
      body: { status: "approved", token: "tok", user: { email: "a@b.c", plan: "free" } },
    });
    expect(await pollForToken(base, "dc")).toEqual({
      status: "approved",
      token: "tok",
      user: { email: "a@b.c", plan: "free" },
    });
  });

  it("refuses an approval with no token rather than storing an empty one", async () => {
    // A service that says yes and sends nothing is broken, not authorised —
    // storing "" would leave a machine that looks signed in and is not.
    respond = () => ({ code: 200, body: { status: "approved" } });
    expect(await pollForToken(base, "dc")).toEqual({ status: "unknown" });
  });

  it("folds `claimed` into expired — the CLI has no use for the distinction", async () => {
    respond = () => ({ code: 410, body: { status: "claimed" } });
    expect(await pollForToken(base, "dc")).toEqual({ status: "expired" });
  });

  it("reports a denial rather than waiting for a decision already made", async () => {
    respond = () => ({ code: 403, body: { status: "denied" } });
    expect(await pollForToken(base, "dc")).toEqual({ status: "denied" });
  });
});

describe("awaitApproval", () => {
  it("stops polling the moment the browser answers", async () => {
    let calls = 0;
    respond = () => {
      calls += 1;
      return calls < 2
        ? { code: 200, body: { status: "pending" } }
        : { code: 200, body: { status: "approved", token: "tok", user: null } };
    };
    const outcome = await awaitApproval(base, grant as never);
    expect(outcome).toEqual({ status: "approved", token: "tok", user: null });
    expect(calls).toBe(2);
  });

  it("gives up when the code's lifetime runs out, rather than polling forever", async () => {
    let now = 0;
    respond = () => ({ code: 200, body: { status: "pending" } });
    const outcome = await awaitApproval(base, grant as never, {
      now: () => {
        now += 600;
        return now;
      },
    });
    expect(outcome).toEqual({ status: "expired" });
  });
});

describe("whoami", () => {
  it("is null with no stored token, without calling anything", async () => {
    expect(await whoami()).toBeNull();
  });

  it("is null when the service rejects the token — a stale one is not an identity", async () => {
    await fs.writeFile(
      path.join(sandbox, "config.json"),
      JSON.stringify({ cloudApiUrl: base, cloudToken: "stale" }),
      "utf8",
    );
    respond = () => ({ code: 401, body: { error: "unauthorized" } });
    expect(await whoami()).toBeNull();
  });

  it("returns the account and plan the machine publishes to", async () => {
    await fs.writeFile(
      path.join(sandbox, "config.json"),
      JSON.stringify({ cloudApiUrl: base, cloudToken: "good" }),
      "utf8",
    );
    respond = () => ({ code: 200, body: { email: "a@b.c", plan: "pro" } });
    expect(await whoami()).toEqual({ email: "a@b.c", plan: "pro" });
  });
});
