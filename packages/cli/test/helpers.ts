import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { initProject } from "../src/commands/init.js";

const mkdirWrite = (dir: string, file: string) =>
  `node -e "const fs=require('fs');fs.mkdirSync('${dir}',{recursive:true});fs.writeFileSync('${dir}/${file}','<html><head></head><body>ok</body></html>')"`;

/** Design repo with instant stub builds so pipeline tests don't npm-install. */
export async function makeDesignRepo(sandbox: string, name = "demo"): Promise<string> {
  const root = path.join(sandbox, name);
  await initProject(root);
  // init scaffolds the record only (DDR-050); a buildable prototype is this
  // fixture's own business.
  await fs.mkdir(path.join(root, "prototype"), { recursive: true });
  // ...including ignoring its build outputs, so a freeze leaves a clean tree.
  await fs.appendFile(
    path.join(root, ".gitignore"),
    "prototype/dist/\nprototype/storybook-static/\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "prototype/package.json"),
    JSON.stringify({
      name: `${name}-prototype`,
      private: true,
      scripts: {
        build: mkdirWrite("dist", "index.html"),
        "build-storybook": mkdirWrite("storybook-static", "index.html"),
      },
    }),
    "utf8",
  );
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("add", "-A");
  git("commit", "-m", "seed");
  return root;
}

/**
 * Installs a fake `vercel` binary into sandbox/bin and returns the PATH value
 * to use. `link` records the project name; `deploy` echoes a URL derived from
 * it, so tests can assert the link→deploy plumbing. FAKE_VERCEL_FAIL=deploy
 * makes deploys exit 1; FAKE_VERCEL_FAIL=version simulates a missing CLI.
 * Tests must always go through this fake — falling through to a real vercel
 * binary would hit the network and the user's Vercel account.
 */
export async function installFakeVercel(sandbox: string): Promise<string> {
  const bin = path.join(sandbox, "bin");
  await fs.mkdir(bin, { recursive: true });
  const script = `#!/usr/bin/env bash
cmd="$1"
cwd=""; project=""
args=("$@")
for ((i=0;i<\${#args[@]};i++)); do
  case "\${args[i]}" in
    --cwd) cwd="\${args[i+1]}";;
    --project) project="\${args[i+1]}";;
  esac
done
case "$cmd" in
  --version)
    if [ "$FAKE_VERCEL_FAIL" = "version" ]; then exit 127; fi
    echo "fake vercel 0.0.0"; exit 0;;
  link) mkdir -p "$cwd/.vercel"; echo "$project" > "$cwd/.vercel/fake-project"; exit 0;;
  deploy)
    if [ "$FAKE_VERCEL_FAIL" = "deploy" ]; then echo "boom" >&2; exit 1; fi
    echo "Inspecting deployment..." >&2
    echo "https://$(cat "$cwd/.vercel/fake-project")-abc123.vercel.app"
    exit 0;;
esac
exit 1
`;
  await fs.writeFile(path.join(bin, "vercel"), script, { mode: 0o755 });
  return `${bin}:${process.env.PATH ?? ""}`;
}
