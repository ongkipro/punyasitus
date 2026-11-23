/**
 * Strict SQLite tokenizer and namespace validator for Frozen-Core plugins
 * (REQ-097, ADR-0010, PLAN §19.7, TASK-097).
 *
 * Security invariants:
 * - Zero reliance on naive regexes that can be bypassed by SQL comments,
 *   quoted identifiers, multi-statement smuggling, parenthesized table refs,
 *   comma-joins after `JOIN ... ON`/`USING`/`INDEXED BY`/`NOT INDEXED`, CTE
 *   name shadowing, or triggers/views.
 * - Plugin IDs forbid `--` so `a--b` can never collide with `plg_a__*`.
 * - Plugin migrations may ONLY run additive DDL (`CREATE TABLE`, `ALTER TABLE ... ADD`,
 *   `CREATE [UNIQUE] INDEX`) targeting exclusively `plg_<snake_id>__*` identifiers.
 * - Plugin runtime queries may ONLY execute a single DML/query statement
 *   (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, or `WITH ...`) touching exclusively
 *   `plg_<snake_id>__*` tables (never core CMS tables, `_plugin_migrations`,
 *   `_tenant_migrations`, `installed_plugins`, or `sqlite_*` catalogs).
 */

export const BUILTIN_PLUGIN_PREFIX = "builtin:" as const;

// Forbids consecutive hyphens (`--`) so `a--b` cannot translate to `plg_a__b__` and collide with `a`
const PLUGIN_ID_RE = /^[a-z](?:[a-z0-9]|-(?!-)){1,46}[a-z0-9]$/;
const SAFE_SQL_IDENT_RE = /^[a-z][a-z0-9_]{0,127}$/;

export function isBuiltinPluginId(pluginId: string): boolean {
  return pluginId.trim().toLowerCase().startsWith(BUILTIN_PLUGIN_PREFIX);
}

export function isValidPluginId(pluginId: string): boolean {
  if (isBuiltinPluginId(pluginId)) return false;
  if (pluginId.includes("--")) return false;
  return PLUGIN_ID_RE.test(pluginId);
}

export function pluginIdToTablePrefix(pluginId: string): `plg_${string}__` {
  if (!isValidPluginId(pluginId)) {
    throw new PluginSqlViolationError(
      "INVALID_PLUGIN_ID",
      `Invalid plugin ID "${pluginId}" for table namespace derivation`,
    );
  }
  const snake = pluginId.replace(/-/g, "_");
  return `plg_${snake}__`;
}

export type PluginSqlViolationCode =
  | "INVALID_PLUGIN_ID"
  | "EMPTY_SQL"
  | "SYNTAX_ERROR"
  | "FORBIDDEN_KEYWORD"
  | "MULTI_STATEMENT_FORBIDDEN"
  | "DISALLOWED_STATEMENT"
  | "NAMESPACE_VIOLATION"
  | "SCHEMA_QUALIFIER_FORBIDDEN"
  | "SYSTEM_TABLE_FORBIDDEN";

export class PluginSqlViolationError extends Error {
  readonly code: PluginSqlViolationCode;

  constructor(code: PluginSqlViolationCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "PluginSqlViolationError";
    this.code = code;
  }
}

type SqlTokenKind = "word" | "quoted_ident" | "string" | "number" | "punct" | "semicolon";

interface SqlToken {
  readonly kind: SqlTokenKind;
  readonly raw: string;
  readonly upper: string;
  readonly value: string;
}

const FORBIDDEN_SYSTEM_IDENTIFIERS = new Set([
  "sqlite_master",
  "sqlite_schema",
  "sqlite_temp_master",
  "sqlite_temp_schema",
  "sqlite_sequence",
  "_tenant_migrations",
  "_plugin_migrations",
  "installed_plugins",
]);

const GLOBALLY_FORBIDDEN_KEYWORDS = new Set([
  "ATTACH",
  "DETACH",
  "PRAGMA",
  "VACUUM",
  "REINDEX",
  "LOAD_EXTENSION",
  "TRIGGER",
  "VIEW",
  "VIRTUAL",
  "TEMP",
  "TEMPORARY",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
  "EXPLAIN",
  "ANALYZE",
]);

const MIGRATION_FORBIDDEN_KEYWORDS = new Set([
  ...GLOBALLY_FORBIDDEN_KEYWORDS,
  "DROP",
  "RENAME",
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "SELECT",
  "WITH",
]);

