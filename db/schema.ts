import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const projectState = sqliteTable('project_state', { id: text('id').primaryKey(), payload: text('payload').notNull(), revision: integer('revision').notNull().default(1) });
export const agentState = sqliteTable('agent_state', {id:text('id').primaryKey(),payload:text('payload').notNull(),revision:integer('revision').notNull().default(1)});
export const autonomyState = sqliteTable('autonomy_state', {id:text('id').primaryKey(),payload:text('payload').notNull(),revision:integer('revision').notNull().default(1),leaseUntil:integer('lease_until').notNull().default(0)});
export const autonomyArchive = sqliteTable('autonomy_archive',{id:text('id').primaryKey(),payload:text('payload').notNull()});
export const workspaceAccess=sqliteTable('workspace_access',{id:text('id').primaryKey(),payload:text('payload').notNull(),revision:integer('revision').notNull().default(1)});
export const accessAudit=sqliteTable('access_audit',{id:text('id').primaryKey(),actor:text('actor').notNull(),project:text('project').notNull(),action:text('action').notNull(),outcome:text('outcome').notNull(),at:text('at').notNull()});
