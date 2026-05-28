import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";

const DEV_HOST = process.env.HOST ?? "0.0.0.0";
const DEV_PORT = Number(process.env.PORT ?? 5173);
const DEV_HTTPS_CERT = normalizeOptionalEnv(process.env.DEV_HTTPS_CERT);
const DEV_HTTPS_KEY = normalizeOptionalEnv(process.env.DEV_HTTPS_KEY);
const HMR_HOST = normalizeOptionalEnv(process.env.HMR_HOST);
const HMR_CLIENT_PORT = normalizeOptionalNumber(process.env.HMR_CLIENT_PORT);
const HMR_PROTOCOL = normalizeOptionalEnv(process.env.HMR_PROTOCOL);
const HTTPS_CONFIG = loadHttpsConfig();

export default defineConfig(({ command, mode }) => ({
  base:
    command === "build"
      ? normalizeBasePath(process.env.BASE_PATH ?? "./")
      : "/",
  plugins: [
    react(),
    wasm(),
    topLevelAwait(),
    markHtmlScriptsAsCloudflareSafe(),
    rewriteViteClientHostFallback(),
  ],
  server: {
    host: DEV_HOST,
    port: DEV_PORT,
    strictPort: true,
    ...(HTTPS_CONFIG ? { https: HTTPS_CONFIG } : {}),
    ...buildHmrConfig(mode),
  },
  resolve: {
    alias: {
      "@wasm": path.resolve(__dirname, "src/wasm/pkg"),
      "@miner-wasm": path.resolve(__dirname, "src/miner_wasm/pkg"),
    },
  },
}));

function normalizeBasePath(value: string) {
  const trimmed = value.trim();

  if (trimmed === "" || trimmed === "." || trimmed === "./") {
    return "./";
  }

  if (trimmed === "/") {
    return "/";
  }

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash
    : `${withLeadingSlash}/`;
}

function buildHmrConfig(mode: string) {
  if (mode === "test") {
    return {};
  }

  const hmr = {
    ...(HMR_HOST ? { host: HMR_HOST } : {}),
    ...(HMR_CLIENT_PORT !== null ? { clientPort: HMR_CLIENT_PORT } : {}),
    ...(HMR_PROTOCOL ? { protocol: HMR_PROTOCOL } : {}),
  };

  return Object.keys(hmr).length > 0 ? { hmr } : {};
}

function normalizeOptionalEnv(value: string | undefined) {
  const trimmed = value?.trim();

  return trimmed ? trimmed : null;
}

function normalizeOptionalNumber(value: string | undefined) {
  const trimmed = value?.trim();

  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function loadHttpsConfig() {
  if (!DEV_HTTPS_CERT && !DEV_HTTPS_KEY) {
    return null;
  }

  if (!DEV_HTTPS_CERT || !DEV_HTTPS_KEY) {
    throw new Error("DEV_HTTPS_CERT と DEV_HTTPS_KEY は両方指定してください");
  }

  return {
    cert: fs.readFileSync(DEV_HTTPS_CERT),
    key: fs.readFileSync(DEV_HTTPS_KEY),
  };
}

function rewriteViteClientHostFallback() {
  return {
    name: "rewrite-vite-client-host-fallback",
    apply: "serve" as const,
    transform(code: string, id: string) {
      if (
        !id.includes("/@vite/client")
        && !id.includes("vite/dist/client/client.mjs")
      ) {
        return null;
      }

      const next = code
        .replace(
          /const serverHost = .*;/,
          'const serverHost = `${new URL(import.meta.url).host}/`;',
        )
        .replace(
          /const directSocketHost = .*;/,
          'const directSocketHost = `${new URL(import.meta.url).host}/`;',
        );

      return next === code ? null : next;
    },
  };
}

function markHtmlScriptsAsCloudflareSafe() {
  return {
    name: "mark-html-scripts-as-cloudflare-safe",
    transformIndexHtml: {
      order: "post" as const,
      handler(html: string) {
        return html.replace(
          /<script\b(?![^>]*\bdata-cfasync=)([^>]*)\bsrc=/g,
          '<script data-cfasync="false"$1src=',
        );
      },
    },
  };
}