const QUERY_FORBIDDEN_KEYWORDS = new Set([
  ...GLOBALLY_FORBIDDEN_KEYWORDS,
  "CREATE",
  "ALTER",
  "DROP",
  "RENAME",
  "REPLACE",
]);

const JOIN_START_KEYWORDS = new Set([
  "JOIN",
  "NATURAL",
  "LEFT",
  "RIGHT",
  "FULL",
  "INNER",
  "CROSS",
  "OUTER",
]);

const FROM_CLAUSE_STOP_KEYWORDS = new Set([
  "WHERE",
  "GROUP",
  "HAVING",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "SET",
  "VALUES",
  "RETURNING",
  "WINDOW",
  "DEFAULT",
  "SELECT",
  "INTO",
]);

const TABLE_ALIAS_STOP_KEYWORDS = new Set([
  ...FROM_CLAUSE_STOP_KEYWORDS,
  ...JOIN_START_KEYWORDS,
  "AS",
  "ON",
  "USING",
  "INDEXED",
  "NOT",
  "FROM",
]);

/**
 * Tokenizes SQLite SQL while cleanly stripping `--` and `/* ... *\/` comments
 * so comment smuggling can never obscure keywords or table identifiers.
 * Rejects NUL bytes, unclosed quotes, and unclosed block comments.
 */
function tokenizeSql(sql: string): SqlToken[] {
  if (sql.includes("\0")) {
    throw new PluginSqlViolationError("SYNTAX_ERROR", "NUL bytes are forbidden in plugin SQL");
  }

  const tokens: SqlToken[] = [];
  let i = 0;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (ch === "-" && next === "-") {
      i += 2;
      while (i < len && sql[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      let closed = false;
      while (i < len - 1) {
        if (sql[i] === "*" && sql[i + 1] === "/") {
          i += 2;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) {
        throw new PluginSqlViolationError("SYNTAX_ERROR", "Unclosed SQL block comment");
      }
      continue;
    }

    if (ch === "'") {
      let j = i + 1;
      let closed = false;
      let value = "";
      while (j < len) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            value += "'";
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        value += sql[j]!;
        j += 1;
      }
      if (!closed) {
        throw new PluginSqlViolationError("SYNTAX_ERROR", "Unclosed SQL string literal");
      }
      const raw = sql.slice(i, j);
      tokens.push({ kind: "string", raw, upper: "", value });
      i = j;
      continue;
    }

    if (ch === '"' || ch === "`") {
      const quote = ch;
      let j = i + 1;
      let closed = false;
      let value = "";
      while (j < len) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            value += quote;
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        value += sql[j]!;
        j += 1;
      }
      if (!closed) {
        throw new PluginSqlViolationError("SYNTAX_ERROR", "Unclosed quoted SQL identifier");
      }
      const raw = sql.slice(i, j);
      tokens.push({ kind: "quoted_ident", raw, upper: value.toUpperCase(), value });
      i = j;
      continue;
    }

    if (ch === "[") {
      let j = i + 1;
      let closed = false;
      let value = "";
      while (j < len) {
        if (sql[j] === "]") {
          closed = true;
          j += 1;
          break;
        }
        value += sql[j]!;
        j += 1;
      }
      if (!closed) {
        throw new PluginSqlViolationError("SYNTAX_ERROR", "Unclosed bracketed SQL identifier");
      }
      const raw = sql.slice(i, j);
      tokens.push({ kind: "quoted_ident", raw, upper: value.toUpperCase(), value });
      i = j;
      continue;
    }

    if (ch === ";") {
      tokens.push({ kind: "semicolon", raw: ";", upper: ";", value: ";" });
      i += 1;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[0-9._xXa-fA-F]/.test(sql[j]!)) {
        j += 1;
      }
      const raw = sql.slice(i, j);
      tokens.push({ kind: "number", raw, upper: raw.toUpperCase(), value: raw });
      i = j;
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      let j = i + 1;
      while (j < len && /[a-zA-Z0-9_$]/.test(sql[j]!)) {
        j += 1;
      }
      const raw = sql.slice(i, j);
      tokens.push({ kind: "word", raw, upper: raw.toUpperCase(), value: raw });
      i = j;
      continue;
    }

    tokens.push({ kind: "punct", raw: ch, upper: ch, value: ch });
    i += 1;
  }

  return tokens;
}

