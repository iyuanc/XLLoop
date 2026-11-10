import { MysqlD1Database } from "./mysql-d1";

const runtimeGlobal = globalThis as typeof globalThis & {
  __xlloopMysqlDatabase?: MysqlD1Database;
};

const database =
  runtimeGlobal.__xlloopMysqlDatabase ??
  (runtimeGlobal.__xlloopMysqlDatabase = new MysqlD1Database());

function integerSetting(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** Server-only runtime values. Never import this module from a Client Component. */
export const env = {
  DB: database,
  get XLLOOP_OWNER_EMAIL() {
    return process.env.XLLOOP_OWNER_EMAIL;
  },
  get XLLOOP_SERVICE_KEY() {
    return process.env.XLLOOP_SERVICE_KEY;
  },
  get XLLOOP_RUNNER_URL() {
    return process.env.XLLOOP_RUNNER_URL;
  },
  get XLLOOP_RUNNER_TOKEN() {
    return process.env.XLLOOP_RUNNER_TOKEN;
  },
  get XLLOOP_FEEDBACK_BRIDGE_KEY() {
    return process.env.XLLOOP_FEEDBACK_BRIDGE_KEY;
  },
  get XLLOOP_SESSION_HOURS() {
    return integerSetting("XLLOOP_SESSION_HOURS", 8, 1, 168);
  },
};

export type RuntimeEnv = typeof env;

