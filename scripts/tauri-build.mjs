import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const executable = join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tauri.cmd" : "tauri",
);
const env = { ...process.env };

// Tauri's DMG creator otherwise drives Finder through AppleScript. That is
// nondeterministic in headless shells and can block until an AppleEvent timeout.
// CI mode selects create-dmg's supported --skip-jenkins path on macOS.
if (process.platform === "darwin") {
  env.CI = "true";
  delete env.TAURI_BUNDLER_DMG_IGNORE_CI;
}

const result = spawnSync(executable, ["build", ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
