#!/usr/bin/env node
/**
 *   uhd-viewer serve <bundle.json> [--port 5179] [--host 127.0.0.1] [--open]
 *
 * Serves the built viewer with one UHD bundle and its artifacts (bin/serve.mjs).
 */
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { DEFAULT_PORT, startServer } from "./serve.mjs";

const USAGE = `usage: uhd-viewer serve <bundle.json> [--port ${DEFAULT_PORT}] [--host 127.0.0.1] [--open]

Serves the viewer, the bundle and the artifact files it references.
  --port   port to listen on (0: any free port)
  --host   address to bind; anything but a loopback address exposes the files to the network
  --open   open the viewer in the default browser`;

/** The platform's "open this URL" command. */
function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => console.error(`could not open a browser: open ${url} yourself`));
  child.unref();
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        port: { type: "string" },
        host: { type: "string" },
        open: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : e}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, bundleFile, ...extra] = positionals;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (command !== "serve" || !bundleFile || extra.length) {
    console.error(USAGE);
    return 2;
  }
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`--port must be a port number, not ${values.port}`);
    return 2;
  }
  try {
    const { url } = await startServer({ bundleFile, port, host: values.host });
    console.log(`uhd-viewer: serving ${bundleFile} at ${url}`);
    if (values.open) openBrowser(url);
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    console.error(`uhd-viewer: ${err.code === "EADDRINUSE" ? `port ${port} is in use (try --port 0)` : err.code === "ENOENT" ? `no such file ${err.path}` : err.message}`);
    return 1;
  }
  return undefined;
}

const code = await main();
if (code !== undefined) process.exitCode = code;
