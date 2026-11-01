/**
 * Plain FDM G-code to toolpath segments (PB-1192), streamed.
 *
 * Reads what slicers write for FDM printers: G0/G1 moves, G2/G3 arcs in the
 * XY plane (I/J centre offsets or R radius; split into straight pieces at a
 * chord tolerance, with Z and E spread along the arc), G90/G91 and M82/M83
 * (absolute and relative axes and extruder), G92 (set position), G28 (home),
 * G20/G21 (inches, millimetres), and the slicers' comments: `;TYPE:` and
 * `; FEATURE:` for the feature type, `;LAYER:`, `;LAYER_CHANGE` and
 * `; CHANGE_LAYER` for layer starts, `;WIDTH:`/`; LINE_WIDTH:` and
 * `;HEIGHT:`/`; LAYER_HEIGHT:` for the bead, and the slicer's own time
 * estimate (`;TIME:`, `estimated printing time`, the first `M73 ... R`).
 *
 * Layers: when the file has layer comments they start layers; before the
 * first one (and in files with none) a layer starts at each extruding move
 * whose Z differs from the current layer's (Z hops on travel never start one).
 *
 * Output (`GcodeModel`): two column stores in file order, one for extrusions
 * and one for travel moves, each as flat typed arrays (start xyz, end xyz,
 * feature, layer, bead width and height in 0.01 mm, source line) that the
 * geometry builder hands to the GPU as instanced attributes without copying;
 * a layer table (z, height, segment ranges in both stores, a 16-bit mask of
 * the feature types present); per-feature totals; time and filament estimates.
 *
 * Units and frame: millimetres, Z up, the printer's own coordinates; the 3D
 * view's CAD scene is millimetres and Z up as well, so nothing converts here.
 *
 * Size caps (security basics, and memory): files over `maxBytes` (256 MB) and
 * models past `maxSegments` (20 M) are decimated, never refused: contiguous
 * moves of the same feature and layer are joined (2, 4, 8 … per segment), and
 * when that is not enough every other move is dropped. `decimation` says so,
 * and the view shows it.
 *
 * Clean room (build-rules.md): written from the G-code and comment formats;
 * no code from any G-code viewer or slicer (most are GPL/AGPL) was read for it.
 * Nothing in the file is executed; unknown commands are counted and ignored.
 */
import { CUSTOM, FEATURE_COUNT, TRAVEL, featureFromName } from "./features";

/** DEFAULT caps (PB-1192 brief): 256 MB of G-code, 20 million segments. */
export const MAX_GCODE_BYTES = 256 * 1024 * 1024;
export const MAX_GCODE_SEGMENTS = 20_000_000;
/**
 * DEFAULT (wave 4 gate, bounds the work as well as the memory): reading stops at this many times `maxBytes` (what
 * was read is shown and the decimation note says so); a line longer than `MAX_GCODE_LINE_CHARS` is skipped, so a
 * file without newlines cannot stall the parser; at most `MAX_GCODE_LAYERS` layers (later layer changes stay in
 * the last one); numbers beyond `MAX_GCODE_NUMBER` in magnitude (or not finite) are ignored as damaged.
 */
export const GCODE_HARD_STOP_FACTOR = 4;
export const MAX_GCODE_LINE_CHARS = 64 * 1024;
export const MAX_GCODE_LAYERS = 100_000;
export const MAX_GCODE_NUMBER = 1e9;
/** Largest distance (mm) between an arc and its straight pieces. DEFAULT. */
export const ARC_TOLERANCE_MM = 0.01;
/** Filament diameter when the file does not say (mm). DEFAULT: the common 1.75 mm. */
export const DEFAULT_FILAMENT_MM = 1.75;

export interface GcodeParseOptions {
  maxSegments?: number;
  maxBytes?: number;
  /** The file's size, when known before reading (decimation starts at once for files over `maxBytes`). */
  size?: number;
  arcTolerance?: number;
}

/** One store of segments, in file order. Arrays may be longer than `count`; only the first `count` rows are used. */
export interface SegmentColumns {
  count: number;
  /** x0 y0 z0 per segment (mm). */
  start: Float32Array;
  /** x1 y1 z1 per segment (mm). */
  end: Float32Array;
  /** Feature index (features.ts); 0 for travel. */
  feature: Uint8Array;
  layer: Uint32Array;
  /** Bead width and height in 0.01 mm (0 for travel). */
  width: Uint8Array;
  height: Uint8Array;
  /** 1-based source line of the move. */
  line: Uint32Array;
}

export interface GcodeLayers {
  count: number;
  /** Z of the layer's first extrusion (mm). */
  z: Float32Array;
  /** Layer height (mm): the file's comment, else the Z step from the layer below. */
  height: Float32Array;
  /** Segment ranges per layer, [first, end) in each store. */
  extrudeFirst: Uint32Array;
  extrudeEnd: Uint32Array;
  travelFirst: Uint32Array;
  travelEnd: Uint32Array;
  /** Bit f set when the layer holds a segment of feature f (bit 0: travel). */
  types: Uint16Array;
  /** Estimated seconds per layer. */
  time: Float32Array;
}

