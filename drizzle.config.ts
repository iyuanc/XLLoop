import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./deploy/drizzle",
  schema: "./db/schema.ts",
  dialect: "mysql",
});
