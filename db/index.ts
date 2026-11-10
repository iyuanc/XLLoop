import { env } from "../lib/runtime/env";

export function getDb() {
  return env.DB;
}