export interface FeatureTotals {
  feature: number;
  segments: number;
  lengthMm: number;
  timeS: number;
  /** Filament pushed (mm of filament). */
  filamentMm: number;
}

export interface GcodeDecimation {
  /** Moves per segment kept (1 = none joined). */
  factor: number;
  /** Segments before joining and dropping. */
  inputSegments: number;
  /** Rows dropped outright (when joining was not enough). */
  dropped: number;
  reason: string;
}

export interface GcodeModel {
  extrude: SegmentColumns;
  travel: SegmentColumns;
  layers: GcodeLayers;
  features: FeatureTotals[];
  /** Bounds of the extrusions (mm); travel to a park position is left out. Undefined when nothing is extruded. */
  bounds?: { min: [number, number, number]; max: [number, number, number] };
  /** Our estimate from lengths and feed rates (no acceleration): a lower bound. */
  timeS: number;
  /** The slicer's own estimate, when the file carries one. */
  slicerTimeS?: number;
  filamentMm: number;
  filamentDiameterMm: number;
  lines: number;
  bytes: number;
  generatedBy?: string;
  /** "markers" when the file's layer comments started layers, "z" when Z changes did. */
  layerSource: "markers" | "z" | "none";
  decimation?: GcodeDecimation;
  /** Lines and commands the parser skipped, counted (the first few named). */
  warnings: string[];
  parseMs: number;
}

// ---------------------------------------------------------------------------
// Column store
// ---------------------------------------------------------------------------

class Store {
  count = 0;
  start: Float32Array;
  end: Float32Array;
  feature: Uint8Array;
  layer: Uint32Array;
  width: Uint8Array;
  height: Uint8Array;
  line: Uint32Array;
  constructor(cap = 4096) {
    this.start = new Float32Array(cap * 3);
    this.end = new Float32Array(cap * 3);
    this.feature = new Uint8Array(cap);
    this.layer = new Uint32Array(cap);
    this.width = new Uint8Array(cap);
    this.height = new Uint8Array(cap);
    this.line = new Uint32Array(cap);
  }
  get capacity() {
    return this.feature.length;
  }
  private grow(min: number) {
    let cap = this.capacity;
    while (cap < min) cap *= 2;
    const g = <T extends Float32Array | Uint8Array | Uint32Array>(a: T, n: number): T => {
      const b = new (a.constructor as new (n: number) => T)(n);
      b.set(a.subarray(0, this.count * (a.length / this.capacity)) as never);
      return b;
    };
    const old = this.capacity;
    const start = g(this.start, cap * 3);
    const end = g(this.end, cap * 3);
    const feature = g(this.feature, cap);
    const layer = g(this.layer, cap);
    const width = g(this.width, cap);
    const height = g(this.height, cap);
    const line = g(this.line, cap);
    void old;
    Object.assign(this, { start, end, feature, layer, width, height, line });
  }
  push(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, f: number, layer: number, w: number, h: number, line: number) {
    if (this.count >= this.capacity) this.grow(this.count + 1);
    const i = this.count++;
    const k = i * 3;
    this.start[k] = x0;
    this.start[k + 1] = y0;
    this.start[k + 2] = z0;
    this.end[k] = x1;
    this.end[k + 1] = y1;
    this.end[k + 2] = z1;
    this.feature[i] = f;
    this.layer[i] = layer;
    this.width[i] = w;
    this.height[i] = h;
    this.line[i] = line;
  }
  /** Whether rows i and j (= i + 1) can become one: same feature and layer, j starts where i ends. */
  joinable(i: number, j: number): boolean {
    if (this.feature[i] !== this.feature[j] || this.layer[i] !== this.layer[j]) return false;
    const a = i * 3;
    const b = j * 3;
    return this.end[a] === this.start[b] && this.end[a + 1] === this.start[b + 1] && this.end[a + 2] === this.start[b + 2];
  }
  /** Join contiguous pairs in place; with `drop`, keep every other row of what stays. Returns rows removed by dropping. */
  compact(drop: boolean): number {
    let w = 0;
    let i = 0;
    const n = this.count;
    while (i < n) {
      const pair = i + 1 < n && this.joinable(i, i + 1);
      this.copy(i, w);
      if (pair) {
        const j = (i + 1) * 3;
        this.end[w * 3] = this.end[j];
        this.end[w * 3 + 1] = this.end[j + 1];
        this.end[w * 3 + 2] = this.end[j + 2];
      }
      w++;
      i += pair ? 2 : 1;
    }
    this.count = w;
    if (!drop) return 0;
    // every other row, but never a layer's first (keeps every layer present)
    let k = 0;
    for (let r = 0; r < this.count; r++) {
      const firstOfLayer = r === 0 || this.layer[r] !== this.layer[r - 1];
      if (firstOfLayer || r % 2 === 0) this.copy(r, k++);
    }
    const dropped = this.count - k;
    this.count = k;
    return dropped;
  }
  private copy(from: number, to: number) {
    if (from === to) return;
    const a = from * 3;
    const b = to * 3;
    this.start[b] = this.start[a];
    this.start[b + 1] = this.start[a + 1];
    this.start[b + 2] = this.start[a + 2];
    this.end[b] = this.end[a];
    this.end[b + 1] = this.end[a + 1];
    this.end[b + 2] = this.end[a + 2];
    this.feature[to] = this.feature[from];
    this.layer[to] = this.layer[from];
    this.width[to] = this.width[from];
    this.height[to] = this.height[from];
    this.line[to] = this.line[from];
  }
  /** The used rows, trimmed when the arrays are much longer (frees the slack before the GPU upload). */
  columns(): SegmentColumns {
    const n = this.count;
    const trim = n < this.capacity * 0.75;
    const t = <T extends Float32Array | Uint8Array | Uint32Array>(a: T, k: number): T => (trim ? (a.slice(0, n * k) as T) : a);
    return { count: n, start: t(this.start, 3), end: t(this.end, 3), feature: t(this.feature, 1), layer: t(this.layer, 1), width: t(this.width, 1), height: t(this.height, 1), line: t(this.line, 1) };
  }
}

