/**
 * Shared line-based Ruby source utilities used by every RSI scanner.
 *
 * This is deliberately not a full Ruby parser. Rails DSL macros are almost
 * always written one statement per line at a predictable nesting depth, so a
 * line-oriented reader that strips comments/heredocs, joins continuation
 * lines, and tracks class/module/do-end nesting covers real-world Rails code
 * without a native parser dependency.
 */

export interface LogicalLine {
  /** The joined, comment-stripped statement. */
  text: string;
  /** 1-based line number of the first physical line. */
  line: number;
  /** Nesting depth of block-opening keywords at this statement. */
  depth: number;
  /** Innermost `class`/`module` constant path enclosing this statement. */
  namespace: string[];
}

const BLOCK_OPENERS =
  /^(?:class|module|def|if|unless|case|while|until|for|begin)\b|(?:^|[\s)])do\s*(?:\|[^|]*\|)?\s*$/;
const MODIFIER_KEYWORD = /\b(?:if|unless|while|until)\b/;

/** Remove `#` comments while respecting string literals. */
export function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const prev = i > 0 ? line[i - 1] : "";
    if (ch === "'" && !inDouble && prev !== "\\") inSingle = !inSingle;
    else if (ch === '"' && !inSingle && prev !== "\\") inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      // `#{` interpolation only occurs inside a double-quoted string,
      // which is already excluded here.
      return line.slice(0, i);
    }
  }
  return line;
}

function unbalancedBrackets(text: string): number {
  let balance = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : "";
    if (ch === "'" && !inDouble && prev !== "\\") inSingle = !inSingle;
    else if (ch === '"' && !inSingle && prev !== "\\") inDouble = !inDouble;
    else if (!inSingle && !inDouble) {
      if (ch === "(" || ch === "[" || ch === "{") balance++;
      else if (ch === ")" || ch === "]" || ch === "}") balance--;
    }
  }
  return balance;
}

function isBlockOpener(text: string): boolean {
  if (!BLOCK_OPENERS.test(text)) return false;
  // `x = 1 if cond` style modifiers do not open a block.
  if (/^(?:if|unless|while|until)\b/.test(text)) return true;
  if (MODIFIER_KEYWORD.test(text) && !/^(?:class|module|def|case|for|begin)\b/.test(text) && !/\bdo\s*(?:\|[^|]*\|)?\s*$/.test(text)) {
    return false;
  }
  return true;
}

/**
 * Iterate logical statements of a Ruby file: comments and heredoc bodies
 * removed, trailing-comma / unbalanced-bracket continuations joined, with
 * nesting depth and enclosing class/module namespace tracked.
 */
