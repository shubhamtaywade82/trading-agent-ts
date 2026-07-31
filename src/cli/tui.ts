import chalk from "chalk";
import "dotenv/config";
import { marked } from "marked";
import type { Renderer } from "marked";
import TerminalRenderer from "marked-terminal";

// Setup marked terminal styling for premium aesthetics
marked.setOptions({
  renderer: new TerminalRenderer({
    code: chalk.yellow,
    blockquote: chalk.gray.italic,
    html: chalk.gray,
    heading: chalk.bold.cyan,
    firstHeading: chalk.bold.cyan,
    link: chalk.blue,
    href: chalk.blue.underline,
    listitem: (text: string) => ` • ${text}`,
    tab: 2,
  }) as unknown as Renderer,
});

export { startTui } from "./tui-main.js";