// ---------------------------------------------------------------------------
// Number reading without substrings (the parser's hot loop)
// ---------------------------------------------------------------------------

let numEnd = 0;
/** A decimal number at s[i..]: sets `numEnd`; NaN when there is none. */
function readNumber(s: string, i: number, end: number): number {
  let sign = 1;
  let c = s.charCodeAt(i);
  if (c === 45 /* - */) {
    sign = -1;
    i++;
  } else if (c === 43 /* + */) i++;
  let v = 0;
  let digits = 0;
  while (i < end) {
    c = s.charCodeAt(i);
    if (c < 48 || c > 57) break;
    v = v * 10 + (c - 48);
    digits++;
    i++;
  }
  if (i < end && s.charCodeAt(i) === 46 /* . */) {
    i++;
    let scale = 0.1;
    while (i < end) {
      c = s.charCodeAt(i);
      if (c < 48 || c > 57) break;
      v += (c - 48) * scale;
      scale *= 0.1;
      digits++;
      i++;
    }
  }
  if (digits && i < end && (s.charCodeAt(i) | 32) === 101 /* e */) {
    let j = i + 1;
    let es = 1;
    if (s.charCodeAt(j) === 45) {
      es = -1;
      j++;
    } else if (s.charCodeAt(j) === 43) j++;
    let ev = 0;
    let ed = 0;
    while (j < end) {
      c = s.charCodeAt(j);
      if (c < 48 || c > 57) break;
      ev = ev * 10 + (c - 48);
      ed++;
      j++;
    }
    if (ed) {
      v *= Math.pow(10, es * ev);
      i = j;
    }
  }
  numEnd = i;
  return digits ? sign * v : NaN;
}

// parameter letters a move reads
const PX = 0,
  PY = 1,
  PZ = 2,
  PE = 3,
  PF = 4,
  PI = 5,
  PJ = 6,
  PR = 7,
  PP = 8;
const LETTER: Record<number, number> = { 88: PX, 89: PY, 90: PZ, 69: PE, 70: PF, 73: PI, 74: PJ, 82: PR, 80: PP };

const q01 = (mm: number) => Math.max(0, Math.min(255, Math.round(mm * 100)));

/** Seconds in "1d 2h 3m 4s" (any subset). */
function durationSeconds(text: string): number | undefined {
  let s = 0;
  let any = false;
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*([dhms])/gi)) {
    any = true;
    s += Number(m[1]) * ({ d: 86400, h: 3600, m: 60, s: 1 } as Record<string, number>)[m[2].toLowerCase()];
  }
  return any ? s : undefined;
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

export class GcodeParser {
  private ex = new Store();
  private tr = new Store();
  private opts: Required<Omit<GcodeParseOptions, "size">> & { size?: number };
  private t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
  private rest = "";
  private lineNo = 0;
  private bytes = 0;

  // machine state
  private x = 0;
  private y = 0;
  private z = 0;
  private e = 0;
  private f = 1800; // mm/min, DEFAULT until the file sets one
  private absXYZ = true;
  private absE = true;
  private scale = 1; // 25.4 after G20
  private plane = 17;

  // slicer state
  private feature = CUSTOM;
  private widthMm: number | undefined;
  private heightMm: number | undefined;
  private filamentMm = DEFAULT_FILAMENT_MM;

  // layers
  private markers = false;
  private pendingMarker = false;
  private layer = 0;
  private layerHasSegments = false;
  private layerZ: number[] = [];
  private layerHeight: number[] = [];
  private layerTime: number[] = [0];
  private layerTypes: number[] = [0];
  private layerZSet = false;
  private prevLayerZ = 0;

  // totals
  private featSegs = new Float64Array(FEATURE_COUNT);
  private featLen = new Float64Array(FEATURE_COUNT);
  private featTime = new Float64Array(FEATURE_COUNT);
  private featFil = new Float64Array(FEATURE_COUNT);
  private timeS = 0;
  private slicerTimeS: number | undefined;
  private generatedBy: string | undefined;
  private min = [Infinity, Infinity, Infinity];
  private max = [-Infinity, -Infinity, -Infinity];
  private warnCounts = new Map<string, number>();

