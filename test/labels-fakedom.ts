/**
 * A small stand-in DOM for the label and callout layers in node (R1-C): the viewer's tests run without jsdom and
 * no dependency is added for it. It covers what LabelLayer and AnnotLayer touch: elements with style, classList,
 * attributes, children, events (EventTarget), a fixed size, and a document with head, getElementById and
 * createElement(NS).
 */
export class FakeClassList {
  constructor(private el: FakeEl) {}
  private get list() {
    return this.el.className.split(/\s+/).filter(Boolean);
  }
  add(...cs: string[]) {
    this.el.className = [...new Set([...this.list, ...cs])].join(" ");
  }
  remove(...cs: string[]) {
    this.el.className = this.list.filter((c) => !cs.includes(c)).join(" ");
  }
  toggle(c: string, on?: boolean) {
    const want = on ?? !this.contains(c);
    if (want) this.add(c);
    else this.remove(c);
    return want;
  }
  contains(c: string) {
    return this.list.includes(c);
  }
  [Symbol.iterator]() {
    return this.list[Symbol.iterator]();
  }
}

export class FakeEl extends EventTarget {
  className = "";
  readonly classList = new FakeClassList(this);
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attrs = new Map<string, string>();
  children: FakeEl[] = [];
  parent: FakeEl | undefined;
  textContent = "";
  innerHTML = "";
  title = "";
  type = "";
  tabIndex = 0;
  onclick: ((e: { detail: number }) => void) | null = null;
  offsetWidth = 150;
  offsetHeight = 36;
  width = 0;
  height = 0;
  private picked = new Map<string, FakeEl>();
  constructor(
    readonly tagName: string,
    readonly ownerDocument: FakeDoc,
  ) {
    super();
  }
  appendChild<T extends FakeEl>(c: T): T {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  append(...cs: FakeEl[]) {
    for (const c of cs) this.appendChild(c);
  }
  prepend(...cs: FakeEl[]) {
    for (const c of cs) c.parent = this;
    this.children.unshift(...cs);
  }
  replaceChildren() {
    this.children = [];
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
  }
  setAttribute(k: string, v: string) {
    this.attrs.set(k, String(v));
    if (k === "class") this.className = String(v);
  }
  getAttribute(k: string) {
    return k === "class" ? this.className : (this.attrs.get(k) ?? null);
  }
  querySelector(sel: string) {
    let e = this.picked.get(sel);
    if (!e) this.picked.set(sel, (e = new FakeEl("span", this.ownerDocument)));
    return e;
  }
  getContext() {
    return null;
  }
  focus() {}
  blur() {}
  /** Every text below this element, in order (a card's visible words). */
  text(): string {
    return [this.textContent, ...this.children.map((c) => c.text())].filter(Boolean).join(" | ");
  }
  /** Descendants with a class. */
  find(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (e: FakeEl) => {
      if (e.classList.contains(cls)) out.push(e);
      e.children.forEach(walk);
    };
    walk(this);
    return out;
  }
}

export class FakeDoc {
  head: FakeEl;
  body: FakeEl;
  constructor() {
    this.head = new FakeEl("head", this);
    this.body = new FakeEl("body", this);
  }
  createElement(tag: string) {
    return new FakeEl(tag.toUpperCase(), this);
  }
  createElementNS(_ns: string, tag: string) {
    return new FakeEl(tag, this);
  }
  createTextNode(t: string) {
    const e = new FakeEl("#text", this);
    e.textContent = t;
    return e;
  }
  getElementById(id: string) {
    const walk = (e: FakeEl): FakeEl | undefined => (e.attrs.get("id") === id || (e as unknown as { id?: string }).id === id ? e : e.children.map(walk).find(Boolean));
    return walk(this.head) ?? null;
  }
}

/** Installs a fake `document` on globalThis for the duration of a test; returns it and the remover. */
export function installFakeDom(): { doc: FakeDoc; host: FakeEl; restore: () => void } {
  const g = globalThis as { document?: unknown };
  const before = g.document;
  const doc = new FakeDoc();
  g.document = doc;
  const host = doc.createElement("div");
  host.appendChild(doc.createElement("canvas"));
  return {
    doc,
    host,
    restore: () => {
      if (before === undefined) delete g.document;
      else g.document = before;
    },
  };
}

/** A WheelEvent stand-in (node has none): an Event with the fields the forwarder copies. */
export class FakeWheelEvent extends Event {
  deltaX: number;
  deltaY: number;
  deltaZ: number;
  deltaMode: number;
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  buttons: number;
  constructor(type: string, init: Partial<FakeWheelEvent> & EventInit = {}) {
    super(type, init);
    this.deltaX = init.deltaX ?? 0;
    this.deltaY = init.deltaY ?? 0;
    this.deltaZ = init.deltaZ ?? 0;
    this.deltaMode = init.deltaMode ?? 0;
    this.clientX = init.clientX ?? 0;
    this.clientY = init.clientY ?? 0;
    this.screenX = init.screenX ?? 0;
    this.screenY = init.screenY ?? 0;
    this.ctrlKey = init.ctrlKey ?? false;
    this.shiftKey = init.shiftKey ?? false;
    this.altKey = init.altKey ?? false;
    this.metaKey = init.metaKey ?? false;
    this.buttons = init.buttons ?? 0;
  }
}