function splitTokensIntoStatements(tokens: readonly SqlToken[]): SqlToken[][] {
  const statements: SqlToken[][] = [];
  let current: SqlToken[] = [];
  for (const token of tokens) {
    if (token.kind === "semicolon") {
      if (current.length > 0) {
        statements.push(current);
        current = [];
      }
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) {
    statements.push(current);
  }
  return statements;
}

function isIdentToken(token: SqlToken | undefined): token is SqlToken {
  return token !== undefined && (token.kind === "word" || token.kind === "quoted_ident");
}

function findMatchingCloseParen(tokens: readonly SqlToken[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.kind === "punct" && tok.value === "(") {
      depth += 1;
    } else if (tok.kind === "punct" && tok.value === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new PluginSqlViolationError("SYNTAX_ERROR", "Unbalanced parenthesis in plugin SQL");
}

function assertPluginNamespacedIdentifier(
  prefix: `plg_${string}__`,
  token: SqlToken | undefined,
  nextToken: SqlToken | undefined,
  contextLabel: string,
): string {
  if (!isIdentToken(token)) {
    throw new PluginSqlViolationError(
      "SYNTAX_ERROR",
      `Expected ${contextLabel} identifier in plugin SQL`,
    );
  }

  if (nextToken?.kind === "punct" && nextToken.value === ".") {
    throw new PluginSqlViolationError(
      "SCHEMA_QUALIFIER_FORBIDDEN",
      `Schema-qualified ${contextLabel} "${token.value}.*" is forbidden in plugin SQL`,
    );
  }

  const normalized = token.value.toLowerCase();
  if (
    FORBIDDEN_SYSTEM_IDENTIFIERS.has(normalized) ||
    normalized.startsWith("sqlite_") ||
    normalized.startsWith("pragma_")
  ) {
    throw new PluginSqlViolationError(
      "SYSTEM_TABLE_FORBIDDEN",
      `Access to system or core table "${token.value}" is forbidden in plugin SQL`,
    );
  }

  if (!SAFE_SQL_IDENT_RE.test(normalized) || !normalized.startsWith(prefix)) {
    throw new PluginSqlViolationError(
      "NAMESPACE_VIOLATION",
      `${contextLabel} "${token.value}" must strictly start with "${prefix}"`,
    );
  }

  if (normalized.length <= prefix.length) {
    throw new PluginSqlViolationError(
      "NAMESPACE_VIOLATION",
      `${contextLabel} "${token.value}" must include a table/object suffix after "${prefix}"`,
    );
  }

  return normalized;
}

function assertNoForbiddenSystemIdentifiers(tokens: readonly SqlToken[]): void {
  for (const token of tokens) {
    if (token.kind !== "word" && token.kind !== "quoted_ident") continue;
    const lower = token.value.toLowerCase();
    if (
      FORBIDDEN_SYSTEM_IDENTIFIERS.has(lower) ||
      lower.startsWith("sqlite_") ||
      lower.startsWith("pragma_")
    ) {
      throw new PluginSqlViolationError(
        "SYSTEM_TABLE_FORBIDDEN",
        `Identifier "${token.value}" is forbidden in plugin SQL`,
      );
    }
  }
}

function assertForeignKeyReferencesNamespaced(
  prefix: `plg_${string}__`,
  tokens: readonly SqlToken[],
): void {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.kind === "word" && token.upper === "REFERENCES") {
      assertPluginNamespacedIdentifier(prefix, tokens[i + 1], tokens[i + 2], "foreign key target");
    }
  }
}

export interface ValidatedPluginMigrationSql {
  readonly pluginId: string;
  readonly tablePrefix: `plg_${string}__`;
  readonly statementCount: number;
  readonly touchedObjects: readonly string[];
}

/**
 * Strictly validates a plugin's additive SQLite migration SQL before any
 * execution or PITR bookmarking occurs.
 *
 * Allowed statements ONLY:
 * 1. `CREATE TABLE [IF NOT EXISTS] plg_<snake_id>__<name> (...)`
 * 2. `ALTER TABLE plg_<snake_id>__<name> ADD [COLUMN] ...`
 * 3. `CREATE [UNIQUE] INDEX [IF NOT EXISTS] plg_<snake_id>__<idx> ON plg_<snake_id>__<tbl> (...)`
 */
