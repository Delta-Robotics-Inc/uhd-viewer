/**
 * Automatic layout for a level with nets (PB-823): components and net
 * junctions placed by a deterministic force layout, so each junction sits
 * among the components it joins, then pulled apart until no two cards come
 * closer than a margin. A row of modules (the layout for other levels) puts
 * a board's twenty-odd nodes on one line; this keeps them in a block.
 */

export interface GraphNode {
  id: string;
  w: number;
  h: number;
}

/** Top-left positions by node id. Same input, same output. */
export function graphLayout(nodes: GraphNode[], edges: [string, string][], opts: { length?: number; margin?: number; iterations?: number } = {}): Record<string, { x: number; y: number }> {
  const n = nodes.length;
  if (!n) return {};
  const k = opts.length ?? 150;
  const margin = opts.margin ?? 40;
  const index = new Map(nodes.map((v, i) => [v.id, i]));
  const links = edges.map(([a, b]) => [index.get(a), index.get(b)]).filter((e): e is [number, number] => e[0] !== undefined && e[1] !== undefined && e[0] !== e[1]);
  const degree = nodes.map((_, i) => links.filter(([a, b]) => a === i || b === i).length);

  // start on a circle, busiest nodes first, so the hubs settle in the middle
  const order = nodes.map((_, i) => i).sort((a, b) => degree[b] - degree[a] || a - b);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  order.forEach((i, rank) => {
    const r = rank === 0 ? 0 : k * (0.6 + 0.35 * Math.sqrt(rank));
    const a = rank * 2.399963; // golden angle
    x[i] = Math.cos(a) * r;
    y[i] = Math.sin(a) * r * 0.75;
  });
  const radius = nodes.map((v) => Math.hypot(v.w, v.h) / 2);

  const iterations = opts.iterations ?? 400;
  for (let it = 0; it < iterations; it++) {
    const t = k * 0.6 * (1 - it / iterations) + 2;
    const dx = new Float64Array(n);
    const dy = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = x[i] - x[j];
        let ey = y[i] - y[j];
        let d = Math.hypot(ex, ey);
        if (d < 0.01) {
          ex = (i - j) * 0.01;
          ey = 0.01;
          d = Math.hypot(ex, ey);
        }
        const gap = Math.max(d - (radius[i] + radius[j]) * 0.6, 8);
        const f = (k * k) / gap;
        dx[i] += (ex / d) * f;
        dy[i] += (ey / d) * f;
        dx[j] -= (ex / d) * f;
        dy[j] -= (ey / d) * f;
      }
    }
    for (const [a, b] of links) {
      const ex = x[a] - x[b];
      const ey = y[a] - y[b];
      const d = Math.max(Math.hypot(ex, ey), 0.01);
      const f = (d * d) / k;
      dx[a] -= (ex / d) * f;
      dy[a] -= (ey / d) * f;
      dx[b] += (ex / d) * f;
      dy[b] += (ey / d) * f;
    }
    for (let i = 0; i < n; i++) {
      // a little gravity keeps unconnected nodes from drifting off
      dx[i] -= x[i] * 0.02;
      dy[i] -= y[i] * 0.03;
      const d = Math.hypot(dx[i], dy[i]);
      if (d > 0) {
        x[i] += (dx[i] / d) * Math.min(d, t);
        y[i] += (dy[i] / d) * Math.min(d, t);
      }
    }
  }

  // remove overlaps: push pairs apart along the axis that needs the shorter move
  for (let pass = 0; pass < 200; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ox = (nodes[i].w + nodes[j].w) / 2 + margin - Math.abs(x[i] - x[j]);
        const oy = (nodes[i].h + nodes[j].h) / 2 + margin - Math.abs(y[i] - y[j]);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        if (ox < oy) {
          const s = (x[i] < x[j] || (x[i] === x[j] && i < j) ? -1 : 1) * (ox / 2 + 1);
          x[i] += s;
          x[j] -= s;
        } else {
          const s = (y[i] < y[j] || (y[i] === y[j] && i < j) ? -1 : 1) * (oy / 2 + 1);
          y[i] += s;
          y[j] -= s;
        }
      }
    }
    if (!moved) break;
  }

  const minX = Math.min(...nodes.map((v, i) => x[i] - v.w / 2));
  const minY = Math.min(...nodes.map((v, i) => y[i] - v.h / 2));
  return Object.fromEntries(nodes.map((v, i) => [v.id, { x: Math.round(x[i] - v.w / 2 - minX), y: Math.round(y[i] - v.h / 2 - minY) }]));
}
