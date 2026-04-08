import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { trace, SpanKind } from "@opentelemetry/api";
import { GlasstraceDrizzleLogger } from "../../../packages/sdk/src/adapters/drizzle.js";

describe("GlasstraceDrizzleLogger", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    const processor = new SimpleSpanProcessor(exporter);
    provider = new BasicTracerProvider({ spanProcessors: [processor] });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await provider.shutdown();
    trace.disable();
  });

  describe("implements Logger interface", () => {
    it("has logQuery method", () => {
      const logger = new GlasstraceDrizzleLogger();
      expect(typeof logger.logQuery).toBe("function");
    });

    it("logQuery creates a span", () => {
      const logger = new GlasstraceDrizzleLogger();
      logger.logQuery("SELECT * FROM users", []);

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("constructor options", () => {
    it("defaults captureParams to false", () => {
      const logger = new GlasstraceDrizzleLogger();
      logger.logQuery("SELECT * FROM users WHERE id = $1", [42]);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.sql.params"]).toBe("[REDACTED]");
    });

    it("accepts captureParams option", () => {
      const logger = new GlasstraceDrizzleLogger({ captureParams: true });
      logger.logQuery("SELECT * FROM users WHERE id = $1", [42]);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.sql.params"]).toBe("[42]");
    });
  });

  describe("span attributes", () => {
    it("sets db.system to drizzle", () => {
      const logger = new GlasstraceDrizzleLogger();
      logger.logQuery("SELECT 1", []);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.system"]).toBe("drizzle");
    });

    it("sets db.statement to the query", () => {
      const query = "SELECT * FROM users WHERE id = $1";
      const logger = new GlasstraceDrizzleLogger();
      logger.logQuery(query, []);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.statement"]).toBe(query);
    });

    it("sets span kind to CLIENT", () => {
      const logger = new GlasstraceDrizzleLogger();
      logger.logQuery("SELECT 1", []);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.kind).toBe(SpanKind.CLIENT);
    });

    it("sets glasstrace.orm.provider to drizzle", () => {
      const logger = new GlasstraceDrizzleLogger();
      logger.logQuery("SELECT 1", []);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["glasstrace.orm.provider"]).toBe("drizzle");
    });
  });

  describe("db.operation extraction", () => {
    it("extracts SELECT operation", () => {
      const logger = new GlasstraceDrizzleLogger();
      logger.logQuery("SELECT * FROM users", []);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.operation"]).toBe("SELECT");
    });

    it("extracts INSERT operation", () => {
      const logger = new GlasstraceDrizzleLogger();
      logger.logQuery("INSERT INTO users (name) VALUES ($1)", ["test"]);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.operation"]).toBe("INSERT");
    });

    it("extracts UPDATE operation", () => {
      const logger = new GlasstraceDrizzleLogger();
      logger.logQuery("UPDATE users SET name = $1 WHERE id = $2", [
        "test",
        1,
      ]);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.operation"]).toBe("UPDATE");
    });

    it("extracts DELETE operation", () => {
      const logger = new GlasstraceDrizzleLogger();
      logger.logQuery("DELETE FROM users WHERE id = $1", [1]);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.operation"]).toBe("DELETE");
    });

    it("sets operation to unknown for unrecognized queries", () => {
      const logger = new GlasstraceDrizzleLogger();
      logger.logQuery("EXPLAIN ANALYZE SELECT 1", []);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.operation"]).toBe("unknown");
    });

    it("uses drizzle.{operation} as span name when extractable", () => {
      const logger = new GlasstraceDrizzleLogger();
      logger.logQuery("SELECT * FROM users", []);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.name).toBe("drizzle.SELECT");
    });

    it("uses drizzle.query as span name for unknown operations", () => {
      const logger = new GlasstraceDrizzleLogger();
      logger.logQuery("EXPLAIN ANALYZE SELECT 1", []);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.name).toBe("drizzle.query");
    });
  });

  describe("table name extraction", () => {
    it("extracts table from SELECT ... FROM", () => {
      const logger = new GlasstraceDrizzleLogger();
      logger.logQuery("SELECT * FROM users WHERE id = $1", [1]);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.sql.table"]).toBe("users");
    });

    it("extracts table from INSERT INTO", () => {
      const logger = new GlasstraceDrizzleLogger();
      logger.logQuery("INSERT INTO orders (total) VALUES ($1)", [100]);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.sql.table"]).toBe("orders");
    });

    it("extracts table from UPDATE", () => {
      const logger = new GlasstraceDrizzleLogger();
      logger.logQuery("UPDATE products SET price = $1", [9.99]);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.sql.table"]).toBe("products");
    });

    it("extracts table from DELETE FROM", () => {
      const logger = new GlasstraceDrizzleLogger();
      logger.logQuery("DELETE FROM sessions WHERE expired = true", []);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.sql.table"]).toBe("sessions");
    });

    it("omits db.sql.table for unrecognized queries", () => {
      const logger = new GlasstraceDrizzleLogger();
      logger.logQuery("SET timezone = 'UTC'", []);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.sql.table"]).toBeUndefined();
    });
  });

  describe("param handling", () => {
    it("redacts params when captureParams is false", () => {
      const logger = new GlasstraceDrizzleLogger({ captureParams: false });
      logger.logQuery("SELECT * FROM users WHERE id = $1", [42]);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.sql.params"]).toBe("[REDACTED]");
    });

    it("captures params when captureParams is true", () => {
      const logger = new GlasstraceDrizzleLogger({ captureParams: true });
      logger.logQuery("SELECT * FROM users WHERE id = $1 AND name = $2", [
        42,
        "test",
      ]);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.sql.params"]).toBe('[42,"test"]');
    });

    it("error case: handles non-serializable params gracefully", () => {
      const logger = new GlasstraceDrizzleLogger({ captureParams: true });
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      logger.logQuery("SELECT 1", [circular]);

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.sql.params"]).toBe("[serialization_error]");
    });
  });

  describe("error case: OTel not initialized", () => {
    it("logQuery does not throw when no TracerProvider is registered", async () => {
      // Shut down the current provider and disable global
      await provider.shutdown();
      trace.disable();

      const logger = new GlasstraceDrizzleLogger();
      expect(() => {
        logger.logQuery("SELECT 1", []);
      }).not.toThrow();
    });
  });

  describe("error case: malformed SQL", () => {
    it("handles empty query string", () => {
      const logger = new GlasstraceDrizzleLogger();
      expect(() => {
        logger.logQuery("", []);
      }).not.toThrow();

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.operation"]).toBe("unknown");
    });

    it("handles SQL with quoted identifiers", () => {
      const logger = new GlasstraceDrizzleLogger();
      expect(() => {
        logger.logQuery('SELECT * FROM "user-accounts" WHERE "first-name" = $1', ["Alice"]);
      }).not.toThrow();

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.operation"]).toBe("SELECT");
    });

    it("handles SQL with unicode characters", () => {
      const logger = new GlasstraceDrizzleLogger();
      expect(() => {
        logger.logQuery("SELECT * FROM users WHERE name = $1", ["\u{1F600}"]);
      }).not.toThrow();

      const spans = exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThanOrEqual(1);
      const span = spans[spans.length - 1];
      expect(span.attributes["db.operation"]).toBe("SELECT");
    });

    it("handles very long queries", () => {
      const logger = new GlasstraceDrizzleLogger();
      const longQuery = "SELECT " + "col, ".repeat(500) + "id FROM very_wide_table";
      expect(() => {
        logger.logQuery(longQuery, []);
      }).not.toThrow();

      const spans = exporter.getFinishedSpans();
      const span = spans[spans.length - 1];
      expect(span.attributes["db.statement"]).toBe(longQuery);
    });
  });

  describe("post-shutdown safety", () => {
    it("logQuery does not throw after provider has been shut down", async () => {
      const logger = new GlasstraceDrizzleLogger();

      // Shut down the provider
      await provider.shutdown();

      // Logging after shutdown should be safe (no crash)
      expect(() => {
        logger.logQuery("SELECT 1", []);
      }).not.toThrow();
    });
  });
});