  // decimation
  private factor = 1;
  private input = 0;
  private dropped = 0;
  private decimationReason: string | undefined;
  /** Where reading stopped (characters), past the hard limit; nothing more is parsed. */
  private stoppedAt: number | undefined;
  /** The rest of an over-long line is being skipped (up to its newline). */
  private skipLine = false;
  /** Compaction could not get under the segment cap (one row per layer is always kept): new rows are dropped. */
  private full = false;
  private pend: { store: Store; x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; f: number; layer: number; w: number; h: number; line: number; n: number } | undefined;

  constructor(options: GcodeParseOptions = {}) {
    this.opts = { maxSegments: options.maxSegments ?? MAX_GCODE_SEGMENTS, maxBytes: options.maxBytes ?? MAX_GCODE_BYTES, arcTolerance: options.arcTolerance ?? ARC_TOLERANCE_MM, ...(options.size !== undefined ? { size: options.size } : {}) };
    if (options.size !== undefined && options.size > this.opts.maxBytes) {
      this.factor = Math.min(64, 2 ** Math.ceil(Math.log2(options.size / this.opts.maxBytes)));
      this.decimationReason = `the file is ${(options.size / 1024 ** 2).toFixed(0)} MB, over the ${(this.opts.maxBytes / 1024 ** 2).toFixed(0)} MB cap`;
    }
  }

  /** Feed text (any split: a line cut between chunks is kept until the next). */
  push(chunk: string): void {
    if (this.stoppedAt !== undefined) return;
    // past the hard limit only the part up to it is read; then reading stops (wave 4 gate)
    const limit = this.opts.maxBytes * GCODE_HARD_STOP_FACTOR;
    const stopHere = this.bytes + chunk.length > limit;
    if (stopHere) chunk = chunk.slice(0, Math.max(0, limit - this.bytes));
    this.pushText(chunk);
    if (stopHere) {
      this.stoppedAt = this.bytes;
      this.decimationReason = `reading stopped after ${(this.bytes / 1024 ** 2).toFixed(0)} MB, ${GCODE_HARD_STOP_FACTOR} times the ${(this.opts.maxBytes / 1024 ** 2).toFixed(0)} MB cap: what was read is shown`;
      this.rest = "";
      this.skipLine = false;
    }
  }

  private pushText(chunk: string): void {
    this.bytes += chunk.length;
    if (this.decimationReason === undefined && this.bytes > this.opts.maxBytes) {
      // a stream that did not say its size: start joining from here on
      this.factor = Math.max(this.factor, 2);
      this.decimationReason = `the file is over the ${(this.opts.maxBytes / 1024 ** 2).toFixed(0)} MB cap`;
    }
    const s = this.rest ? this.rest + chunk : chunk;
    let a = 0;
    if (this.skipLine) {
      const nl = s.indexOf("\n");
      if (nl < 0) {
        this.rest = "";
        return;
      }
      this.skipLine = false;
      this.lineNo++;
      a = nl + 1;
    }
    for (;;) {
      const nl = s.indexOf("\n", a);
      if (nl < 0) break;
      let b = nl;
      if (b > a && s.charCodeAt(b - 1) === 13) b--;
      this.lineNo++;
      this.parseLine(s, a, b);
      a = nl + 1;
    }
    this.rest = s.slice(a);
    if (this.rest.length > MAX_GCODE_LINE_CHARS) {
      this.warn(`a line over ${MAX_GCODE_LINE_CHARS / 1024} kB was skipped`);
      this.rest = "";
      this.skipLine = true;
    }
  }

  /** Whether reading stopped at the hard limit (a stream reader may cancel the rest). */
  get stopped(): boolean {
    return this.stoppedAt !== undefined;
  }

  /** The model; the parser is spent after this. */
  finish(): GcodeModel {
    if (this.rest) {
      this.lineNo++;
      this.parseLine(this.rest, 0, this.rest.length);
      this.rest = "";
    }
    this.flushPending();
    return this.build();
  }

  private warn(what: string) {
    this.warnCounts.set(what, (this.warnCounts.get(what) ?? 0) + 1);
  }

