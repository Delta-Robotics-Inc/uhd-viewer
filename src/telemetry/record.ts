/**
 * The viewer's session record (PB-1181): what one viewer page measured, as
 * one `pb.render-session/v0` line (telemetry-headless-state.md 3.5; the
 * writer's copy of the schema, sanitiser and retention live in
 * @protoboardai/core's telemetry.ts). Pure: no DOM, no three.js, so it tests
 * in node.
 *
 * The page never knows the project's path or the user: the host that writes
 * the record (the VS Code extension, `protoboard dev`) adds the project as a
 * salted hash and the versions it knows, and sanitises every field again.
 * What the page records is numbers, GPU strings, error classes, redacted
 * error messages and stack hashes. Never source text, file names, part
 * names or anything the user typed.
 */

/** Frame-time histogram bucket edges in ms; counts has one more entry (>= the last edge). */
export const FRAME_BUCKETS = [8, 16.7, 33, 50, 100] as const;
/** A frame longer than this is a long frame (ms). */
export const LONG_FRAME_MS = 50;
/** A gap between frames longer than this is idle time (render on demand), not a frame (ms). */
export const IDLE_GAP_MS = 250;
/** Errors kept in the record (the count keeps counting). */
export const MAX_ERRORS = 5;

export type TelemetryHostKind = "vscode-webview" | "dev-web" | "vite-web" | "render-service" | "unknown";
export type SessionExit = "closed" | "hidden" | "crash" | "contextLost" | "unknown";

export interface TelemetryErrorEntry {
  kind: "error" | "unhandledrejection" | "webglcontextlost" | "other";
  name?: string;
  message?: string;
  stackHash?: string;
}

/** As core's `RenderSessionRecord` (the writer re-checks every field). */
export interface RenderSessionRecord {
  schema: "pb.render-session/v0";
  session: string;
  partial?: boolean;
  start: string;
  end: string;
  durationMs: number;
  host: TelemetryHostKind;
  versions: { viewer?: string };
  gpu?: { backend?: string; vendor?: string; renderer?: string; software?: boolean };
  viewport?: { w: number; h: number; dpr: number };
  load?: { glbs: number; glbBytes: number; loadMs?: number; fetchMs?: number; parseMs?: number; compileMs?: number; firstFrameMs?: number };
  scene?: { calls?: number; triangles?: number; points?: number; lines?: number; programs?: number; geometries?: number; textures?: number };
  frameMs?: { buckets: number[]; counts: number[]; p50?: number; p95?: number; frames: number };
  longFrames?: { count: number; maxMs?: number };
  memory?: { method: "performance.memory" | "uaSpecific" | "none"; peakBytes?: number };
  contextLost?: { lost: number; restored: number };
  errors?: { count: number; first: TelemetryErrorEntry[] };
  exit: SessionExit;
}