export function validatePluginMigrationSql(
  pluginId: string,
  sql: string,
): ValidatedPluginMigrationSql {
  const prefix = pluginIdToTablePrefix(pluginId);
  const tokens = tokenizeSql(sql);
  const statements = splitTokensIntoStatements(tokens);

  if (statements.length === 0) {
    throw new PluginSqlViolationError("EMPTY_SQL", "Plugin migration SQL cannot be empty");
  }

  const touchedObjects: string[] = [];

  for (const stmt of statements) {
    assertNoForbiddenSystemIdentifiers(stmt);

    for (const token of stmt) {
      if (token.kind === "word" && MIGRATION_FORBIDDEN_KEYWORDS.has(token.upper)) {
        throw new PluginSqlViolationError(
          "FORBIDDEN_KEYWORD",
          `Keyword "${token.upper}" is forbidden in plugin migrations`,
        );
      }
    }

    const head = stmt[0];
    if (!head || head.kind !== "word") {
      throw new PluginSqlViolationError(
        "DISALLOWED_STATEMENT",
        "Plugin migration statements must begin with CREATE or ALTER",
      );
    }

    if (head.upper === "CREATE") {
      let idx = 1;
      let isUnique = false;
      if (stmt[idx]?.kind === "word" && stmt[idx]!.upper === "UNIQUE") {
        isUnique = true;
        idx += 1;
      }

      const objectKind = stmt[idx];
      if (!objectKind || objectKind.kind !== "word") {
        throw new PluginSqlViolationError(
          "DISALLOWED_STATEMENT",
          "Invalid CREATE statement in plugin migration",
        );
      }

      if (objectKind.upper === "TABLE" && !isUnique) {
        idx += 1;
        if (
          stmt[idx]?.kind === "word" &&
          stmt[idx]!.upper === "IF" &&
          stmt[idx + 1]?.kind === "word" &&
          stmt[idx + 1]!.upper === "NOT" &&
          stmt[idx + 2]?.kind === "word" &&
          stmt[idx + 2]!.upper === "EXISTS"
        ) {
          idx += 3;
        }
        const tableName = assertPluginNamespacedIdentifier(
          prefix,
          stmt[idx],
          stmt[idx + 1],
          "table",
        );
        if (stmt[idx + 1]?.kind !== "punct" || stmt[idx + 1]!.value !== "(") {
          throw new PluginSqlViolationError(
            "DISALLOWED_STATEMENT",
            `CREATE TABLE "${tableName}" must use explicit column definitions`,
          );
        }
        assertForeignKeyReferencesNamespaced(prefix, stmt.slice(idx + 1));
        touchedObjects.push(tableName);
        continue;
      }

      if (objectKind.upper === "INDEX") {
        idx += 1;
        if (
          stmt[idx]?.kind === "word" &&
          stmt[idx]!.upper === "IF" &&
          stmt[idx + 1]?.kind === "word" &&
          stmt[idx + 1]!.upper === "NOT" &&
          stmt[idx + 2]?.kind === "word" &&
          stmt[idx + 2]!.upper === "EXISTS"
        ) {
          idx += 3;
        }
        const indexName = assertPluginNamespacedIdentifier(
          prefix,
          stmt[idx],
          stmt[idx + 1],
          "index",
        );
        idx += 1;
        if (stmt[idx]?.kind !== "word" || stmt[idx]!.upper !== "ON") {
          throw new PluginSqlViolationError(
            "SYNTAX_ERROR",
            `CREATE INDEX "${indexName}" must include ON <table_name>`,
          );
        }
        idx += 1;
        const tableName = assertPluginNamespacedIdentifier(
          prefix,
          stmt[idx],
          stmt[idx + 1],
          "indexed table",
        );
        touchedObjects.push(indexName, tableName);
        continue;
      }

      throw new PluginSqlViolationError(
        "DISALLOWED_STATEMENT",
        `CREATE ${objectKind.upper} is forbidden in plugin migrations (only TABLE and INDEX allowed)`,
      );
    }

    if (head.upper === "ALTER") {
      if (stmt[1]?.kind !== "word" || stmt[1]!.upper !== "TABLE") {
        throw new PluginSqlViolationError(
          "DISALLOWED_STATEMENT",
          "Only ALTER TABLE ... ADD COLUMN is allowed in plugin migrations",
        );
      }
      const tableName = assertPluginNamespacedIdentifier(prefix, stmt[2], stmt[3], "table");
      if (stmt[3]?.kind !== "word" || stmt[3]!.upper !== "ADD") {
        throw new PluginSqlViolationError(
          "DISALLOWED_STATEMENT",
          `ALTER TABLE "${tableName}" only permits additive ADD COLUMN clauses`,
        );
      }
      assertForeignKeyReferencesNamespaced(prefix, stmt.slice(4));
      touchedObjects.push(tableName);
      continue;
    }

    throw new PluginSqlViolationError(
      "DISALLOWED_STATEMENT",
      `Statement starting with "${head.upper}" is forbidden in plugin migrations`,
    );
  }

  return {
    pluginId,
    tablePrefix: prefix,
    statementCount: statements.length,
    touchedObjects,
  };
}

