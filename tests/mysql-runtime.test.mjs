import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

const executions = [];
const responses = [
  [[{ id: "first" }], []],
  [[{ id: "one" }, { id: "two" }], []],
  [{ affectedRows: 1, insertId: 7 }, []],
  [{ affectedRows: 0, insertId: 0 }, []],
  [{ affectedRows: 1, insertId: 0 }, []],
];
const fakePool = {
  async execute(sql, values) {
    executions.push({ sql, values });
    const response = responses.shift();
    if (!response) throw new Error("Unexpected MySQL execution");
    return response;
  },
  async end() {},
};

const sourcePath = path.resolve("lib/runtime/mysql-d1.ts");
const output = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
  },
}).outputText;
const exportsObject = {};
vm.runInNewContext(
  output,
  {
    exports: exportsObject,
    require(id) {
      if (id === "mysql2/promise") return { createPool: () => fakePool };
      throw new Error(`Unexpected require: ${id}`);
    },
    process: {
      env: {
        MYSQL_DATABASE: "xlloop",
        MYSQL_USER: "xlloop_app",
        MYSQL_PASSWORD: "fixture-secret",
      },
    },
    console,
  },
  { filename: sourcePath },
);

const { MysqlD1Database, normalizeMysqlSql } = exportsObject;

const coreSchema = fs.readFileSync(path.resolve("deploy/sql/001_core.sql"), "utf8");
for (const table of [
  "project_state",
  "agent_state",
  "autonomy_state",
  "autonomy_archive",
  "workspace_access",
  "access_audit",
]) {
  assert.ok(coreSchema.includes("CREATE TABLE IF NOT EXISTS `" + table + "`"));
}
assert.equal((coreSchema.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length, 6);
assert.match(coreSchema, /`payload` LONGTEXT NOT NULL/);
assert.match(coreSchema, /ENGINE=InnoDB DEFAULT CHARSET=utf8mb4/);

assert.equal(
  normalizeMysqlSql(
    "INSERT OR IGNORE INTO project_state(id,payload,revision) VALUES (?,?,1)",
  ),
  "INSERT IGNORE INTO project_state(id,payload,revision) VALUES (?,?,1)",
);
assert.equal(
  normalizeMysqlSql(
    "SELECT id FROM autonomy_state ORDER BY COALESCE(json_extract(payload,'$.lastHeartbeat'),'') ASC LIMIT 5",
  ),
  "SELECT id FROM autonomy_state ORDER BY COALESCE(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.lastHeartbeat')), '') ASC LIMIT 5",
);

const db = new MysqlD1Database();
const first = await db.prepare("SELECT id FROM sample WHERE id=?").bind("first").first();
assert.equal(first.id, "first");
const all = await db.prepare("SELECT id FROM sample").all();
assert.deepEqual(
  Array.from(all.results, (row) => row.id),
  ["one", "two"],
);
const write = await db
  .prepare("INSERT OR IGNORE INTO sample(id) VALUES (?)")
  .bind("new")
  .run();
assert.equal(write.meta.changes, 1);
assert.equal(write.meta.last_row_id, 7);
assert.equal(executions[2].sql, "INSERT IGNORE INTO sample(id) VALUES (?)");
assert.deepEqual(Array.from(executions[2].values), ["new"]);

const ignored = await db
  .prepare("INSERT OR IGNORE INTO sample(id) VALUES (?)")
  .bind("existing")
  .run();
assert.equal(ignored.meta.changes, 0);

const occurredAt = new Date("2026-11-10T09:30:00.123Z");
await db
  .prepare("UPDATE sample SET occurred_at=? WHERE id=?")
  .bind(occurredAt, "first")
  .run();
assert.strictEqual(executions[4].values[0], occurredAt);

await db.close();
console.log("mysql runtime adapter tests passed");