  private parseLine(s: string, a: number, b: number) {
    let i = a;
    while (i < b && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
    if (i >= b) return;
    let c = s.charCodeAt(i);
    if (c === 59 /* ; */) return this.comment(s, i + 1, b);
    // line number N123
    if ((c | 32) === 110) {
      readNumber(s, i + 1, b);
      i = numEnd;
      while (i < b && s.charCodeAt(i) === 32) i++;
      c = s.charCodeAt(i);
    }
    const letter = c & ~32;
    if (letter !== 71 /* G */ && letter !== 77 /* M */ && letter !== 84 /* T */) {
      // a bare comment in parentheses, or something we do not read
      const semi = s.indexOf(";", i);
      if (semi >= 0 && semi < b) this.comment(s, semi + 1, b);
      return;
    }
    const code = readNumber(s, i + 1, b);
    i = numEnd;
    // a decimal code (G29.1) is not a move
    if (letter === 71 && (code === 0 || code === 1 || code === 2 || code === 3)) {
      const p = this.params;
      let has = 0;
      while (i < b) {
        c = s.charCodeAt(i);
        if (c === 59) {
          this.comment(s, i + 1, b);
          break;
        }
        if (c === 42 /* * checksum */) break;
        if (c === 40 /* ( */) {
          const close = s.indexOf(")", i);
          i = close < 0 || close > b ? b : close + 1;
          continue;
        }
        const slot = LETTER[c & ~32];
        if (slot !== undefined) {
          const v = readNumber(s, i + 1, b);
          if (numEnd > i + 1 && Number.isFinite(v) && Math.abs(v) <= MAX_GCODE_NUMBER) {
            p[slot] = v;
            has |= 1 << slot;
          }
          i = Math.max(numEnd, i + 1);
          continue;
        }
        i++;
      }
      return this.move(code, p, has);
    }
    // the rest of a non-move line: only its trailing comment matters
    const semi = s.indexOf(";", i);
    const params = semi >= 0 && semi < b ? semi : b;
    if (letter === 71) this.gcode(code, s, i, params);
    else if (letter === 77) this.mcode(code, s, i, params);
    if (semi >= 0 && semi < b) this.comment(s, semi + 1, b);
  }

  private params = new Float64Array(9);

  private gcode(code: number, s: string, i: number, b: number) {
    switch (code) {
      case 90:
        this.absXYZ = true;
        this.absE = true;
        return;
      case 91:
        this.absXYZ = false;
        this.absE = false;
        return;
      case 20:
        this.scale = 25.4;
        return;
      case 21:
        this.scale = 1;
        return;
      case 17:
      case 18:
      case 19:
        this.plane = code;
        return;
      case 92:
      case 28: {
        let any = false;
        while (i < b) {
          const c = s.charCodeAt(i) & ~32;
          const slot = LETTER[c];
          if (slot === PX || slot === PY || slot === PZ || slot === PE) {
            const v = readNumber(s, i + 1, b);
            any = true;
            const val = code === 28 || Number.isNaN(v) ? 0 : v * this.scale;
            if (slot === PX) this.x = val;
            else if (slot === PY) this.y = val;
            else if (slot === PZ) this.z = val;
            else this.e = val;
            i = Math.max(numEnd, i + 1);
            continue;
          }
          i++;
        }
        if (!any) {
          // G92 alone sets every axis to 0; G28 alone homes every axis (to 0: the printer's origin)
          this.x = this.y = this.z = 0;
          this.e = 0;
        }
        return;
      }
      default:
        if (code !== 4 && code !== 29 && code !== 10 && code !== 11 && code !== 80) this.warn(`G${code}`);
    }
  }

  private mcode(code: number, s: string, i: number, b: number) {
    if (code === 82) this.absE = true;
    else if (code === 83) this.absE = false;
    else if (code === 73 && this.slicerTimeS === undefined) {
      // Bambu and Prusa progress: M73 P<percent> R<minutes remaining>; the first R is the total
      const r = s.slice(i, b).match(/R\s*(\d+(?:\.\d+)?)/i);
      if (r) this.slicerTimeS = Number(r[1]) * 60;
    }
  }

  private comment(s: string, a: number, b: number) {
    while (a < b && s.charCodeAt(a) === 32) a++;
    if (a >= b) return;
    const c0 = s.charCodeAt(a) & ~32;
    // only the comments we read; everything else is skipped without a substring
    if (c0 !== 84 && c0 !== 70 && c0 !== 76 && c0 !== 67 && c0 !== 87 && c0 !== 72 && c0 !== 69 && c0 !== 71 && c0 !== 70 && c0 !== 66 && c0 !== 80 && c0 !== 79 && c0 !== 83 && c0 !== 77) return;
    const text = s.slice(a, b);
    const up = text.toUpperCase();
    const after = (prefix: string) => text.slice(prefix.length).trim();
    if (up.startsWith("TYPE:")) this.feature = featureFromName(after("TYPE:"));
    else if (up.startsWith("FEATURE:")) this.feature = featureFromName(after("FEATURE:"));
    else if (up.startsWith("LAYER:") || up.startsWith("LAYER_CHANGE") || up.startsWith("CHANGE_LAYER")) {
      this.markers = true;
      this.pendingMarker = true;
    } else if (up.startsWith("WIDTH:") || up.startsWith("LINE_WIDTH:")) {
      const v = Number(text.slice(text.indexOf(":") + 1).trim());
      if (v > 0) this.widthMm = v;
    } else if (up.startsWith("HEIGHT:") || up.startsWith("LAYER_HEIGHT:")) {
      const v = Number(text.slice(text.indexOf(":") + 1).trim());
      if (v > 0) this.heightMm = v;
    } else if (up.startsWith("TIME:") && this.slicerTimeS === undefined) {
      const v = Number(after("TIME:"));
      if (v > 0) this.slicerTimeS = v;
    } else if (up.includes("ESTIMATED PRINTING TIME") || up.startsWith("TOTAL ESTIMATED TIME") || up.startsWith("MODEL PRINTING TIME")) {
      if (this.slicerTimeS === undefined) {
        // the text after the first `:` or `=`, up to the next `;` (Bambu writes model and total time on one line)
        const t = durationSeconds(text.slice(text.search(/[=:]/) + 1).split(";")[0]);
        if (t !== undefined) this.slicerTimeS = t;
      }
    } else if (up.startsWith("FILAMENT_DIAMETER") || up.startsWith("FILAMENT DIAMETER")) {
      const v = Number(text.slice(text.search(/[=:]/) + 1).split(/[,;]/)[0].trim());
      if (v > 0.5 && v < 5) this.filamentMm = v;
    } else if (this.generatedBy === undefined && this.lineNo < 40 && /^(generated (by|with)|bambustudio|orcaslicer|prusaslicer|superslicer|cura|simplify3d)/i.test(text)) {
      this.generatedBy = text.replace(/^generated (by|with)\s*/i, "").trim().slice(0, 120);
    }
  }

  /** Start a layer when a marker is pending (marker mode), or when an extrusion's Z left the layer (Z mode). */
  private layerFor(extruding: boolean, z: number): number {
    if (this.pendingMarker) {
      this.pendingMarker = false;
      if (this.layerHasSegments) this.newLayer();
    } else if (!this.markers && extruding && this.layerZSet && Math.abs(z - this.layerZ[this.layer]) > 1e-4) {
      this.newLayer();
    }
    if (extruding && !this.layerZSet) {
      this.layerZ[this.layer] = z;
      this.layerHeight[this.layer] = this.heightMm ?? (this.layer === 0 ? z : Math.max(0, z - this.prevLayerZ)) ?? 0;
      this.layerZSet = true;
    }
    this.layerHasSegments = true;
    return this.layer;
  }

  private newLayer() {
    if (this.layer + 1 >= MAX_GCODE_LAYERS) {
      this.warn(`over ${MAX_GCODE_LAYERS.toLocaleString("en-US")} layers: later layer changes are kept in the last layer`);
      return;
    }
    if (this.layerZSet) this.prevLayerZ = this.layerZ[this.layer];
    else this.layerZ[this.layer] = this.z; // a layer of travel only: its Z is where the head was
    if (this.layerHeight[this.layer] === undefined) this.layerHeight[this.layer] = 0;
    this.layer++;
    this.layerTime[this.layer] = 0;
    this.layerTypes[this.layer] = 0;
    this.layerZSet = false;
    this.layerHasSegments = false;
  }

  private move(code: number, p: Float64Array, has: number) {
    const sc = this.scale;
    const rel = !this.absXYZ;
    const nx = has & (1 << PX) ? p[PX] * sc + (rel ? this.x : 0) : this.x;
    const ny = has & (1 << PY) ? p[PY] * sc + (rel ? this.y : 0) : this.y;
    const nz = has & (1 << PZ) ? p[PZ] * sc + (rel ? this.z : 0) : this.z;
    let de = 0;
    if (has & (1 << PE)) {
      const v = p[PE] * sc;
      de = this.absE ? v - this.e : v;
      this.e = this.absE ? v : this.e + v;
    }
    if (has & (1 << PF) && p[PF] > 0) this.f = p[PF] * sc;
    if (code >= 2 && this.plane !== 17) {
      this.warn(`G${code} outside the XY plane (drawn straight)`);
      code = 1;
    }
    if (code === 2 || code === 3) this.arc(code === 2, nx, ny, nz, de, p, has);
    else this.segment(this.x, this.y, this.z, nx, ny, nz, de);
    this.x = nx;
    this.y = ny;
    this.z = nz;
  }

  private arc(cw: boolean, nx: number, ny: number, nz: number, de: number, p: Float64Array, has: number) {
    const sx = this.x;
    const sy = this.y;
    let cx: number;
    let cy: number;
    if (has & ((1 << PI) | (1 << PJ))) {
      cx = sx + (has & (1 << PI) ? p[PI] * this.scale : 0);
      cy = sy + (has & (1 << PJ) ? p[PJ] * this.scale : 0);
    } else if (has & (1 << PR)) {
      // centre from the radius: on the chord's bisector; R < 0 asks for the long way round
      const r = p[PR] * this.scale;
      const mx = (sx + nx) / 2;
      const my = (sy + ny) / 2;
      const dx = nx - sx;
      const dy = ny - sy;
      const d = Math.hypot(dx, dy);
      if (d === 0 || Math.abs(r) < d / 2 - 1e-9) {
        this.warn("arc with an impossible radius (drawn straight)");
        return this.segment(sx, sy, this.z, nx, ny, nz, de);
      }
      const hgt = Math.sqrt(Math.max(0, r * r - (d * d) / 4));
      // the centre side that gives the short arc in the asked direction (flipped for R < 0)
      const sideSign = (cw ? -1 : 1) * (r < 0 ? -1 : 1);
      cx = mx - (sideSign * hgt * dy) / d;
      cy = my + (sideSign * hgt * dx) / d;
    } else {
      this.warn("arc with no centre (drawn straight)");
      return this.segment(sx, sy, this.z, nx, ny, nz, de);
    }
    const radius = Math.hypot(sx - cx, sy - cy);
    if (radius < 1e-6) return this.segment(sx, sy, this.z, nx, ny, nz, de);
    const a0 = Math.atan2(sy - cy, sx - cx);
    const a1 = Math.atan2(ny - cy, nx - cx);
    let sweep = a1 - a0;
    if (cw) {
      if (sweep >= -1e-9) sweep -= 2 * Math.PI;
    } else if (sweep <= 1e-9) sweep += 2 * Math.PI;
    const tol = Math.min(this.opts.arcTolerance, radius * 0.5);
    const step = 2 * Math.acos(1 - tol / radius);
    const n = Math.max(1, Math.min(720, Math.ceil(Math.abs(sweep) / step)));
    let px = sx;
    let py = sy;
    let pz = this.z;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const a = a0 + sweep * t;
      const qx = k === n ? nx : cx + radius * Math.cos(a);
      const qy = k === n ? ny : cy + radius * Math.sin(a);
      const qz = this.z + (nz - this.z) * t;
      this.segment(px, py, pz, qx, qy, qz, de / n);
      px = qx;
      py = qy;
      pz = qz;
    }
  }