/**
 * Parses `WITH [RECURSIVE] <cte_name> [(cols)] AS [(...)] ...` and validates:
 * 1. EVERY CTE name MUST strictly start with `plg_<snake_id>__` (prevents CTE
 *    shadowing of core tables like `WITH leads AS (...) UPDATE leads ...` or
 *    `WITH leads AS (...) DELETE FROM leads`).
 * 2. Every CTE body is recursively validated by `validateQueryTokenRange`.
 */
function parseWithClause(
  prefix: `plg_${string}__`,
  stmt: readonly SqlToken[],
  touchedTables: string[],
): number {
  if (stmt[0]?.kind !== "word" || stmt[0]!.upper !== "WITH") {
    return 0;
  }

  let idx = 1;
  if (stmt[idx]?.kind === "word" && stmt[idx]!.upper === "RECURSIVE") {
    idx += 1;
  }

  while (idx < stmt.length) {
    // Strictly require every CTE name itself to be namespaced under `plg_<snake_id>__`!
    assertPluginNamespacedIdentifier(prefix, stmt[idx], stmt[idx + 1], "CTE name");
    idx += 1;

    // Optional column list `(col1, col2)`
    if (stmt[idx]?.kind === "punct" && stmt[idx]!.value === "(") {
      idx = findMatchingCloseParen(stmt, idx) + 1;
    }

    if (stmt[idx]?.kind !== "word" || stmt[idx]!.upper !== "AS") {
      throw new PluginSqlViolationError("SYNTAX_ERROR", "Expected AS after CTE name");
    }
    idx += 1;

    if (stmt[idx]?.kind === "word" && stmt[idx]!.upper === "NOT") idx += 1;
    if (stmt[idx]?.kind === "word" && stmt[idx]!.upper === "MATERIALIZED") idx += 1;

    if (stmt[idx]?.kind !== "punct" || stmt[idx]!.value !== "(") {
      throw new PluginSqlViolationError("SYNTAX_ERROR", "Expected '(' for CTE subquery");
    }

    const closeIdx = findMatchingCloseParen(stmt, idx);
    const bodyTokens = stmt.slice(idx + 1, closeIdx);
    validateQueryTokens(prefix, bodyTokens, touchedTables, true);
    idx = closeIdx + 1;

    if (stmt[idx]?.kind === "punct" && stmt[idx]!.value === ",") {
      idx += 1;
      continue;
    }
    break;
  }

  return idx;
}

/**
 * Validates SQLite's bare `expr [NOT] IN [schema.]table-name` and
 * `expr [NOT] IN table_valued_func(...)` syntax (when `IN` is NOT followed by `(`).
 */
function assertBareInTargetAllowed(
  prefix: `plg_${string}__`,
  tokens: readonly SqlToken[],
  inIdx: number,
  touchedTables: string[],
): boolean {
  const next = tokens[inIdx + 1];
  if (!next || (next.kind === "punct" && next.value === "(")) {
    return false;
  }
  if (
    isIdentToken(next) &&
    tokens[inIdx + 2]?.kind === "punct" &&
    tokens[inIdx + 2]!.value === "("
  ) {
    throw new PluginSqlViolationError(
      "DISALLOWED_STATEMENT",
      `Table-valued function "${next.value}()" is forbidden in IN clause`,
    );
  }
  const tbl = assertPluginNamespacedIdentifier(prefix, next, tokens[inIdx + 2], "IN target table");
  touchedTables.push(tbl);
  return true;
}

/**
 * Recursively parses a SQLite `FROM` / `JOIN` table-or-subquery list:
 *   table-or-subquery ( (',' | join-op) table-or-subquery (ON expr | USING (...))? )*
 *
 * Defeats EVERY bypass vector:
 * - Parenthesized tables: `FROM (leads)`, `FROM ((leads))`, `FROM plg_a__t JOIN (leads)`
 * - Parenthesized joins: `FROM (leads JOIN plg_a__t ON 1)`, `FROM (plg_a__t, leads)`
 * - Comma-joins after `JOIN ... ON expr`, `USING (...)`, `INDEXED BY idx`, `NOT INDEXED`
 * - Table-valued functions (`pragma_table_info(...)`)
 * - Nested subqueries inside `ON (...)` or `(SELECT ...)`
 */
