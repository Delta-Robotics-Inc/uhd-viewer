/**
 * The G-code tab's URL entry (`?gcode=<url>`, PB-1192; checked at the wave 4 gate).
 *
 * DEFAULT: only a URL of the page's own origin (http or https) or a `blob:` URL the page made is fetched, so a
 * crafted link cannot make the viewer request another site, or carry the page's cookies to one. The tab's name is
 * the URL's last path part, decoded when it decodes (a stray `%` must not throw while the view renders).
 */
export function gcodeEntry(raw: string | null | undefined, base: string): { url: string; name: string } | undefined {
  if (!raw) return undefined;
  let here: URL;
  let u: URL;
  try {
    here = new URL(base);
    u = new URL(raw, here);
  } catch {
    return undefined;
  }
  if (u.protocol === "blob:") {
    if (!u.href.startsWith(`blob:${here.origin}/`)) return undefined;
  } else if ((u.protocol !== "http:" && u.protocol !== "https:") || u.origin !== here.origin) {
    return undefined;
  }
  const last = u.pathname.split("/").pop() ?? "";
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // kept as written
  }
  return { url: u.href, name };
}