  private segment(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, de: number) {
    const len = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
    if (len < 1e-7) return; // a retract, an unretract, a feed change: no segment
    const extruding = de > 1e-9;
    const f = extruding ? this.feature : TRAVEL;
    const layer = this.layerFor(extruding, extruding ? z1 : this.z);
    const t = len / (this.f / 60);
    this.timeS += t;
    this.layerTime[layer] += t;
    this.layerTypes[layer] |= 1 << f;
    this.featSegs[f]++;
    this.featLen[f] += len;
    this.featTime[f] += t;
    let w = 0;
    let h = 0;
    if (extruding) {
      this.featFil[f] += de;
      const lh = this.heightMm ?? (this.layerHeight[layer] || 0.2);
      // bead width: the slicer's comment, else from the volume pushed (filament area × E over length × height)
      const area = Math.PI * (this.filamentMm / 2) ** 2;
      const wmm = this.widthMm ?? Math.min(2.5, Math.max(0.1, (de * area) / (len * lh)));
      w = q01(wmm);
      h = q01(lh);
      if (x0 < this.min[0]) this.min[0] = x0;
      if (y0 < this.min[1]) this.min[1] = y0;
      if (z0 < this.min[2]) this.min[2] = z0;
      if (x1 < this.min[0]) this.min[0] = x1;
      if (y1 < this.min[1]) this.min[1] = y1;
      if (z1 < this.min[2]) this.min[2] = z1;
      if (x0 > this.max[0]) this.max[0] = x0;
      if (y0 > this.max[1]) this.max[1] = y0;
      if (z0 > this.max[2]) this.max[2] = z0;
      if (x1 > this.max[0]) this.max[0] = x1;
      if (y1 > this.max[1]) this.max[1] = y1;
      if (z1 > this.max[2]) this.max[2] = z1;
    }
    this.input++;
    this.emit(extruding ? this.ex : this.tr, x0, y0, z0, x1, y1, z1, f, layer, w, h);
  }