function parseFromTableList(
  prefix: `plg_${string}__`,
  tokens: readonly SqlToken[],
  startIdx: number,
  touchedTables: string[],
): number {
  let idx = startIdx;

  while (idx < tokens.length) {
    const cur = tokens[idx];
    if (!cur) break;

    // 1. Parse single `table-or-subquery`
    if (cur.kind === "punct" && cur.value === "(") {
      const closeIdx = findMatchingCloseParen(tokens, idx);
      const inner = tokens.slice(idx + 1, closeIdx);
      if (inner.length === 0) {
        throw new PluginSqlViolationError("SYNTAX_ERROR", "Empty parenthesized expression in FROM");
      }
      const firstInner = inner[0]!;
      if (
        firstInner.kind === "word" &&
        (firstInner.upper === "SELECT" ||
          firstInner.upper === "WITH" ||
          firstInner.upper === "VALUES")
      ) {
        validateQueryTokens(prefix, inner, touchedTables, true);
      } else {
        // Parenthesized table or join expression: e.g. `(leads)`, `((leads))`, `(leads JOIN plg_a__t ON 1)`
        const consumed = parseFromTableList(prefix, inner, 0, touchedTables);
        if (consumed < inner.length) {
          throw new PluginSqlViolationError(
            "SYNTAX_ERROR",
            `Unexpected token "${inner[consumed]!.raw}" in parenthesized FROM clause`,
          );
        }
      }
      idx = closeIdx + 1;

      // Optional `[AS] alias`
      if (tokens[idx]?.kind === "word" && tokens[idx]!.upper === "AS") {
        idx += 2;
      } else if (
        isIdentToken(tokens[idx]) &&
        !(tokens[idx]!.kind === "word" && TABLE_ALIAS_STOP_KEYWORDS.has(tokens[idx]!.upper))
      ) {
        idx += 1;
      }
    } else {
      // Reject table-valued functions like `pragma_table_info('leads')` or `json_each(...)`
      if (
        isIdentToken(cur) &&
        tokens[idx + 1]?.kind === "punct" &&
        tokens[idx + 1]!.value === "("
      ) {
        throw new PluginSqlViolationError(
          "DISALLOWED_STATEMENT",
          `Table-valued function "${cur.value}()" is forbidden in plugin SQL`,
        );
      }

      const table = assertPluginNamespacedIdentifier(
        prefix,
        cur,
        tokens[idx + 1],
        "FROM/JOIN table",
      );
      touchedTables.push(table);
      idx += 1;

      // Optional `[AS] alias`
      if (tokens[idx]?.kind === "word" && tokens[idx]!.upper === "AS") {
        idx += 2;
      } else if (
        isIdentToken(tokens[idx]) &&
        !(tokens[idx]!.kind === "word" && TABLE_ALIAS_STOP_KEYWORDS.has(tokens[idx]!.upper))
      ) {
        idx += 1;
      }

      // Optional `INDEXED BY <plg_index>` or `NOT INDEXED`
      if (
        tokens[idx]?.kind === "word" &&
        tokens[idx]!.upper === "INDEXED" &&
        tokens[idx + 1]?.kind === "word" &&
        tokens[idx + 1]!.upper === "BY"
      ) {
        assertPluginNamespacedIdentifier(
          prefix,
          tokens[idx + 2],
          tokens[idx + 3],
          "INDEXED BY index",
        );
        idx += 3;
      } else if (
        tokens[idx]?.kind === "word" &&
        tokens[idx]!.upper === "NOT" &&
        tokens[idx + 1]?.kind === "word" &&
        tokens[idx + 1]!.upper === "INDEXED"
      ) {
        idx += 2;
      }
    }

    // 2. Consume optional join-constraint (`ON expr` or `USING (...)`)
    while (idx < tokens.length) {
      const constraintTok = tokens[idx];
      if (!constraintTok || constraintTok.kind !== "word") break;

      if (constraintTok.upper === "USING") {
        idx += 1;
        if (tokens[idx]?.kind !== "punct" || tokens[idx]!.value !== "(") {
          throw new PluginSqlViolationError("SYNTAX_ERROR", "Expected '(' after USING");
        }
        idx = findMatchingCloseParen(tokens, idx) + 1;
        continue;
      }

      if (constraintTok.upper === "ON") {
        idx += 1;
        // Scan ON expression at depth 0 until comma, next join-op, or FROM clause stop keyword
        while (idx < tokens.length) {
          const exprTok = tokens[idx]!;
          if (exprTok.kind === "punct" && exprTok.value === "(") {
            const closeIdx = findMatchingCloseParen(tokens, idx);
            scanParenthesizedSubqueries(prefix, tokens.slice(idx + 1, closeIdx), touchedTables);
            idx = closeIdx + 1;
            continue;
          }
          if (exprTok.kind === "punct" && (exprTok.value === "," || exprTok.value === ")")) {
            break;
          }
          if (
            exprTok.kind === "word" &&
            (JOIN_START_KEYWORDS.has(exprTok.upper) || FROM_CLAUSE_STOP_KEYWORDS.has(exprTok.upper))
          ) {
            break;
          }
          if (exprTok.kind === "word" && exprTok.upper === "IN") {
            if (assertBareInTargetAllowed(prefix, tokens, idx, touchedTables)) {
              idx += 2;
              continue;
            }
          }
          idx += 1;
        }
        continue;
      }

      break;
    }

    // 3. Check for comma-join `,` or explicit `[NATURAL] [LEFT|RIGHT|FULL|INNER|CROSS] [OUTER] JOIN`
    const sep = tokens[idx];
    if (!sep) break;

    if (sep.kind === "punct" && sep.value === ",") {
      idx += 1;
      continue;
    }

    if (sep.kind === "word" && JOIN_START_KEYWORDS.has(sep.upper)) {
      let sawJoin = false;
      while (
        idx < tokens.length &&
        tokens[idx]!.kind === "word" &&
        JOIN_START_KEYWORDS.has(tokens[idx]!.upper)
      ) {
        const kw = tokens[idx]!.upper;
        idx += 1;
        if (kw === "JOIN") {
          sawJoin = true;
          break;
        }
      }
      if (!sawJoin) {
        throw new PluginSqlViolationError("SYNTAX_ERROR", "Expected JOIN keyword in join operator");
      }
      continue;
    }

    break;
  }

  return idx;
}

