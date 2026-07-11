// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

// https://astro.build/config
export default defineConfig({
  // Primary canonical / social (OG) URL. Site is also served at kulcsly.uk;
  // change this if the primary domain changes.
  site: "https://ennivalo.com",
  integrations: [sitemap()],
});