export function logicalLines(source: string): LogicalLine[] {
  const physical = source.split(/\r?\n/);
  const out: LogicalLine[] = [];
  const nsStack: { name: string; depth: number }[] = [];
  let depth = 0;
  let heredocTag: string | null = null;
  let pending = "";
  let pendingLine = 0;

  for (let i = 0; i < physical.length; i++) {
    const raw = physical[i];

    if (heredocTag) {
      if (raw.trim() === heredocTag) heredocTag = null;
      continue;
    }

    let text = stripComment(raw).trim();
    if (!text && !pending) continue;

    if (pending) {
      text = `${pending} ${text}`.trim();
    } else {
      pendingLine = i + 1;
    }

    // Continuation: trailing comma/operator/backslash or unbalanced brackets.
    // (`|` only counts doubled — a single trailing `|` is a block parameter.)
    if (/(?:,|\\|\+|&&|\|\|)$/.test(text) || /\b(?:and|or)$/.test(text) || unbalancedBrackets(text) > 0) {
      pending = text.replace(/\\$/, "");
      continue;
    }
    pending = "";

    const heredoc = /<<[~-]?(["'`]?)([A-Z_][A-Z0-9_]*)\1/.exec(text);
    if (heredoc) heredocTag = heredoc[2];

    const classMatch = /^(?:class|module)\s+([A-Z][A-Za-z0-9_:]*)/.exec(text);
    const opensBlock = isBlockOpener(text);
    const isEnd = /^end\b/.test(text) || /^(?:end|})\s*$/.test(text);

    out.push({
      text,
      line: pendingLine,
      depth,
      namespace: nsStack.map((n) => n.name),
    });

    if (classMatch && !/<<\s*self/.test(text)) {
      nsStack.push({ name: classMatch[1], depth });
    }
    if (opensBlock) depth++;
    if (isEnd) {
      depth = Math.max(0, depth - 1);
      while (nsStack.length && nsStack[nsStack.length - 1].depth >= depth) {
        if (nsStack[nsStack.length - 1].depth === depth) {
          nsStack.pop();
          break;
        }
        nsStack.pop();
      }
    }
  }
  return out;
}

export interface MacroCall {
  /** Positional symbol/string args, unquoted (`:posts` → `posts`). */
  args: string[];
  /** `key: value` options with raw value text. */
  opts: Record<string, string>;
}

/**
 * Parse the argument list of a DSL macro line, e.g.
 * `has_many :posts, class_name: "Article", dependent: :destroy`.
 */
export function parseMacroArgs(argText: string): MacroCall {
  const args: string[] = [];
  const opts: Record<string, string> = {};
  for (const part of splitTopLevel(argText)) {
    const opt = /^([A-Za-z_][A-Za-z0-9_]*):(?!:)\s*(.+)$/.exec(part);
    if (opt) {
      opts[opt[1]] = opt[2].trim();
    } else {
      const sym = /^:([A-Za-z_][A-Za-z0-9_?!]*)$/.exec(part);
      const str = /^["']([^"']*)["']$/.exec(part);
      if (sym) args.push(sym[1]);
      else if (str) args.push(str[1]);
      else if (part) args.push(part);
    }
  }
  return { args, opts };
}

/** Split on top-level commas (ignores commas nested in brackets/strings). */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  let balance = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : "";
    if (ch === "'" && !inDouble && prev !== "\\") inSingle = !inSingle;
    else if (ch === '"' && !inSingle && prev !== "\\") inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (ch === "(" || ch === "[" || ch === "{") balance++;
      else if (ch === ")" || ch === "]" || ch === "}") balance--;
      if (ch === "," && balance === 0) {
        parts.push(current.trim());
        current = "";
        continue;
      }
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Extract symbols from `%i[a b]`, `[:a, :b]`, or a single `:a`. */
export function parseSymbolList(value: string): string[] {
  const pct = /^%i[[(]([^\])]*)[\])]$/.exec(value.trim());
  if (pct) return pct[1].split(/\s+/).filter(Boolean);
  const arr = /^\[(.*)\]$/.exec(value.trim());
  if (arr) {
    return splitTopLevel(arr[1])
      .map((p) => p.replace(/^:/, "").replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  const sym = /^:?([A-Za-z_][A-Za-z0-9_?!]*)$/.exec(value.trim());
  return sym ? [sym[1]] : [];
}

const IRREGULAR_SINGULARS: Record<string, string> = {
  people: "person",
  children: "child",
  men: "man",
  women: "woman",
  mice: "mouse",
  geese: "goose",
  feet: "foot",
  teeth: "tooth",
  data: "datum",
  media: "medium",
  criteria: "criterion",
  indices: "index",
  matrices: "matrix",
  vertices: "vertex",
  statuses: "status",
  addresses: "address",
  analyses: "analysis",
  taxes: "tax",
  quizzes: "quiz",
};

const UNCOUNTABLE = new Set(["equipment", "information", "money", "species", "series", "fish", "sheep", "metadata"]);

/** Rails-style singularization (small irregular table; conservative rules). */
export function singularize(word: string): string {
  const lower = word.toLowerCase();
  if (UNCOUNTABLE.has(lower)) return word;
  if (IRREGULAR_SINGULARS[lower]) return matchCase(IRREGULAR_SINGULARS[lower], word);
  if (/ies$/.test(lower) && lower.length > 3) return word.slice(0, -3) + "y";
  if (/(?:x|ch|sh|ss|zz)es$/.test(lower)) return word.slice(0, -2);
  if (/ves$/.test(lower)) return word.slice(0, -3) + "f";
  if (/s$/.test(lower) && !/(?:ss|us|is)$/.test(lower)) return word.slice(0, -1);
  return word;
}

function matchCase(result: string, original: string): string {
  return original[0] === original[0].toUpperCase()
    ? result[0].toUpperCase() + result.slice(1)
    : result;
}

/** `admin/user_accounts` → `Admin::UserAccounts`. */
export function camelize(snake: string): string {
  return snake
    .split("/")
    .map((seg) =>
      seg
        .split("_")
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(""),
    )
    .join("::");
}

/** `Admin::UserAccount` → `admin/user_account`. */
export function underscore(constant: string): string {
  return constant
    .split("::")
    .map((seg) => seg.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase())
    .join("/");
}

/** Association name → resolved class name (`:orders` → `Order`). */
export function classify(associationName: string, kind: "belongs_to" | "has_many" | "has_one" | "has_and_belongs_to_many"): string {
  const base = kind === "has_many" || kind === "has_and_belongs_to_many" ? singularize(associationName) : associationName;
  return camelize(base);
}

/** Strip surrounding quotes/symbol colon from a raw option value. */
export function unquote(value: string): string {
  return value.trim().replace(/^:/, "").replace(/^["']|["']$/g, "");
}