/**
 * Recursively inspects any parenthesized expression for nested `(SELECT ...)` / `(WITH ...)` subqueries.
 */
function scanParenthesizedSubqueries(
  prefix: `plg_${string}__`,
  tokens: readonly SqlToken[],
  touchedTables: string[],
): void {
  if (tokens.length === 0) return;
  const first = tokens[0]!;
  if (first.kind === "word" && (first.upper === "SELECT" || first.upper === "WITH")) {
    validateQueryTokens(prefix, tokens, touchedTables, true);
    return;
  }

  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx]!;
    if (tok.kind === "punct" && tok.value === "(") {
      const closeIdx = findMatchingCloseParen(tokens, idx);
      scanParenthesizedSubqueries(prefix, tokens.slice(idx + 1, closeIdx), touchedTables);
      idx = closeIdx + 1;
      continue;
    }
    if (tok.kind === "word" && tok.upper === "IN") {
      if (assertBareInTargetAllowed(prefix, tokens, idx, touchedTables)) {
        idx += 2;
        continue;
      }
    }
    idx += 1;
  }
}

/**
 * Validates a full SQL statement or subquery token slice against `plg_<snake_id>__*`.
 */
function validateQueryTokens(
  prefix: `plg_${string}__`,
  stmt: readonly SqlToken[],
  touchedTables: string[],
  readOnlySubquery: boolean,
): "SELECT" | "INSERT" | "UPDATE" | "DELETE" {
  if (stmt.length === 0) {
    throw new PluginSqlViolationError("EMPTY_SQL", "Empty query or subquery in plugin SQL");
  }

  const bodyStartIndex = parseWithClause(prefix, stmt, touchedTables);
  const mainOp = stmt[bodyStartIndex];

  if (
    !mainOp ||
    mainOp.kind !== "word" ||
    (mainOp.upper !== "SELECT" &&
      mainOp.upper !== "VALUES" &&
      (readOnlySubquery ||
        (mainOp.upper !== "INSERT" && mainOp.upper !== "UPDATE" && mainOp.upper !== "DELETE")))
  ) {
    throw new PluginSqlViolationError(
      "DISALLOWED_STATEMENT",
      `Plugin runtime query must be SELECT, INSERT, UPDATE, or DELETE (got "${mainOp?.raw ?? ""}")`,
    );
  }

  let idx = bodyStartIndex;
  while (idx < stmt.length) {
    const token = stmt[idx]!;

    if (token.kind === "punct" && token.value === "(") {
      const closeIdx = findMatchingCloseParen(stmt, idx);
      scanParenthesizedSubqueries(prefix, stmt.slice(idx + 1, closeIdx), touchedTables);
      idx = closeIdx + 1;
      continue;
    }

    if (token.kind !== "word") {
      idx += 1;
      continue;
    }

    // `INSERT [OR ...] INTO <table>` — NEVER exempts CTEs!
    if (token.upper === "INSERT") {
      let targetIdx = idx + 1;
      if (stmt[targetIdx]?.kind === "word" && stmt[targetIdx]!.upper === "OR") {
        targetIdx += 2;
      }
      if (stmt[targetIdx]?.kind === "word" && stmt[targetIdx]!.upper === "INTO") {
        targetIdx += 1;
      }
      const tbl = assertPluginNamespacedIdentifier(
        prefix,
        stmt[targetIdx],
        stmt[targetIdx + 1],
        "INSERT target table",
      );
      touchedTables.push(tbl);
      idx = targetIdx + 1;
      continue;
    }

    // `UPDATE [OR ...] <table>` — NEVER exempts CTEs! (Ignore `DO UPDATE SET` in UPSERT)
    if (token.upper === "UPDATE") {
      const prev = stmt[idx - 1];
      if (prev?.kind === "word" && prev.upper === "DO") {
        idx += 1;
        continue;
      }
      let targetIdx = idx + 1;
      if (stmt[targetIdx]?.kind === "word" && stmt[targetIdx]!.upper === "OR") {
        targetIdx += 2;
      }
      const tbl = assertPluginNamespacedIdentifier(
        prefix,
        stmt[targetIdx],
        stmt[targetIdx + 1],
        "UPDATE target table",
      );
      touchedTables.push(tbl);
      idx = targetIdx + 1;
      continue;
    }

    // `DELETE FROM <table>` — validate target directly without any CTE exemption
    if (token.upper === "DELETE") {
      if (stmt[idx + 1]?.kind !== "word" || stmt[idx + 1]!.upper !== "FROM") {
        throw new PluginSqlViolationError("SYNTAX_ERROR", "Expected FROM after DELETE");
      }
      const tbl = assertPluginNamespacedIdentifier(
        prefix,
        stmt[idx + 2],
        stmt[idx + 3],
        "DELETE target table",
      );
      touchedTables.push(tbl);
      idx += 3;
      continue;
    }

    // `FROM <table-or-subquery-list>` (covers SELECT ... FROM, UPDATE ... FROM, UNION SELECT ... FROM)
    if (token.upper === "FROM") {
      idx = parseFromTableList(prefix, stmt, idx + 1, touchedTables);
      continue;
    }

    // Bare SQLite `expr [NOT] IN [schema.]table-name` / `expr [NOT] IN func(...)`
    if (token.upper === "IN") {
      if (assertBareInTargetAllowed(prefix, stmt, idx, touchedTables)) {
        idx += 2;
        continue;
      }
    }

    idx += 1;
  }

  return (mainOp.upper === "VALUES" ? "SELECT" : mainOp.upper) as
    | "SELECT"
    | "INSERT"
    | "UPDATE"
    | "DELETE";
}

