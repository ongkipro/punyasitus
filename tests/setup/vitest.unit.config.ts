import { defineConfig } from "vitest/config";

const maxWorkers = Number(process.env.VITEST_MAX_WORKERS ?? 2);

export default defineConfig({
  test: {
    include: ["tests/task-023/unit.test.ts"],
    environment: "node",
    maxWorkers,
  },
});
