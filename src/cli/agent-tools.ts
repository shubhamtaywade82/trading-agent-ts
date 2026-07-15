import { Registry } from "../tools/registry.js";
import { ReadFileTool, WriteFileTool } from "../tools/filesystem.js";
import { ShellTool } from "../tools/shell.js";
import {
  ListDirectoryTool, DeleteFileTool, MakeDirectoryTool, CopyFileTool, MoveFileTool,
} from "../tools/directory-tools.js";
import { PatchTool, AppendTool } from "../tools/edit-tools.js";
import { SnapshotBackupTool } from "../tools/backup-tools.js";
import { WatchTool } from "../tools/watch-tool.js";
import { SearchCodeTool } from "../tools/search-tools.js";
import { GitTool } from "../tools/git-tools.js";
import { DockerTool } from "../tools/docker-tools.js";
import { GitHubTool } from "../tools/github-tools.js";
import { SqliteQueryTool } from "../tools/database-tools.js";
import { RunTestsTool, RunLintTool, RunFormatTool, RunBuildTool } from "../tools/project-tools.js";
import {
  BrowserNavigateTool, BrowserClickTool, BrowserFillTool,
  BrowserGetTextTool, BrowserScreenshotTool, BrowserEvaluateTool, BrowserCloseTool,
} from "../tools/browser-tools.js";
import { BrowserManager } from "../browser/manager.js";
import {
  BinancePublicApiTool, BinanceTechnicalIndicatorsTool, BinanceOrderBookTool,
  BinanceFuturesStatsTool, BinanceScreenerTool, BinanceWatchPriceTool,
  BinanceUnwatchPriceTool, BinancePriceAlertTool, BinanceLiquidationsTool,
} from "../tools/binance-tools.js";
import { BinanceStreamManager } from "../exchange/binance-stream.js";
import {
  BinanceBacktestTool, BinanceWalkForwardTool, BinanceMonteCarloTool, BinanceParamSweepTool,
} from "../tools/backtest-tools.js";
import { BinancePaperTradeTool } from "../tools/paper-trading-tools.js";
import { PaperTradingManager } from "../exchange/paper-trading.js";
import { connectMcpServer } from "../mcp/client.js";
import { Tool } from "../tools/tool.js";

export type ToolOnOutput = (stream: "stdout" | "stderr", chunk: string) => void;

export class AgentToolManager {
  readonly registry = new Registry();

  constructor() {}

  registerBaseTools(root: string, onOutput?: ToolOnOutput): void {
    const shellOpts: ConstructorParameters<typeof ShellTool>[0] = {
      workspaceRoot: root,
    };
    if (onOutput) shellOpts.onOutput = onOutput;

    this.registry
      .register(new ReadFileTool(root))
      .register(new WriteFileTool(root))
      .register(new ShellTool(shellOpts))
      .register(new ListDirectoryTool(root))
      .register(new DeleteFileTool(root))
      .register(new MakeDirectoryTool(root))
      .register(new CopyFileTool(root))
      .register(new MoveFileTool(root))
      .register(new PatchTool(root))
      .register(new AppendTool(root))
      .register(new SnapshotBackupTool(root))
      .register(new WatchTool(root))
      .register(new SearchCodeTool(root))
      .register(new GitTool(root))
      .register(new DockerTool(root))
      .register(new GitHubTool(root))
      .register(new SqliteQueryTool(root))
      .register(new RunTestsTool(root))
      .register(new RunLintTool(root))
      .register(new RunFormatTool(root))
      .register(new RunBuildTool(root))
      .register(new BinancePublicApiTool())
      .register(new BinanceTechnicalIndicatorsTool())
      .register(new BinanceOrderBookTool())
      .register(new BinanceFuturesStatsTool())
      .register(new BinanceScreenerTool())
      .register(new BinanceBacktestTool())
      .register(new BinanceWalkForwardTool())
      .register(new BinanceMonteCarloTool())
      .register(new BinanceParamSweepTool());
  }

  registerBinanceStreamTools(stream: BinanceStreamManager): void {
    this.registry
      .register(new BinanceWatchPriceTool(stream))
      .register(new BinanceUnwatchPriceTool(stream))
      .register(new BinancePriceAlertTool(stream))
      .register(new BinanceLiquidationsTool(stream));

    const paper = new PaperTradingManager(stream);
    this.registry.register(new BinancePaperTradeTool(paper));
  }

  registerBrowserTools(browser: BrowserManager): void {
    this.registry
      .register(new BrowserNavigateTool(browser))
      .register(new BrowserClickTool(browser))
      .register(new BrowserFillTool(browser))
      .register(new BrowserGetTextTool(browser))
      .register(new BrowserScreenshotTool(browser))
      .register(new BrowserEvaluateTool(browser))
      .register(new BrowserCloseTool(browser));
  }

  registerTool(tool: Tool): void {
    this.registry.register(tool);
  }

  async registerMcpServer(command: string, args: string[] = []): Promise<void> {
    const tools = await connectMcpServer(command, args);
    for (const tool of tools) this.registry.register(tool);
  }
}
