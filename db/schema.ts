import { bigint, char, int, longtext, mysqlTable, varchar } from "drizzle-orm/mysql-core";

const stateColumns = () => ({
  id: varchar("id", { length: 512 }).primaryKey(),
  payload: longtext("payload").notNull(),
  revision: int("revision", { unsigned: true }).notNull().default(1),
});

export const projectState = mysqlTable("project_state", stateColumns());
export const agentState = mysqlTable("agent_state", stateColumns());
export const workspaceAccess = mysqlTable("workspace_access", stateColumns());

export const autonomyState = mysqlTable("autonomy_state", {
  ...stateColumns(),
  leaseUntil: bigint("lease_until", { mode: "number", unsigned: true })
    .notNull()
    .default(0),
});

export const autonomyArchive = mysqlTable("autonomy_archive", {
  id: varchar("id", { length: 512 }).primaryKey(),
  payload: longtext("payload").notNull(),
});

export const accessAudit = mysqlTable("access_audit", {
  id: char("id", { length: 36 }).primaryKey(),
  actor: varchar("actor", { length: 512 }).notNull(),
  project: varchar("project", { length: 512 }).notNull(),
  action: varchar("action", { length: 255 }).notNull(),
  outcome: varchar("outcome", { length: 255 }).notNull(),
  at: varchar("at", { length: 40 }).notNull(),
});
