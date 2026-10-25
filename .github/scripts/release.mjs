#!/usr/bin/env node
/**
 * What the release workflow (.github/workflows/release.yml) asks of the
 * repository, in one place so it runs the same on a laptop. Plain Node, no
 * dependencies.
 *
 *   node .github/scripts/release.mjs version [--tag v<version>]
 *       package.json's version. Fails when package-lock.json states another,
 *       or when --tag names another version.
 *   node .github/scripts/release.mjs package [--repository <owner/name>]
 *       Fails, naming each problem, when the package cannot be published to
 *       npmjs with provenance from this repository: it is private, its
 *       publishConfig names another registry or no public access, its licence
 *       is not Apache-2.0, its files leave out LICENSE or NOTICE, or its
 *       repository is another.
 *   node .github/scripts/release.mjs notes <version>
 *       The CHANGELOG.md section of that version ("## [<version>] — <date>"),
 *       for the GitHub release. Fails when it is missing, undated or empty.
 *   node .github/scripts/release.mjs dist-tag <version>
 *       "latest" for a release, "next" for a prerelease (1.2.0-rc.1).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NPMJS = /^https:\/\/registry\.npmjs\.org\/?$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const readJson = (file) => JSON.parse(readFileSync(join(ROOT, file), "utf8"));
const fail = (lines) => {
  for (const l of [].concat(lines)) process.stderr.write(`release: ${l}\n`);
  process.exit(1);
};
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

function version() {
  const pkg = readJson("package.json");
  const v = pkg.version;
  if (!SEMVER.test(v ?? "")) fail(`package.json: version ${JSON.stringify(v)} is not a semantic version (major.minor.patch, with an optional -prerelease)`);
  if (existsSync(join(ROOT, "package-lock.json"))) {
    const lock = readJson("package-lock.json");
    const locked = [lock.version, lock.packages?.[""]?.version].filter((x) => x !== undefined);
    const other = locked.find((x) => x !== v);
    if (other) fail(`package-lock.json states version ${other}, package.json ${v}: run "npm install --package-lock-only"`);
  }
  const tag = arg("--tag");
  if (tag !== undefined && tag !== `v${v}`) fail(`the tag ${tag} is not v${v}, the version in package.json. Tag the commit that sets the version, as v${v}.`);
  return v;
}

function packageProblems() {
  const pkg = readJson("package.json");
  const repository = arg("--repository") ?? process.env.GITHUB_REPOSITORY;
  const where = `${pkg.name} (package.json)`;
  const problems = [];
  if (pkg.private) problems.push(`${where} is "private": true; npm refuses to publish it`);
  const registry = pkg.publishConfig?.registry;
  if (registry && !NPMJS.test(registry)) problems.push(`${where} has publishConfig.registry ${registry}; remove it (or name https://registry.npmjs.org/)`);
  if (pkg.publishConfig?.access !== "public") problems.push(`${where} needs publishConfig.access "public" (a scoped package is otherwise published restricted)`);
  if (pkg.license !== "Apache-2.0") problems.push(`${where} has license ${JSON.stringify(pkg.license)}, not "Apache-2.0"`);
  for (const f of ["LICENSE", "NOTICE"]) {
    if (!(pkg.files ?? []).includes(f)) problems.push(`${where} does not list ${f} in files`);
    if (!existsSync(join(ROOT, f))) problems.push(`${f} is missing`);
  }
  if (repository) {
    // npm checks a provenance statement against the package's repository: they must name this repository
    const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    const want = `https://github.com/${repository}`;
    const got = (url ?? "").replace(/^git\+/, "").replace(/\.git$/, "");
    if (got.toLowerCase() !== want.toLowerCase()) problems.push(`${where} has repository ${url ?? "(none)"}; provenance needs git+${want}.git`);
  }
  if (problems.length) fail([`${problems.length} problem(s) stop the npm publish:`, ...problems.map((p) => `  - ${p}`)]);
  return `${pkg.name}@${pkg.version} can be published to npmjs${repository ? ` from ${repository}` : ""}`;
}

/** The changelog's section of `v`: its heading line and its text, up to the next "## ". */
function section(text, v) {
  const lines = text.split(/\r?\n/);
  const esc = v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^## \\[?v?${esc}\\]?(?:\\s|$)`);
  const at = lines.findIndex((l) => head.test(l));
  if (at < 0) return undefined;
  const end = lines.findIndex((l, i) => i > at && /^## /.test(l));
  return { heading: lines[at], body: lines.slice(at + 1, end < 0 ? undefined : end).join("\n").trim() };
}

function notes(v) {
  if (!v) fail("usage: release.mjs notes <version>");
  const file = join(ROOT, "CHANGELOG.md");
  if (!existsSync(file)) fail("CHANGELOG.md is missing");
  const s = section(readFileSync(file, "utf8"), v);
  if (!s) fail(`CHANGELOG.md has no "## [${v}] — YYYY-MM-DD" section: write the release's notes there first`);
  if (!/\d{4}-\d{2}-\d{2}\s*$/.test(s.heading)) fail(`CHANGELOG.md: the heading of ${v} needs the release date, as "## [${v}] — YYYY-MM-DD"`);
  if (!s.body.split(/\r?\n/).some((l) => l.trim() && !/^#{3,} /.test(l))) fail(`CHANGELOG.md: the section of ${v} is empty. A release says what changed.`);
  return s.body;
}

const [cmd, value] = process.argv.slice(2);
switch (cmd) {
  case "version":
    console.log(version());
    break;
  case "package":
    console.log(packageProblems());
    break;
  case "notes":
    console.log(notes(value));
    break;
  case "dist-tag":
    if (!value) fail("usage: release.mjs dist-tag <version>");
    console.log(value.includes("-") ? "next" : "latest");
    break;
  default:
    fail("usage: release.mjs version [--tag v<version>] | package [--repository <owner/name>] | notes <version> | dist-tag <version>");
}
