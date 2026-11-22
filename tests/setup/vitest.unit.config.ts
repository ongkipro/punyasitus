import { defineConfig } from "vitest/config";

const maxWorkers = Number(process.env.VITEST_MAX_WORKERS ?? 2);

export default defineConfig({
  test: {
    include: ["tests/**/unit.test.ts", "tests/**/*.unit.test.ts"],
    environment: "node",
    maxWorkers,
  },
});
