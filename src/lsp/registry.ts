export interface LanguageProviderConfig {
  id: string;
  language: string;
  extensions: string[];
  serverCommand: string;
  serverArgs: string[];
  formatter?: string;
  linter?: string;
  testRunner?: string;
  buildTool?: string;
}

export const BUILTIN_REGISTRY: LanguageProviderConfig[] = [
  {
    id: "typescript",
    language: "TypeScript",
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    serverCommand: "typescript-language-server",
    serverArgs: ["--stdio"],
    formatter: "prettier",
    linter: "eslint",
    testRunner: "vitest",
    buildTool: "tsc",
  },
  {
    id: "ruby",
    language: "Ruby",
    extensions: [".rb", ".erb", ".rake", ".gemspec"],
    serverCommand: "ruby-lsp",
    // ruby-lsp speaks LSP over stdio by default and rejects a --stdio flag
    serverArgs: [],
    linter: "rubocop",
    testRunner: "rspec",
  },
  {
    id: "python",
    language: "Python",
    extensions: [".py", ".pyi"],
    serverCommand: "pyright",
    serverArgs: ["--stdio"],
    linter: "ruff",
    testRunner: "pytest",
  },
  {
    id: "go",
    language: "Go",
    extensions: [".go"],
    serverCommand: "gopls",
    serverArgs: ["--stdio"],
    testRunner: "go test",
    buildTool: "go build",
  },
  {
    id: "rust",
    language: "Rust",
    extensions: [".rs"],
    serverCommand: "rust-analyzer",
    serverArgs: ["--stdio"],
    buildTool: "cargo",
    testRunner: "cargo test",
  },
  {
    id: "java",
    language: "Java",
    extensions: [".java"],
    serverCommand: "jdtls",
    serverArgs: ["--stdio"],
    buildTool: "mvn",
  },
  {
    id: "csharp",
    language: "C#",
    extensions: [".cs", ".csx"],
    serverCommand: "omnisharp",
    serverArgs: ["--stdio"],
    buildTool: "dotnet",
  },
  {
    id: "cpp",
    language: "C++",
    extensions: [".cpp", ".c", ".h", ".hpp", ".cc", ".cxx", ".hh", ".hxx"],
    serverCommand: "clangd",
    serverArgs: ["--stdio"],
    buildTool: "cmake",
  },
  {
    id: "php",
    language: "PHP",
    extensions: [".php"],
    serverCommand: "intelephense",
    serverArgs: ["--stdio"],
  },
  {
    id: "swift",
    language: "Swift",
    extensions: [".swift"],
    serverCommand: "sourcekit-lsp",
    serverArgs: ["--stdio"],
    buildTool: "swift build",
  },
  {
    id: "kotlin",
    language: "Kotlin",
    extensions: [".kt", ".kts"],
    serverCommand: "kotlin-language-server",
    serverArgs: ["--stdio"],
    buildTool: "gradle",
  },
  {
    id: "dart",
    language: "Dart",
    extensions: [".dart"],
    serverCommand: "dart",
    serverArgs: ["language-server", "--protocol=stdio"],
    testRunner: "dart test",
  },
  {
    id: "yaml",
    language: "YAML",
    extensions: [".yaml", ".yml"],
    serverCommand: "yaml-language-server",
    serverArgs: ["--stdio"],
  },
  {
    id: "dockerfile",
    language: "Dockerfile",
    extensions: ["Dockerfile", ".dockerfile"],
    serverCommand: "docker-langserver",
    serverArgs: ["--stdio"],
  },
  {
    id: "json",
    language: "JSON",
    extensions: [".json", ".jsonc"],
    serverCommand: "vscode-json-language-server",
    serverArgs: ["--stdio"],
  },
];

export class LanguageRegistry {
  private readonly extMap = new Map<string, LanguageProviderConfig>();
  private readonly idMap = new Map<string, LanguageProviderConfig>();

  constructor(userOverrides?: Record<string, Partial<LanguageProviderConfig>>) {
    for (const provider of BUILTIN_REGISTRY) {
      this.register(provider);
    }
    if (userOverrides) {
      for (const [id, override] of Object.entries(userOverrides)) {
        const existing = this.idMap.get(id);
        if (existing) {
          const merged = { ...existing, ...override, extensions: override.extensions ?? existing.extensions };
          this.register(merged);
        } else if (override.serverCommand) {
          this.register(override as LanguageProviderConfig);
        }
      }
    }
  }

  private register(provider: LanguageProviderConfig): void {
    this.idMap.set(provider.id, provider);
    for (const ext of provider.extensions) {
      this.extMap.set(ext, provider);
    }
    for (const ext of provider.extensions) {
      if (ext.startsWith(".")) {
        this.extMap.set(ext.toLowerCase(), provider);
      }
    }
  }

  getProviderForExtension(extension: string): LanguageProviderConfig | undefined {
    const key = extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
    let provider = this.extMap.get(key);
    if (!provider) {
      provider = this.extMap.get(extension);
    }
    return provider;
  }

  getProviderForFile(filePath: string): LanguageProviderConfig | undefined {
    const idx = filePath.lastIndexOf(".");
    if (idx < 0) {
      const basename = filePath.split("/").pop() ?? filePath;
      return this.extMap.get(basename);
    }
    const ext = filePath.slice(idx);
    const provider = this.extMap.get(ext);
    if (provider) return provider;
    const basename = filePath.split("/").pop() ?? "";
    return this.extMap.get(basename);
  }

  getProviderById(id: string): LanguageProviderConfig | undefined {
    return this.idMap.get(id);
  }

  allProviders(): LanguageProviderConfig[] {
    return [...this.idMap.values()];
  }
}
