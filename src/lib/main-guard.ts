import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";

/** True when this module is the script node was started with. Symlinks are resolved and a path with `#` or `%` works (comparing file URL strings did neither, and a tool that never started printed nothing and exited 0). */
/** The module's path as a person would type it from the current folder (usage lines show the real path, in the private repo or the public one). */
export const scriptPath = (moduleUrl: string): string => { const abs = fileURLToPath(moduleUrl), rel = relative(process.cwd(), abs); return rel && !rel.startsWith("..") ? rel : abs; };

export const isMain = (moduleUrl: string): boolean => {
  const a = process.argv[1]; if (a === undefined) return false;
  try { return realpathSync(a) === realpathSync(fileURLToPath(moduleUrl)); } catch { return false; }
};
