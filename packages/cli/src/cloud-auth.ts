// `forge login` — the device authorization flow (DDR-075).
//
// The CLI never handles a credential the user typed: it asks Cloud for a code
// pair, shows the short one, and polls until a browser session approves it.
// What comes back is a token scoped to one machine, revocable on its own.

import { readUserConfig, writeUserConfig } from "./config.js";

/**
 * The control plane — accounts, plans, device authorization (DDR-078). Not the
 * review runtime: that is `frozen.design`, a separate origin because it serves
 * user-authored JavaScript and must never sit beside a logged-in session.
 */
export const DEFAULT_CLOUD_API_URL = "https://useforge.design";

/**
 * Forge Cloud is not open for sign-up yet (DDR-137), and the open-source CLI
 * must work in full without it. Every Cloud command sits under this heading in
 * `--help`, and every refusal for want of an account says the same thing, so
 * nobody is sent to sign up for something they cannot get.
 */
export const CLOUD_HELP_GROUP = "Forge Cloud (closed beta, invited accounts only):";

export const NOT_SIGNED_IN =
  "this needs Forge Cloud, which is in closed beta for invited accounts — run `forge login` if you have one";

export interface DeviceCodeGrant {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  /** seconds */
  expiresIn: number;
  /** seconds between polls */
  interval: number;
}

export type PollOutcome =
  | { status: "pending" }
  | { status: "approved"; token: string; user: { email: string; plan: string } | null }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "unknown" };

export async function cloudApiUrl(): Promise<string> {
  const configured = (await readUserConfig()).cloudApiUrl;
  return (configured ?? DEFAULT_CLOUD_API_URL).replace(/\/$/, "");
}

function url(base: string, path: string): string {
  return `${base.replace(/\/$/, "")}${path}`;
}

export async function requestDeviceCode(base: string): Promise<DeviceCodeGrant> {
  const res = await fetch(url(base, "/api/cli/device"), { method: "POST" });
  if (!res.ok) {
    throw new Error(`could not start sign-in (${res.status}) — is ${base} the right Cloud URL?`);
  }
  return (await res.json()) as DeviceCodeGrant;
}

export async function pollForToken(base: string, deviceCode: string): Promise<PollOutcome> {
  const res = await fetch(url(base, "/api/cli/token"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceCode }),
  });
  // Every terminal state carries its own status in the body; a transport-level
  // failure is the only thing that should throw.
  // Typed as the wire shape, not as PollOutcome: the service also answers
  // "claimed", which is a state the CLI folds into "expired" rather than one it
  // ever needs to name.
  const body = (await res.json().catch(() => ({}))) as {
    status?: string;
    token?: string;
    user?: { email: string; plan: string } | null;
  };
  switch (body.status) {
    case "approved":
      return body.token
        ? { status: "approved", token: body.token, user: body.user ?? null }
        : { status: "unknown" };
    case "denied":
      return { status: "denied" };
    case "expired":
    case "claimed":
      return { status: "expired" };
    case "pending":
      return { status: "pending" };
    default:
      return { status: "unknown" };
  }
}

export interface CloudIdentity {
  email: string;
  plan: string;
}

/** Who this machine publishes as, or null when it is not signed in. */
export async function whoami(): Promise<CloudIdentity | null> {
  const config = await readUserConfig();
  if (!config.cloudToken) return null;
  const base = await cloudApiUrl();
  const res = await fetch(url(base, "/api/cli/me"), {
    headers: { Authorization: `Bearer ${config.cloudToken}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as CloudIdentity;
}

export async function storeToken(token: string, base: string): Promise<void> {
  await writeUserConfig({ cloudToken: token, cloudApiUrl: base });
}

export async function clearToken(): Promise<void> {
  await writeUserConfig({ cloudToken: undefined });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls until the browser answers, the code expires, or `deadline` passes.
 * `onTick` exists so the command can show that something is still happening —
 * a silent terminal during a browser round-trip reads as a hang.
 */
export async function awaitApproval(
  base: string,
  grant: DeviceCodeGrant,
  options: { now?: () => number; onTick?: () => void } = {},
): Promise<PollOutcome> {
  const now = options.now ?? Date.now;
  const deadline = now() + grant.expiresIn * 1000;
  while (now() < deadline) {
    await sleep(grant.interval * 1000);
    options.onTick?.();
    const outcome = await pollForToken(base, grant.deviceCode);
    if (outcome.status !== "pending") return outcome;
  }
  return { status: "expired" };
}
