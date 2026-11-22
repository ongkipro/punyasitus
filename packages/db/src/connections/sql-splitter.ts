/**
 * Trigger-safe SQL migration statement splitter and checksum helper.
 * Handles `--` line comments, `/* ... *\/` block comments, quoted strings/identifiers,
 * and `CREATE [TEMP|TEMPORARY] TRIGGER ... BEGIN ... END;` blocks (including nested `CASE ... END`).
 */
export interface MigrationDescriptor {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum?: string;
}

export interface ApplyMigrationsResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly currentVersion: number;
}

function isIdentChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

function readWord(sql: string, index: number): { word: string; next: number } {
  let end = index;
  while (end < sql.length && isIdentChar(sql[end])) {
    end++;
  }
  return { word: sql.slice(index, end).toUpperCase(), next: end };
}

/**
 * Splits a multi-statement SQLite migration script into executable statements without
 * breaking on semicolons inside string literals, comments, or `CREATE TRIGGER ... BEGIN ... END` bodies.
 */
export function splitMigrationStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inTriggerHeader = false;
  let triggerBlockDepth = 0;

  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    // Line comment: -- ... \n
    if (ch === "-" && next === "-") {
      let end = i + 2;
      while (end < len && sql[end] !== "\n") {
        end++;
      }
      if (end < len && sql[end] === "\n") {
        end++;
      }
      i = end;
      continue;
    }

    // Block comment: /* ... */
    if (ch === "/" && next === "*") {
      let end = i + 2;
      while (end < len && !(sql[end] === "*" && sql[end + 1] === "/")) {
        end++;
      }
      i = end < len ? end + 2 : len;
      continue;
    }

    // Quoted literal or identifier: '...', "...", `...`
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let end = i + 1;
      while (end < len) {
        if (sql[end] === quote) {
          if (sql[end + 1] === quote) {
            end += 2;
            continue;
          }
          end++;
          break;
        }
        end++;
      }
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    // Bracket identifier: [...]
    if (ch === "[") {
      let end = i + 1;
      while (end < len && sql[end] !== "]") {
        end++;
      }
      if (end < len) end++;
      current += sql.slice(i, end);
      i = end;
      continue;
    }

    // Keyword tracking for CREATE [TEMP|TEMPORARY] TRIGGER ... BEGIN ... END
    if (isIdentChar(ch) && (i === 0 || !isIdentChar(sql[i - 1]))) {
      const { word, next: wordEnd } = readWord(sql, i);
      current += sql.slice(i, wordEnd);

      if (word === "TRIGGER" && triggerBlockDepth === 0) {
        // Confirm statement starts with CREATE [TEMP|TEMPORARY] TRIGGER
        const trimmed = current.trimStart().toUpperCase();
        if (/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/.test(trimmed)) {
          inTriggerHeader = true;
        }
      } else if (word === "BEGIN" && inTriggerHeader) {
        inTriggerHeader = false;
        triggerBlockDepth = 1;
      } else if (triggerBlockDepth > 0 && word === "CASE") {
        triggerBlockDepth++;
      } else if (triggerBlockDepth > 0 && word === "END") {
        triggerBlockDepth--;
      }

      i = wordEnd;
      continue;
    }

    // Statement terminator outside trigger body
    if (ch === ";" && triggerBlockDepth === 0) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        statements.push(trimmed);
      }
      current = "";
      inTriggerHeader = false;
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const tail = current.trim();
  if (tail.length > 0) {
    statements.push(tail);
  }
  return statements;
}

/**
 * Deterministic FNV-1a 64-bit hex checksum (runtime-free, synchronous, works in Node and workerd).
 */
export function computeMigrationChecksum(sql: string): string {
  const normalized = sql.replace(/\r\n/g, "\n").trim();
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= BigInt(normalized.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
