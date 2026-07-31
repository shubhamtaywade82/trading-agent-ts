import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import { ConfigSchema, type Config } from "./schema.js";

export function loadConfig(path = "src/config/config.default.yaml", override?: any): Config {
  let base: any = {};
  if (existsSync(path)) {
    try {
      base = parse(readFileSync(path, "utf8")) ?? {};
    } catch {
      base = {};
    }
  }
  const merged = {
    ...base,
    ...override,
    paper: { ...(base.paper ?? {}), ...(override?.paper ?? {}) },
    risk: { ...(base.risk ?? {}), ...(override?.risk ?? {}) },
    execution: { ...(base.execution ?? {}), ...(override?.execution ?? {}) },
  };
  return ConfigSchema.parse(merged);
}
