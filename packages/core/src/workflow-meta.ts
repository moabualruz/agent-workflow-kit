// Parsed Claude-style `meta` block. Required: name, description. Optional:
// whenToUse, model, phases (each {title, detail?, model?}).
export type WorkflowPhaseMeta = {
  title: string;
  detail?: string;
  model?: string;
};

export type WorkflowMeta = {
  name: string;
  description: string;
  whenToUse?: string;
  model?: string;
  phases?: WorkflowPhaseMeta[];
};

export type WorkflowMetaResult =
  | { ok: true; meta: WorkflowMeta }
  | { ok: false; error: string };

const META_LITERAL = /\bexport\s+const\s+meta\s*=\s*/;

// Extract and validate the meta literal from Claude-style source. The literal
// MUST be a pure literal — no variables, function calls, spreads, or template
// interpolation — matching Claude's contract. We enforce this by evaluating the
// expression with a strict literal parser. VM evaluation is intentionally
// avoided here: Node's vm module is not a security boundary, and meta parsing
// should accept only plain object/array/scalar literals.
export function parseWorkflowMeta(source: string): WorkflowMetaResult {
  const match = META_LITERAL.exec(source);
  if (!match) return { ok: false, error: "missing `export const meta = {…}`" };

  const start = match.index + match[0].length;
  const literal = extractBalancedObject(source, start);
  if (!literal) return { ok: false, error: "meta must be an object literal" };

  let value: unknown;
  try {
    value = new MetaLiteralParser(literal).parse();
  } catch (error) {
    return { ok: false, error: `meta must be a pure literal: ${error instanceof Error ? error.message : String(error)}` };
  }

  return validateMeta(value);
}

function validateMeta(value: unknown): WorkflowMetaResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: "meta must be an object" };
  }
  const record = value as Record<string, unknown>;
  if (record.name !== undefined && typeof record.name !== "string") {
    return { ok: false, error: "meta.name must be a string" };
  }
  if (record.description !== undefined && typeof record.description !== "string") {
    return { ok: false, error: "meta.description must be a string" };
  }

  // name/description are conventionally required by Claude; we default rather
  // than hard-fail so minimal saved workflows keep running, while still
  // enforcing the pure-literal structure and field types above.
  const meta: WorkflowMeta = {
    name: typeof record.name === "string" ? record.name : "",
    description: typeof record.description === "string" ? record.description : "",
  };
  if (record.whenToUse !== undefined) {
    if (typeof record.whenToUse !== "string") return { ok: false, error: "meta.whenToUse must be a string" };
    meta.whenToUse = record.whenToUse;
  }
  if (record.model !== undefined) {
    if (typeof record.model !== "string") return { ok: false, error: "meta.model must be a string" };
    meta.model = record.model;
  }
  if (record.phases !== undefined) {
    if (!Array.isArray(record.phases)) return { ok: false, error: "meta.phases must be an array" };
    const phases: WorkflowPhaseMeta[] = [];
    for (const entry of record.phases) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return { ok: false, error: "each meta.phases entry must be an object" };
      }
      const phase = entry as Record<string, unknown>;
      if (typeof phase.title !== "string" || !phase.title.trim()) {
        return { ok: false, error: "each meta.phases entry needs a title" };
      }
      const parsed: WorkflowPhaseMeta = { title: phase.title };
      if (phase.detail !== undefined) {
        if (typeof phase.detail !== "string") return { ok: false, error: "meta.phases[].detail must be a string" };
        parsed.detail = phase.detail;
      }
      if (phase.model !== undefined) {
        if (typeof phase.model !== "string") return { ok: false, error: "meta.phases[].model must be a string" };
        parsed.model = phase.model;
      }
      phases.push(parsed);
    }
    meta.phases = phases;
  }

  return { ok: true, meta };
}

function extractBalancedObject(source: string, start: number): string | undefined {
  let i = start;
  while (i < source.length && /\s/.test(source[i] ?? "")) i += 1;
  if (source[i] !== "{") return undefined;

  let depth = 0;
  let inString: string | undefined;
  for (let j = i; j < source.length; j += 1) {
    const ch = source[j];
    if (inString) {
      if (ch === inString && !isEscaped(source, j)) inString = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(i, j + 1);
    }
  }
  return undefined;
}

class MetaLiteralParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    const value = this.parseObject();
    this.skipTrivia();
    if (!this.isDone()) throw new Error("unexpected token after meta object");
    return value;
  }

  private parseValue(): unknown {
    this.skipTrivia();
    const ch = this.peek();
    if (ch === "{") return this.parseObject();
    if (ch === "[") return this.parseArray();
    if (ch === '"' || ch === "'") return this.parseString();
    if (ch === "`") throw new Error("no template strings");
    if (this.startsWith("...")) throw new Error("no spreads");
    if (ch === "-" || isDigit(ch)) return this.parseNumber();
    if (this.consumeWord("true")) return true;
    if (this.consumeWord("false")) return false;
    if (this.consumeWord("null")) return null;
    if (isIdentifierStart(ch)) {
      const word = this.parseIdentifier();
      this.skipTrivia();
      if (this.peek() === "(") throw new Error(`no function calls: ${word}`);
      throw new Error(`identifier values are not allowed: ${word}`);
    }
    if (ch === "(") throw new Error("no function calls");
    throw new Error(`unexpected token ${JSON.stringify(ch)}`);
  }

  private parseObject(): Record<string, unknown> {
    this.expect("{");
    const object: Record<string, unknown> = {};
    this.skipTrivia();
    if (this.consume("}")) return object;

    while (!this.isDone()) {
      this.skipTrivia();
      if (this.startsWith("...")) throw new Error("no spreads");
      const key = this.parsePropertyKey();
      this.skipTrivia();
      if (this.peek() === "(") throw new Error(`no function calls: ${key}`);
      this.expect(":");
      object[key] = this.parseValue();
      this.skipTrivia();
      if (this.consume("}")) return object;
      this.expect(",");
      this.skipTrivia();
      if (this.consume("}")) return object;
    }

    throw new Error("unterminated object literal");
  }

  private parseArray(): unknown[] {
    this.expect("[");
    const array: unknown[] = [];
    this.skipTrivia();
    if (this.consume("]")) return array;

    while (!this.isDone()) {
      this.skipTrivia();
      if (this.startsWith("...")) throw new Error("no spreads");
      array.push(this.parseValue());
      this.skipTrivia();
      if (this.consume("]")) return array;
      this.expect(",");
      this.skipTrivia();
      if (this.consume("]")) return array;
    }

    throw new Error("unterminated array literal");
  }

  private parsePropertyKey(): string {
    const ch = this.peek();
    if (ch === '"' || ch === "'") return this.parseString();
    if (!isIdentifierStart(ch)) throw new Error("object keys must be identifiers or quoted strings");
    return this.parseIdentifier();
  }

  private parseIdentifier(): string {
    const start = this.index;
    if (!isIdentifierStart(this.peek())) throw new Error("expected identifier");
    this.index += 1;
    while (isIdentifierPart(this.peek())) this.index += 1;
    return this.source.slice(start, this.index);
  }

  private parseString(): string {
    const quote = this.peek();
    this.index += 1;
    let value = "";

    while (!this.isDone()) {
      const ch = this.peek();
      this.index += 1;
      if (ch === quote) return value;
      if (ch !== "\\") {
        value += ch;
        continue;
      }

      if (this.isDone()) throw new Error("unterminated string escape");
      const escaped = this.peek();
      this.index += 1;
      switch (escaped) {
        case "b":
          value += "\b";
          break;
        case "f":
          value += "\f";
          break;
        case "n":
          value += "\n";
          break;
        case "r":
          value += "\r";
          break;
        case "t":
          value += "\t";
          break;
        case "v":
          value += "\v";
          break;
        case "0":
          value += "\0";
          break;
        case "\n":
          break;
        case "\r":
          if (this.peek() === "\n") this.index += 1;
          break;
        case "x":
          value += String.fromCharCode(this.readHex(2));
          break;
        case "u":
          value += this.parseUnicodeEscape();
          break;
        default:
          value += escaped;
      }
    }

    throw new Error("unterminated string literal");
  }

  private parseUnicodeEscape(): string {
    if (this.consume("{")) {
      const start = this.index;
      while (!this.isDone() && this.peek() !== "}") this.index += 1;
      if (!this.consume("}")) throw new Error("unterminated unicode escape");
      const hex = this.source.slice(start, this.index - 1);
      if (!/^[0-9A-Fa-f]+$/.test(hex)) throw new Error("invalid unicode escape");
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    return String.fromCharCode(this.readHex(4));
  }

  private readHex(length: number): number {
    const hex = this.source.slice(this.index, this.index + length);
    if (hex.length !== length || !new RegExp(`^[0-9A-Fa-f]{${length}}$`).test(hex)) {
      throw new Error("invalid hex escape");
    }
    this.index += length;
    return Number.parseInt(hex, 16);
  }

  private parseNumber(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.index));
    if (!match) throw new Error("invalid number literal");
    this.index += match[0].length;
    return Number(match[0]);
  }

  private skipTrivia(): void {
    while (!this.isDone()) {
      const ch = this.peek();
      if (/\s/.test(ch)) {
        this.index += 1;
        continue;
      }
      if (this.startsWith("//")) {
        this.index += 2;
        while (!this.isDone() && this.peek() !== "\n") this.index += 1;
        continue;
      }
      if (this.startsWith("/*")) {
        this.index += 2;
        while (!this.isDone() && !this.startsWith("*/")) this.index += 1;
        if (!this.consume("*/")) throw new Error("unterminated block comment");
        continue;
      }
      return;
    }
  }

  private consumeWord(word: string): boolean {
    if (!this.startsWith(word)) return false;
    const next = this.source[this.index + word.length] ?? "";
    if (isIdentifierPart(next)) return false;
    this.index += word.length;
    return true;
  }

  private expect(token: string): void {
    if (this.consume(token)) return;
    throw new Error(`expected ${JSON.stringify(token)} at offset ${this.index}`);
  }

  private consume(token: string): boolean {
    if (!this.startsWith(token)) return false;
    this.index += token.length;
    return true;
  }

  private startsWith(value: string): boolean {
    return this.source.startsWith(value, this.index);
  }

  private peek(): string {
    return this.source[this.index] ?? "";
  }

  private isDone(): boolean {
    return this.index >= this.source.length;
  }
}

function isEscaped(source: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === "\\"; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function isIdentifierStart(value: string): boolean {
  return /^[A-Za-z_$]$/.test(value);
}

function isIdentifierPart(value: string): boolean {
  return /^[\w$]$/.test(value);
}

function isDigit(value: string): boolean {
  return /^\d$/.test(value);
}

// Build per-phase and run-level model lookups for the runtime.
export function phaseModelMap(meta: WorkflowMeta | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const phase of meta?.phases ?? []) {
    if (phase.model) map.set(phase.title, phase.model);
  }
  return map;
}
