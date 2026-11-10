import mysql, { type Pool } from "mysql2/promise";

type BoundValue = string | number | boolean | null | Uint8Array | Date;

export type D1RunResult = {
  success: true;
  meta: {
    changes: number;
    last_row_id: number;
  };
};

export type D1AllResult<T> = {
  success: true;
  results: T[];
};

/**
 * Keep the existing D1-shaped storage calls small while the application runs
 * on MySQL. Only the SQL used by XLLoop is translated here; arbitrary SQLite
 * syntax is intentionally not accepted as a portability promise.
 */
export function normalizeMysqlSql(sql: string): string {
  return sql
    .replace(/\bINSERT\s+OR\s+IGNORE\b/gi, "INSERT IGNORE")
    .replace(
      /COALESCE\(\s*json_extract\(\s*payload\s*,\s*'\$\.lastHeartbeat'\s*\)\s*,\s*''\s*\)/gi,
      "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.lastHeartbeat')), '')",
    );
}

class MysqlPreparedStatement {
  constructor(
    private readonly database: MysqlD1Database,
    private readonly sql: string,
    private readonly values: BoundValue[] = [],
  ) {}

  bind(...values: BoundValue[]) {
    return new MysqlPreparedStatement(this.database, this.sql, values);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const [rows] = await this.database.pool().execute(
      normalizeMysqlSql(this.sql),
      this.values,
    );
    if (!Array.isArray(rows)) {
      throw new Error("Expected a row result from MySQL");
    }
    return (rows[0] as T | undefined) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1AllResult<T>> {
    const [rows] = await this.database.pool().execute(
      normalizeMysqlSql(this.sql),
      this.values,
    );
    if (!Array.isArray(rows)) {
      throw new Error("Expected a row result from MySQL");
    }
    return { success: true, results: rows as T[] };
  }

  async run(): Promise<D1RunResult> {
    const [result] = await this.database.pool().execute(
      normalizeMysqlSql(this.sql),
      this.values,
    );
    if (Array.isArray(result)) {
      throw new Error("Expected a write result from MySQL");
    }
    const write = result as { affectedRows?: number; insertId?: number };
    return {
      success: true,
      meta: {
        changes: Number(write.affectedRows ?? 0),
        last_row_id: Number(write.insertId ?? 0),
      },
    };
  }
}

export class MysqlD1Database {
  private connectionPool: Pool | null = null;

  prepare(sql: string) {
    if (typeof sql !== "string" || !sql.trim()) {
      throw new Error("SQL statement is required");
    }
    return new MysqlPreparedStatement(this, sql);
  }

  pool(): Pool {
    this.connectionPool ??= createMysqlPool();
    return this.connectionPool;
  }

  async close() {
    const pool = this.connectionPool;
    this.connectionPool = null;
    if (pool) await pool.end();
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required server environment variable: ${name}`);
  return value;
}

function numberSetting(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function createMysqlPool(): Pool {
  return mysql.createPool({
    host: process.env.MYSQL_HOST?.trim() || "127.0.0.1",
    port: numberSetting("MYSQL_PORT", 3306, 1, 65535),
    database: required("MYSQL_DATABASE"),
    user: required("MYSQL_USER"),
    password: required("MYSQL_PASSWORD"),
    connectionLimit: numberSetting("MYSQL_CONNECTION_LIMIT", 10, 1, 50),
    waitForConnections: true,
    queueLimit: 0,
    charset: "utf8mb4",
    timezone: "Z",
    multipleStatements: false,
    enableKeepAlive: true,
  });
}

