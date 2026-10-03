/**
 * Development only: evidence files from the sibling UHD checkout's part
 * library, keyed by part id. main.tsx imports this behind
 * `import.meta.env.DEV`, so a production build never contains the library.
 */
import type { SourceRow, Verification } from "./evidence";

const SOURCES = import.meta.glob<SourceRow[]>("../../../uhd/library/parts/*/sources.json", { eager: true, import: "default" });
const VERIFICATION = import.meta.glob<Verification>("../../../uhd/library/parts/*/verification.json", { eager: true, import: "default" });

const byPart = <T,>(files: Record<string, T>) =>
  Object.fromEntries(Object.entries(files).map(([path, value]) => [path.split("/").slice(-2)[0], value]));

export const libraryEvidence = { sources: byPart(SOURCES), verification: byPart(VERIFICATION) };
