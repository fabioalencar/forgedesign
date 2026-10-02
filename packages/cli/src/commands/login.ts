import type { Command } from "commander";
import {
  awaitApproval,
  CLOUD_HELP_GROUP,
  clearToken,
  cloudApiUrl,
  requestDeviceCode,
  storeToken,
  whoami,
} from "../cloud-auth.js";
import { readUserConfig } from "../config.js";

export function registerCloudAuthCommands(program: Command): void {
  program
    .command("login")
    .helpGroup(CLOUD_HELP_GROUP)
    .option("--url <url>", "Forge Cloud base URL (for development against a local instance)")
    .description("connect this machine to a Forge Cloud account")
    .action(async (options: { url?: string }) => {
      const base = options.url?.replace(/\/$/, "") ?? (await cloudApiUrl());

      const existing = await whoami();
      if (existing) {
        console.log(`Already signed in as ${existing.email} (${existing.plan} plan).`);
        console.log("Run `forge logout` first to connect a different account.");
        return;
      }

      let grant: Awaited<ReturnType<typeof requestDeviceCode>>;
      try {
        grant = await requestDeviceCode(base);
      } catch (error) {
        console.error(`forge login: ${(error as Error).message}`);
        process.exitCode = 1;
        return;
      }

      console.log("\nForge Cloud is in closed beta: sign-in works for invited accounts only.");
      // The code goes first and alone: it is the thing the user has to carry to
      // the browser, and burying it under a URL is how it gets mistyped.
      console.log(`\n  Your code:  ${grant.userCode}\n`);
      console.log(`  Open ${grant.verificationUriComplete ?? grant.verificationUri}`);
      console.log("  and confirm the code matches.\n");
      process.stdout.write("Waiting for approval");

      const outcome = await awaitApproval(base, grant, {
        onTick: () => process.stdout.write("."),
      });
      process.stdout.write("\n");

      switch (outcome.status) {
        case "approved": {
          await storeToken(outcome.token, base);
          const who = outcome.user ? `${outcome.user.email} (${outcome.user.plan} plan)` : "Cloud";
          console.log(`\nConnected — this machine now publishes to ${who}.`);
          return;
        }
        case "denied":
          console.error(
            "\nforge login: the request was denied in the browser. Nothing was stored.",
          );
          process.exitCode = 1;
          return;
        case "expired":
          console.error("\nforge login: that code expired before it was approved. Try again.");
          process.exitCode = 1;
          return;
        default:
          console.error("\nforge login: Forge Cloud did not recognise this sign-in. Try again.");
          process.exitCode = 1;
      }
    });

  program
    .command("logout")
    .helpGroup(CLOUD_HELP_GROUP)
    .description("disconnect this machine from Forge Cloud")
    .action(async () => {
      if (!(await readUserConfig()).cloudToken) {
        console.log("Not signed in — nothing to do.");
        return;
      }
      await clearToken();
      // Said plainly rather than implied: removing the local token stops this
      // machine using it, and the record of it stays revocable in the account.
      console.log("Disconnected. Revoke the token in your account settings to be sure.");
    });

  program
    .command("whoami")
    .helpGroup(CLOUD_HELP_GROUP)
    .description("show which Forge Cloud account this machine publishes to")
    .action(async () => {
      const identity = await whoami();
      if (!identity) {
        console.log("Not signed in to Forge Cloud (closed beta, invited accounts only).");
        console.log("Nothing else needs it: a freeze is a static build you can host anywhere.");
        return;
      }
      console.log(`${identity.email} · ${identity.plan} plan`);
    });
}
