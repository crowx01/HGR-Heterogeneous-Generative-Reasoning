// guard.mjs — snapshot critical config files before a dispatch, restore them if the dispatch mutated them.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export function snapshotCritical(dir) {
  const snapshots = {};
  for (const name of ["models.json", "config.json"]) {
    try {
      snapshots[name] = existsSync(`${dir}/${name}`) ? readFileSync(`${dir}/${name}`, "utf8") : null;
    } catch { snapshots[name] = null; }
  }
  return {
    restore() {
      for (const name of ["models.json", "config.json"]) {
        try {
          const path = `${dir}/${name}`;
          const now = existsSync(path) ? readFileSync(path, "utf8") : null;
          const before = snapshots[name];
          const changed =
            (now !== null && before !== null && now !== before) ||
            (now === null && before !== null);
          if (changed) {
            writeFileSync(path, before);
            console.error("GUARD: restored " + name + " (dispatch mutated a critical file)");
          }
        } catch { /* never throw into the caller */ }
      }
    },
  };
}