  private emit(store: Store, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, f: number, layer: number, w: number, h: number) {
    if (this.full) {
      this.dropped++;
      return;
    }
    if (this.factor > 1) {
      const pd = this.pend;
      if (pd && pd.store === store && pd.f === f && pd.layer === layer && pd.n < this.factor && pd.x1 === Math.fround(x0) && pd.y1 === Math.fround(y0) && pd.z1 === Math.fround(z0)) {
        pd.x1 = Math.fround(x1);
        pd.y1 = Math.fround(y1);
        pd.z1 = Math.fround(z1);
        pd.n++;
        return;
      }
      this.flushPending();
      this.pend = { store, x0, y0, z0, x1: Math.fround(x1), y1: Math.fround(y1), z1: Math.fround(z1), f, layer, w, h, line: this.lineNo, n: 1 };
      return;
    }
    store.push(x0, y0, z0, x1, y1, z1, f, layer, w, h, this.lineNo);
    this.checkCap();
  }

  private flushPending() {
    const pd = this.pend;
    if (!pd) return;
    this.pend = undefined;
    pd.store.push(pd.x0, pd.y0, pd.z0, pd.x1, pd.y1, pd.z1, pd.f, pd.layer, pd.w, pd.h, pd.line);
    this.checkCap();
  }

  private checkCap() {
    const total = this.ex.count + this.tr.count;
    if (total < this.opts.maxSegments) return;
    // over the cap: join pairs now, and join twice as many from here on; drop rows if joining did not halve it
    this.decimationReason ??= `over the ${this.opts.maxSegments.toLocaleString("en-US")}-segment cap`;
    this.ex.compact(false);
    this.tr.compact(false);
    if (this.ex.count + this.tr.count > this.opts.maxSegments * 0.75) {
      this.dropped += this.tr.compact(true);
      if (this.ex.count + this.tr.count > this.opts.maxSegments * 0.75) this.dropped += this.ex.compact(true);
    }
    this.factor *= 2;
    // one row per layer is always kept, so compaction may not get under the cap: then new rows are dropped rather
    // than compacting every row again for each new segment (wave 4 gate)
    if (this.ex.count + this.tr.count > this.opts.maxSegments * 0.9) this.full = true;
  }

