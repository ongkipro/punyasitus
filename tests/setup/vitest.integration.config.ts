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
    include: ["tests/**/workerd.integration.test.ts", "tests/**/*.integration.test.ts"],
    maxWorkers,
  },
});
