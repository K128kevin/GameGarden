import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

config({ path: [".env.test", ".env.local"], quiet: true });
const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(root, "src"),
      "server-only": path.resolve(root, "tests/empty.ts"),
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