/** FNV-1a, 32 bit, as 8 hex characters: a stack hash the page can make synchronously (no crypto.subtle). */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * A stack as a hash: each frame reduced to its file name and position (the
 * folder and the page's origin dropped), so the same crash hashes alike on
 * every machine. Two hashes (64 bits) to keep collisions rare.
 */
export function hashStack(stack: string): string {
  const folded = stack
    .split(/\r?\n/)
    .map((l) => l.replace(/\(?(?:[a-z][a-z0-9+.-]*:\/\/[^\s()/]*)?(?:[A-Za-z]:)?[^\s()]*[\\/]([^\s()\\/]+)(:\d+:\d+)\)?/gi, "$1$2").trim())
    .filter(Boolean)
    .join("\n");
  return fnv1a(folded) + fnv1a(`~${folded}`);
}

/**
 * An error message as a record may carry it: URLs, paths, quoted strings
 * (they carry names: a part's, a file's) and long tokens replaced, at most
 * 160 characters. The writer redacts again with the project's salt.
 */
export function redactMessage(text: string, max = 160): string {
  let s = String(text);
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>()]+/gi, "<url>");
  s = s.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "<email>");
  s = s.replace(/\b[A-Za-z]:[\\/][^\s"'`<>|,;)]*/g, "<path>");
  s = s.replace(/(^|[\s(=:"'`[])(\/(?:[^\s"'`<>|,;)/]+\/)+[^\s"'`<>|,;)]*)/g, "$1<path>");
  s = s.replace(/"[^"\n]{1,200}"|'[^'\n]{1,200}'|`[^`\n]{1,200}`/g, "<str>");
  s = s.replace(/\b[A-Za-z0-9_\-+/=]{32,}\b/g, "<secret>");
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Frame times: a 1 ms histogram up to 250 ms (for p50 and p95) and the record's coarse buckets. */
export class FrameStats {
  private fine = new Uint32Array(IDLE_GAP_MS + 1);
  readonly counts = new Array<number>(FRAME_BUCKETS.length + 1).fill(0);
  frames = 0;
  long = 0;
  maxMs = 0;

  /** One frame of `ms`; a gap longer than IDLE_GAP_MS is idle time and is not counted. */
  add(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0 || ms > IDLE_GAP_MS) return;
    this.frames++;
    this.fine[Math.min(IDLE_GAP_MS, Math.floor(ms))]++;
    let b = FRAME_BUCKETS.findIndex((edge) => ms < edge);
    if (b < 0) b = FRAME_BUCKETS.length;
    this.counts[b]++;
    if (ms > LONG_FRAME_MS) this.long++;
    if (ms > this.maxMs) this.maxMs = ms;
  }

  /** A long frame seen some other way (a long-animation-frame entry), by its duration. */
  addLong(ms: number): void {
    if (!Number.isFinite(ms) || ms <= LONG_FRAME_MS) return;
    this.long++;
    if (ms > this.maxMs) this.maxMs = ms;
  }

  /** The q-th quantile (0..1) in ms, to the 1 ms bin's middle; undefined without frames. */
  quantile(q: number): number | undefined {
    if (!this.frames) return undefined;
    const target = Math.max(1, Math.ceil(q * this.frames));
    let seen = 0;
    for (let i = 0; i < this.fine.length; i++) {
      seen += this.fine[i];
      if (seen >= target) return i + 0.5;
    }
    return IDLE_GAP_MS;
  }
}

export interface GlbLoadInfo {
  bytes?: number;
  /** The whole load, when the hook gives only that (ms). */
  ms?: number;
  fetchMs?: number;
  parseMs?: number;
  compileMs?: number;
}

export interface RecorderOptions {
  host?: TelemetryHostKind;
  viewerVersion?: string;
  /** Milliseconds since an epoch (performance.now in the page); tests pass their own clock. */
  now?: () => number;
  /** Wall clock for the record's timestamps. */
  wallNow?: () => Date;
  /** A random session id. */
  id?: () => string;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** A random id: crypto.randomUUID when the page has it. */
export function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * What one viewer page measured. Hooks feed it (frames, loads, renderer
 * counts, context loss, errors); `snapshot` turns it into a record.
 */
export class SessionRecorder {
  readonly session: string;
  readonly host: TelemetryHostKind;
  readonly viewerVersion?: string;
  private readonly now: () => number;
  private readonly wallNow: () => Date;
  private readonly t0: number;
  private readonly startedAt: Date;
  readonly frames = new FrameStats();
  gpu?: RenderSessionRecord["gpu"];
  viewport?: RenderSessionRecord["viewport"];
  private load = { glbs: 0, glbBytes: 0 } as NonNullable<RenderSessionRecord["load"]>;
  private awaitingFirstFrame = false;
  private scene: NonNullable<RenderSessionRecord["scene"]> = {};
  private memory: NonNullable<RenderSessionRecord["memory"]> = { method: "none" };
  readonly context = { lost: 0, restored: 0 };
  private errorCount = 0;
  private errors: TelemetryErrorEntry[] = [];
  /** Set once the page is gone or the final record went out. */
  closed = false;

  constructor(options: RecorderOptions = {}) {
    this.now = options.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.wallNow = options.wallNow ?? (() => new Date());
    this.session = (options.id ?? randomId)();
    this.host = options.host ?? "unknown";
    this.viewerVersion = options.viewerVersion;
    this.t0 = this.now();
    this.startedAt = this.wallNow();
  }

  /** A frame took `ms` (render on demand: idle gaps are dropped by FrameStats). */
  frame(ms: number): void {
    this.frames.add(ms);
    if (this.awaitingFirstFrame) {
      this.awaitingFirstFrame = false;
      this.load.firstFrameMs = round(this.now() - this.t0);
    }
  }

  /** A model loaded: the slowest load's times are kept, bytes and counts add up. */
  glbLoaded(info: GlbLoadInfo): void {
    this.load.glbs++;
    if (info.bytes && Number.isFinite(info.bytes)) this.load.glbBytes += Math.round(info.bytes);
    const keepMax = (k: "loadMs" | "fetchMs" | "parseMs" | "compileMs", v: number | undefined) => {
      if (v !== undefined && Number.isFinite(v) && v >= 0) this.load[k] = round(Math.max(this.load[k] ?? 0, v));
    };
    keepMax("loadMs", info.ms);
    keepMax("fetchMs", info.fetchMs);
    keepMax("parseMs", info.parseMs);
    keepMax("compileMs", info.compileMs);
    if (this.load.firstFrameMs === undefined) this.awaitingFirstFrame = true;
  }

  /** `renderer.info` after a frame: the most seen in one frame is kept. */
  rendererInfo(info: { render?: { calls?: number; triangles?: number; points?: number; lines?: number }; memory?: { geometries?: number; textures?: number }; programs?: unknown[] | null }): void {
    const max = (k: keyof NonNullable<RenderSessionRecord["scene"]>, v: number | undefined) => {
      if (typeof v === "number" && Number.isFinite(v)) this.scene[k] = Math.max(this.scene[k] ?? 0, v);
    };
    max("calls", info.render?.calls);
    max("triangles", info.render?.triangles);
    max("points", info.render?.points);
    max("lines", info.render?.lines);
    max("geometries", info.memory?.geometries);
    max("textures", info.memory?.textures);
    if (Array.isArray(info.programs)) max("programs", info.programs.length);
  }

  /** Heap use where the browser tells (Chromium's `performance.memory`). */
  memorySample(bytes: number | undefined, method: "performance.memory" | "uaSpecific" = "performance.memory"): void {
    if (typeof bytes !== "number" || !Number.isFinite(bytes)) return;
    this.memory = { method, peakBytes: Math.max(this.memory.peakBytes ?? 0, Math.round(bytes)) };
  }

  contextLost(): void {
    this.context.lost++;
  }

  contextRestored(): void {
    this.context.restored++;
  }

  /** An error: its class, a redacted message, a hash of its stack. */
  error(kind: TelemetryErrorEntry["kind"], error: unknown): void {
    this.errorCount++;
    if (this.errors.length >= MAX_ERRORS) return;
    const e = error instanceof Error ? error : undefined;
    const message = e ? e.message : typeof error === "string" ? error : error === undefined ? "" : (() => {
      try {
        return JSON.stringify(error) ?? String(error);
      } catch {
        return String(error);
      }
    })();
    const name = e?.name && /^[A-Za-z_$][\w$]{0,40}$/.test(e.name) ? e.name : undefined;
    this.errors.push({
      kind,
      ...(name ? { name } : {}),
      ...(message ? { message: redactMessage(message) } : {}),
      stackHash: hashStack(e?.stack || `${name ?? kind}: ${message}`),
    });
  }

  get errorTotal(): number {
    return this.errorCount;
  }

  /** The record as of now: `partial` for a page that may still go on (hidden, an error), final otherwise. */
  snapshot(exit: SessionExit, partial: boolean): RenderSessionRecord {
    const end = this.wallNow();
    const f = this.frames;
    const p50 = f.quantile(0.5);
    const p95 = f.quantile(0.95);
    return {
      schema: "pb.render-session/v0",
      session: this.session,
      ...(partial ? { partial: true } : {}),
      start: this.startedAt.toISOString(),
      end: end.toISOString(),
      durationMs: Math.max(0, Math.round(end.getTime() - this.startedAt.getTime())),
      host: this.host,
      versions: this.viewerVersion ? { viewer: this.viewerVersion } : {},
      ...(this.gpu ? { gpu: { ...this.gpu } } : {}),
      ...(this.viewport ? { viewport: { ...this.viewport } } : {}),
      ...(this.load.glbs || this.load.firstFrameMs !== undefined ? { load: { ...this.load } } : {}),
      ...(Object.keys(this.scene).length ? { scene: { ...this.scene } } : {}),
      frameMs: { buckets: [...FRAME_BUCKETS], counts: [...f.counts], ...(p50 !== undefined ? { p50 } : {}), ...(p95 !== undefined ? { p95 } : {}), frames: f.frames },
      longFrames: { count: f.long, ...(f.maxMs ? { maxMs: round(f.maxMs) } : {}) },
      memory: { ...this.memory },
      contextLost: { ...this.context },
      errors: { count: this.errorCount, first: this.errors.map((e) => ({ ...e })) },
      exit,
    };
  }
}

/** Whether a GPU renderer string names a software rasteriser. */
export const isSoftwareRenderer = (renderer: string | undefined): boolean => Boolean(renderer && /swiftshader|llvmpipe|softpipe|software|basic render|lavapipe/i.test(renderer));
