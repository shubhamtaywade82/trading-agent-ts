/**
 * Phase 1 — Rails workspace discovery. Cheap, synchronous fs checks that
 * classify a directory before any scanning happens. This is the single gate
 * for the whole RSI: non-Rails workspaces get a disabled index.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { EngineInfo, WorkspaceInfo } from "./types.js";

function readIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function detectEngines(root: string): EngineInfo[] {
  const engines: EngineInfo[] = [];
  const enginesDir = join(root, "engines");
  try {
    if (statSync(enginesDir).isDirectory()) {
      for (const entry of readdirSync(enginesDir)) {
        const enginePath = join(enginesDir, entry);
        if (existsSync(join(enginePath, "lib")) && statSync(enginePath).isDirectory()) {
          engines.push({ name: entry, path: join("engines", entry) });
        }
      }
    }
  } catch {
    // no engines/ directory
  }
  return engines;
}

export function discoverWorkspace(root: string): WorkspaceInfo {
  const gemfile = readIfExists(join(root, "Gemfile"));
  const lockfile = readIfExists(join(root, "Gemfile.lock"));
  const application = readIfExists(join(root, "config", "application.rb"));

  const isRuby = gemfile != null || existsSync(join(root, ".ruby-version"));
  const isRails =
    application != null &&
    /Rails::Application/.test(application) &&
    (gemfile != null || lockfile != null);

  const info: WorkspaceInfo = {
    root,
    isRails,
    isRuby,
    usesZeitwerk: false,
    apiOnly: false,
    testFramework: "unknown",
    engines: [],
  };
  if (!isRuby) return info;

  const lockRails = lockfile ? /^\s{4}rails \(([^)]+)\)/m.exec(lockfile) : null;
  const gemfileRails = gemfile ? /gem\s+["']rails["'],\s*["']~?>?=?\s*([\d.]+)["']/.exec(gemfile) : null;
  info.railsVersion = lockRails?.[1] ?? gemfileRails?.[1];

  const rubyVersionFile = readIfExists(join(root, ".ruby-version"));
  const gemfileRuby = gemfile ? /^ruby\s+["']([^"']+)["']/m.exec(gemfile) : null;
  info.rubyVersion = rubyVersionFile?.trim().replace(/^ruby-/, "") ?? gemfileRuby?.[1];

  const bundled = lockfile ? /BUNDLED WITH\n\s+([\d.]+)/.exec(lockfile) : null;
  info.bundlerVersion = bundled?.[1];

  if (isRails && application) {
    info.apiOnly = /config\.api_only\s*=\s*true/.test(application);
    const majorRails = info.railsVersion ? parseInt(info.railsVersion, 10) : 0;
    const classicOptIn = /config\.autoloader\s*=\s*:classic/.test(application);
    info.usesZeitwerk = majorRails >= 6 && !classicOptIn;
    info.engines = detectEngines(root);
  }

  if (existsSync(join(root, "spec"))) info.testFramework = "rspec";
  else if (existsSync(join(root, "test"))) info.testFramework = "minitest";

  return info;
}
