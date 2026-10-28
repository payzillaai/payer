import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** True when this module is the script node was started with. Symlinks are resolved and a path with `#` or `%` works (comparing file URL strings did neither, and a tool that never started printed nothing and exited 0). */
export const isMain = (moduleUrl: string): boolean => {
  const a = process.argv[1]; if (a === undefined) return false;
  try { return realpathSync(a) === realpathSync(fileURLToPath(moduleUrl)); } catch { return false; }
};
