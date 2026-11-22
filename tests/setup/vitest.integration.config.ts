import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const maxWorkers = Number(process.env.VITEST_MAX_WORKERS ?? 2);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/setup/wrangler.test.jsonc" },
    }),
  ],
  test: {
    include: ["tests/task-023/workerd.integration.test.ts"],
    maxWorkers,
  },
});
