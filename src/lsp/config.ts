export interface LanguageOverrideConfig {
  enabled?: boolean;
  server?: string;
  args?: string[];
}

export interface LspGlobalConfig {
  idleTimeoutMs: number;
  maxServers: number;
  prewarm: string[];
}

export const DEFAULT_LSP_CONFIG: LspGlobalConfig = {
  idleTimeoutMs: 300_000,
  maxServers: 10,
  prewarm: [],
};

export function mergeLspConfig(
  userConfig?: Partial<LspGlobalConfig>,
): LspGlobalConfig {
  return {
    idleTimeoutMs: userConfig?.idleTimeoutMs ?? DEFAULT_LSP_CONFIG.idleTimeoutMs,
    maxServers: userConfig?.maxServers ?? DEFAULT_LSP_CONFIG.maxServers,
    prewarm: userConfig?.prewarm ?? DEFAULT_LSP_CONFIG.prewarm,
  };
}