export interface ValidatedPluginQuerySql {
  readonly pluginId: string;
  readonly tablePrefix: `plg_${string}__`;
  readonly operation: "SELECT" | "INSERT" | "UPDATE" | "DELETE";
  readonly touchedTables: readonly string[];
}

/**
 * Strictly validates a single runtime SQL query executed through a plugin's
 * scoped `TenantStore` handle (`PluginTenantDb`).
 */
export function validatePluginQuerySql(
  pluginId: string,
  sql: string,
): ValidatedPluginQuerySql {
  const prefix = pluginIdToTablePrefix(pluginId);
  const tokens = tokenizeSql(sql);
  const statements = splitTokensIntoStatements(tokens);

  if (statements.length === 0) {
    throw new PluginSqlViolationError("EMPTY_SQL", "Plugin SQL query cannot be empty");
  }
  if (statements.length > 1) {
    throw new PluginSqlViolationError(
      "MULTI_STATEMENT_FORBIDDEN",
      "Plugin runtime queries must contain exactly one SQL statement",
    );
  }

  const stmt = statements[0]!;
  assertNoForbiddenSystemIdentifiers(stmt);

  for (const token of stmt) {
    if (token.kind === "word" && QUERY_FORBIDDEN_KEYWORDS.has(token.upper)) {
      throw new PluginSqlViolationError(
        "FORBIDDEN_KEYWORD",
        `Keyword "${token.upper}" is forbidden in plugin runtime queries`,
      );
    }
  }

  const touchedTables: string[] = [];
  const operation = validateQueryTokens(prefix, stmt, touchedTables, false);

  return {
    pluginId,
    tablePrefix: prefix,
    operation,
    touchedTables,
  };
}