  private build(): GcodeModel {
    if (!this.layerZSet && this.layerZ[this.layer] === undefined) this.layerZ[this.layer] = this.z;
    const nLayers = this.layerHasSegments || this.layer === 0 ? this.layer + 1 : this.layer;
    const extrude = this.ex.columns();
    const travel = this.tr.columns();
    const ranges = (c: SegmentColumns) => {
      const first = new Uint32Array(nLayers);
      const end = new Uint32Array(nLayers);
      let i = 0;
      for (let l = 0; l < nLayers; l++) {
        while (i < c.count && c.layer[i] < l) i++;
        first[l] = i;
        while (i < c.count && c.layer[i] === l) i++;
        end[l] = i;
      }
      return { first, end };
    };
    const er = ranges(extrude);
    const trr = ranges(travel);
    const z = new Float32Array(nLayers);
    const height = new Float32Array(nLayers);
    const types = new Uint16Array(nLayers);
    const time = new Float32Array(nLayers);
    for (let l = 0; l < nLayers; l++) {
      z[l] = this.layerZ[l] ?? 0;
      height[l] = this.layerHeight[l] ?? 0;
      types[l] = this.layerTypes[l] ?? 0;
      time[l] = this.layerTime[l] ?? 0;
    }
    const features: FeatureTotals[] = [];
    for (let f = 0; f < FEATURE_COUNT; f++) if (this.featSegs[f]) features.push({ feature: f, segments: this.featSegs[f], lengthMm: this.featLen[f], timeS: this.featTime[f], filamentMm: this.featFil[f] });
    const warnings = [...this.warnCounts].map(([w, n]) => `${w}: ${n} line(s) skipped or simplified`);
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const decimated = this.decimationReason !== undefined;
    return {
      extrude,
      travel,
      layers: { count: nLayers, z, height, extrudeFirst: er.first, extrudeEnd: er.end, travelFirst: trr.first, travelEnd: trr.end, types, time },
      features,
      ...(this.min[0] <= this.max[0] ? { bounds: { min: [this.min[0], this.min[1], this.min[2]] as [number, number, number], max: [this.max[0], this.max[1], this.max[2]] as [number, number, number] } } : {}),
      timeS: this.timeS,
      ...(this.slicerTimeS !== undefined ? { slicerTimeS: this.slicerTimeS } : {}),
      filamentMm: features.reduce((n, f) => n + f.filamentMm, 0),
      filamentDiameterMm: this.filamentMm,
      lines: this.lineNo,
      bytes: this.bytes,
      ...(this.generatedBy ? { generatedBy: this.generatedBy } : {}),
      layerSource: this.markers ? "markers" : nLayers > 1 || this.layerZSet ? "z" : "none",
      ...(decimated ? { decimation: { factor: this.factor, inputSegments: this.input, dropped: this.dropped, reason: this.decimationReason! } } : {}),
      warnings,
      parseMs: now - this.t0,
    };
  }
}

/** Parse a whole G-code text at once. */
export function parseGcode(text: string, options: GcodeParseOptions = {}): GcodeModel {
  const p = new GcodeParser({ size: text.length, ...options });
  p.push(text);
  return p.finish();
}

/**
 * Parse a stream (a `fetch` body, a `File.stream()`), decoding as UTF-8 and yielding to the event loop between
 * chunks so the page stays responsive. DEFAULT (PB-1192): parsed on the main thread in chunks; a Web Worker is the
 * next step (runtime-and-workflows.md §6.3) once the viewer's four build configs agree on worker bundling.
 */
export async function parseGcodeStream(stream: ReadableStream<Uint8Array>, options: GcodeParseOptions & { onProgress?: (bytes: number) => void; signal?: AbortSignal } = {}): Promise<GcodeModel> {
  const p = new GcodeParser(options);
  const reader = stream.getReader();
  const dec = new TextDecoder("utf-8");
  let read = 0;
  let last = Date.now();
  for (;;) {
    if (options.signal?.aborted) {
      await reader.cancel();
      throw new Error("aborted");
    }
    const { done, value } = await reader.read();
    if (done) break;
    read += value.byteLength;
    p.push(dec.decode(value, { stream: true }));
    if (p.stopped) {
      await reader.cancel();
      break;
    }
    if (Date.now() - last > 30) {
      options.onProgress?.(read);
      await new Promise((r) => setTimeout(r, 0));
      last = Date.now();
    }
  }
  const tail = dec.decode();
  if (tail) p.push(tail);
  options.onProgress?.(read);
  return p.finish();
}

/** One line per feature and the totals: what `gcode.summary` and the legend show. */
export function gcodeSummary(m: GcodeModel) {
  return {
    segments: { extrude: m.extrude.count, travel: m.travel.count },
    layers: m.layers.count,
    layerSource: m.layerSource,
    bounds: m.bounds,
    timeS: Math.round(m.timeS),
    ...(m.slicerTimeS !== undefined ? { slicerTimeS: Math.round(m.slicerTimeS) } : {}),
    filamentMm: Math.round(m.filamentMm),
    generatedBy: m.generatedBy,
    decimation: m.decimation,
    warnings: m.warnings,
  };
}
