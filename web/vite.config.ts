import { copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const BASE = "/Mouses/";
const webRoot = fileURLToPath(new URL(".", import.meta.url));

const OPTIONAL_PEERS = [
  "pipeline/processSong",
  "components/Mixer",
  "components/LyricsView",
  "components/ChordsView",
  "drive/auth",
];

function isOptionalPeer(source: string): boolean {
  const path = source.split("?")[0]?.split("#")[0]?.replace(/\\/g, "/") ?? source;
  const withoutExt = path.replace(/\.(tsx|ts|jsx|js)$/, "");
  return OPTIONAL_PEERS.some(
    (item) => withoutExt === item || withoutExt.endsWith(`/${item}`),
  );
}

/**
 * Mixer, lyrics, chords, the splitter, and Drive auth are owned by other
 * agents and may be absent on this branch. A missing module becomes a chunk
 * that fails to evaluate so the shell can show a local-only or failed state.
 * When the real file exists, it is bundled instead.
 */
function optionalPeerModules(): Plugin {
  const virtualPrefix = "\0mouses-optional:";
  return {
    name: "mouses-optional-peers",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!isOptionalPeer(source)) return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true });
      if (resolved) return resolved;
      return `${virtualPrefix}${source}`;
    },
    load(id) {
      if (!id.startsWith(virtualPrefix)) return null;
      const spec = id.slice(virtualPrefix.length);
      return `throw new Error(${JSON.stringify(`${spec} is not available in this build`)});`;
    },
  };
}

function pagesSpaFallback(): Plugin {
  return {
    name: "mouses-pages-spa-fallback",
    apply: "build",
    closeBundle() {
      const dist = resolve(webRoot, "dist");
      copyFileSync(resolve(dist, "index.html"), resolve(dist, "404.html"));
    },
  };
}

export default defineConfig({
  base: BASE,
  envDir: resolve(webRoot, ".."),
  plugins: [
    optionalPeerModules(),
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "apple-touch-icon.png", "pwa-192.png", "pwa-512.png"],
      manifest: {
        name: "Mouses",
        short_name: "Mouses",
        description: "Split songs into stems on your phone and play them back.",
        display: "standalone",
        start_url: BASE,
        scope: BASE,
        background_color: "#0e0e10",
        theme_color: "#0e0e10",
        icons: [
          {
            src: "pwa-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "pwa-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
        navigateFallback: "index.html",
      },
    }),
    pagesSpaFallback(),
  ],
});
