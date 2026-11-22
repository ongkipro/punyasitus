import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  session: false,
  adapter: cloudflare({
    imageService: "cloudflare-binding",
    imagesBindingName: "IMAGES",
    configPath: "./wrangler.jsonc",
    remoteBindings: false,
    persistState: {
      path: "./.wrangler/state",
    },
  }),
  integrations: [react()],
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
