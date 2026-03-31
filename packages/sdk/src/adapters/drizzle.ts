import { trace, SpanKind, type Tracer } from "@opentelemetry/api";

/**
 * Options for the Glasstrace Drizzle logger.
 */
export interface GlasstraceDrizzleLoggerOptions {
  /** Whether to capture query parameters. Defaults to false (safe default). */
  captureParams?: boolean;
}

/**
 * Extracts the SQL operation (SELECT, INSERT, UPDATE, DELETE) from a query.
 * Returns 'unknown' if the operation cannot be determined.
 */
function extractOperation(query: string): string {
  const trimmed = query.trimStart().toUpperCase();
  if (trimmed.startsWith("SELECT")) return "SELECT";
  if (trimmed.startsWith("INSERT")) return "INSERT";
  if (trimmed.startsWith("UPDATE")) return "UPDATE";
  if (trimmed.startsWith("DELETE")) return "DELETE";
  return "unknown";
}

/**
 * Extracts the table name from a SQL query using best-effort regex.
 * Returns undefined if the table cannot be determined.
 */
function extractTable(query: string): string | undefined {
  // FROM table_name (SELECT, DELETE)
  const fromMatch = /\bFROM\s+["'`]?(\w+)["'`]?/i.exec(query);
  if (fromMatch) return fromMatch[1];

  // INSERT INTO table_name
  const insertMatch = /\bINSERT\s+INTO\s+["'`]?(\w+)["'`]?/i.exec(query);
  if (insertMatch) return insertMatch[1];

  // UPDATE table_name
  const updateMatch = /\bUPDATE\s+["'`]?(\w+)["'`]?/i.exec(query);
  if (updateMatch) return updateMatch[1];

  return undefined;
}

/**
 * Implements Drizzle's Logger interface to create OTel spans for Drizzle queries.
 *
 * Exported via `@glasstrace/sdk/drizzle` subpath to avoid bundling Drizzle
 * for Prisma-only users.
 *
 * When OTel is not initialized, tracer.startSpan() returns a no-op span
 * and the logger still executes without errors.
 */
export class GlasstraceDrizzleLogger {
  private readonly tracer: Tracer;
  private readonly captureParams: boolean;

  constructor(options?: GlasstraceDrizzleLoggerOptions) {
    this.tracer = trace.getTracer("glasstrace-drizzle");
    this.captureParams = options?.captureParams ?? false;
  }

  /**
   * Called by Drizzle ORM for each query execution.
   * Creates an OTel span with query metadata.
   */
  logQuery(query: string, params: unknown[]): void {
    const operation = extractOperation(query);
    const spanName =
      operation === "unknown" ? "drizzle.query" : `drizzle.${operation}`;

    const span = this.tracer.startSpan(spanName, {
      kind: SpanKind.CLIENT,
      attributes: {
        "db.system": "drizzle",
        "db.statement": query,
        "db.operation": operation,
        "glasstrace.orm.provider": "drizzle",
      },
    });

    // Table extraction
    const table = extractTable(query);
    if (table !== undefined) {
      span.setAttribute("db.sql.table", table);
    }

    // Param handling
    if (this.captureParams) {
      try {
        span.setAttribute("db.sql.params", JSON.stringify(params));
      } catch {
        span.setAttribute("db.sql.params", "[serialization_error]");
      }
    } else {
      span.setAttribute("db.sql.params", "[REDACTED]");
    }

    span.end();
  }
}
