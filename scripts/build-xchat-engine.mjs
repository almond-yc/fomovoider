#!/usr/bin/env node
// Bundles the X Chat engine (Chat XDK + Juicebox, both WASM) into one HTML
// file the app loads into a hidden WebView. Hermes can't run WebAssembly, the
// WebView's browser engine can. The WASM is inlined, so the page loads no
// code from the network.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));
const out = join(root, "assets/xchat/engine.html");

const base64 = (path) => readFileSync(path).toString("base64");
const chatWasm = base64(join(dirname(require.resolve("@xdevplatform/chat-xdk")), "pkg/chat_xdk_wasm_bg.wasm"));
const juiceboxDir = dirname(require.resolve("juicebox-sdk"));
const juiceboxWasm = base64(join(juiceboxDir, "juicebox-sdk_bg.wasm"));

const inlineWasm = {
  name: "inline-wasm",
  setup(b) {
    b.onLoad({ filter: /chat_xdk_wasm\.js$/ }, (args) => {
      const src = readFileSync(args.path, "utf8");
      const target = "new URL('chat_xdk_wasm_bg.wasm', import.meta.url)";
      if (!src.includes(target)) throw new Error("chat-xdk changed how it loads its WASM; update scripts/build-xchat-engine.mjs");
      return { contents: src.replace(target, `Uint8Array.from(atob("${chatWasm}"), (c) => c.charCodeAt(0))`), loader: "js" };
    });
    b.onResolve({ filter: /^juicebox-sdk$/ }, () => ({ path: "juicebox-sdk", namespace: "juicebox-inline" }));
    b.onLoad({ filter: /.*/, namespace: "juicebox-inline" }, () => ({
      resolveDir: juiceboxDir,
      loader: "js",
      contents: `
        import * as bg from "./juicebox-sdk_bg.js";
        const bytes = Uint8Array.from(atob("${juiceboxWasm}"), (c) => c.charCodeAt(0));
        const { instance } = await WebAssembly.instantiate(bytes, { "./juicebox-sdk_bg.js": bg });
        bg.__wbg_set_wasm(instance.exports);
        export * from "./juicebox-sdk_bg.js";
      `,
    }));
  },
};

const result = await build({
  entryPoints: [join(root, "src/xchat/engine/web/entry.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
  external: ["crypto", "fs", "url", "module"],
  plugins: [inlineWasm],
  logLevel: "warning",
});

// connect-src: Juicebox realms (the key backup) and X's feature switches.
// Nothing else, and no remote scripts.
const csp = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'wasm-unsafe-eval'",
  "connect-src https: data:",
].join("; ");
const js = result.outputFiles[0].text.replaceAll("</script", "<\\/script");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script type="module">${js}</script></body></html>`,
);
console.log(`X Chat engine: ${out} (${(Buffer.byteLength(js) / 1e6).toFixed(1)} MB)`);
