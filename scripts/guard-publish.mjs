#!/usr/bin/env node
// prepublishOnly guard for private ProtoBoard packages (PB-813; the same file is in protoboard-cli/scripts/registry): refuses to
// publish anywhere but a loopback registry (the local Verdaccio,
// docs/guides/local-registry.md). @protoboard/* packages are never published
// to npmjs or any other public registry.
//
// npm runs this in the package's directory. npm_config_registry holds
// publishConfig.registry, but a --registry flag on the command line still wins
// for the publish itself, so the guard also reads the command lines of the npm
// processes above it (best effort, through `ps`).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const target = process.env.npm_config_registry || pkg.publishConfig?.registry || "";
const declared = pkg.publishConfig?.registry || "";
const loopback = (url) => {
  try {
    const host = new URL(url).hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
};
/** Registries named on the command lines of the processes that started this one. */
function commandLineRegistries() {
  const found = [];
  let pid = process.ppid;
  for (let i = 0; i < 6 && pid > 1; i++) {
    let line;
    try {
      line = execFileSync("ps", ["-o", "ppid=", "-o", "args=", "-p", String(pid)], { encoding: "utf8" }).trim();
    } catch {
      break;
    }
    const m = /^(\d+)\s+(.*)$/.exec(line);
    if (!m) break;
    for (const r of m[2].matchAll(/--registry(?:=|\s+)(\S+)/g)) found.push(r[1]);
    pid = Number(m[1]);
  }
  return found;
}
const problems = [];
for (const r of commandLineRegistries()) if (!loopback(r)) problems.push(`the command line names --registry ${r}`);
if (!loopback(declared)) problems.push(`publishConfig.registry is ${declared || "unset"}; it must name the local registry`);
if (!loopback(target)) problems.push(`npm would publish to ${target || "the default registry"}`);
if (problems.length) {
  console.error(`guard-publish: refusing to publish ${pkg.name}@${pkg.version}:\n  ${problems.join("\n  ")}`);
  console.error("ProtoBoard packages are private and are published only to the local registry (docs/guides/local-registry.md).");
  process.exit(1);
}
console.error(`guard-publish: ${pkg.name}@${pkg.version} -> ${target}`);
