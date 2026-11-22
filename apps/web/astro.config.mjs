import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

/**
 * Mounts isolated TASK-032 design fixtures strictly in `astro dev` so
 * production builds (`astro build`) never emit or bundle fixture routes.
 */
function devDesignFixturesIntegration() {
  return {
    name: "punyasitus-dev-design-fixtures",
    hooks: {
      "astro:config:setup": ({ command, injectRoute }) => {
        if (command === "dev") {
          injectRoute({
            pattern: "/_dev/design-fixtures",
            entrypoint: "./src/dev/design-fixtures/index.astro",
          });
          injectRoute({
            pattern: "/_dev/design-fixtures/[surface]",
            entrypoint: "./src/dev/design-fixtures/[surface].astro",
          });
        }
      },
    },
  };
}

export default defineConfig({
  output: "server",
  session: false,
  devToolbar: {
    enabled:
      process.env.CI !== "true" &&
      process.env.PUNYASITUS_DISABLE_DEV_TOOLBAR !== "1",
  },
  adapter: cloudflare({
    imageService: "cloudflare-binding",
    imagesBindingName: "IMAGES",
    configPath: "./wrangler.jsonc",
    remoteBindings: false,
    persistState: {
      path: "./.wrangler/state",
    },
  }),
  integrations: [react(), devDesignFixturesIntegration()],
  vite: {
    plugins: [tailwindcss()],
    server: {
      allowedHosts:
        process.env.PUNYASITUS_ALLOW_DEV_HOSTS === "1"
          ? true
          : ["punyasitus.com", ".punyasitus.com", ".situsku.click"],
    },
  },
});
