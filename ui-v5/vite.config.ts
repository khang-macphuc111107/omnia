import { defineConfig } from 'file:///D:/OmniaData/build/ui-deps/node_modules/vite/dist/node/index.js';
import solid from 'file:///D:/OmniaData/build/ui-deps/node_modules/vite-plugin-solid/dist/esm/index.mjs';
import tailwindcss from 'file:///D:/OmniaData/build/ui-deps/node_modules/@tailwindcss/vite/dist/index.mjs';
import path from 'node:path';

const DEPS = 'D:/OmniaData/build/ui-deps/node_modules';
const SRC = path.resolve(__dirname, 'src');

export default defineConfig({
  plugins: [tailwindcss(), solid()],
  cacheDir: 'D:/OmniaData/build/ui-vite-cache',
  resolve: {
    alias: [
      { find: '@', replacement: SRC },
      { find: /^solid-js\/web$/, replacement: path.join(DEPS, 'solid-js/web/dist/web.js') },
      { find: /^solid-js\/store$/, replacement: path.join(DEPS, 'solid-js/store/dist/store.js') },
      { find: /^solid-js\/html$/, replacement: path.join(DEPS, 'solid-js/html/dist/html.js') },
      { find: /^solid-js$/, replacement: path.join(DEPS, 'solid-js/dist/solid.js') },
      { find: /^tailwindcss$/, replacement: path.join(DEPS, 'tailwindcss') },
      { find: /^@tanstack\/solid-virtual$/, replacement: path.join(DEPS, '@tanstack/solid-virtual/dist/esm/index.js') },
      { find: /^@pierre\/diffs$/, replacement: path.join(DEPS, '@pierre/diffs/dist/index.js') },
      { find: /^@xterm\/xterm\/css\/xterm\.css$/, replacement: path.join(DEPS, '@xterm/xterm/css/xterm.css') },
      { find: /^@xterm\/xterm$/, replacement: path.join(DEPS, '@xterm/xterm/lib/xterm.js') },
      { find: /^@xterm\/addon-fit$/, replacement: path.join(DEPS, '@xterm/addon-fit/lib/addon-fit.js') },
      { find: /^@xterm\/addon-webgl$/, replacement: path.join(DEPS, '@xterm/addon-webgl/lib/addon-webgl.js') },
      { find: /^katex\/contrib\/mhchem$/, replacement: path.join(DEPS, 'katex/dist/contrib/mhchem.mjs') },
      { find: /^katex\/dist\/katex\.min\.css$/, replacement: path.join(DEPS, 'katex/dist/katex.min.css') },
      { find: /^katex$/, replacement: path.join(DEPS, 'katex/dist/katex.mjs') },
      { find: /^@fontsource\/be-vietnam-pro$/, replacement: path.join(DEPS, '@fontsource/be-vietnam-pro/index.css') },
      { find: /^@fontsource\/plus-jakarta-sans$/, replacement: path.join(DEPS, '@fontsource/plus-jakarta-sans/index.css') },
      { find: /^@fontsource\/jetbrains-mono$/, replacement: path.join(DEPS, '@fontsource/jetbrains-mono/index.css') },
      { find: /^lucide-solid$/, replacement: path.join(DEPS, 'lucide-solid/dist/esm/lucide-solid.js') },
      { find: /^marked$/, replacement: path.join(DEPS, 'marked/lib/marked.esm.js') },
      { find: /^dompurify$/, replacement: path.join(DEPS, 'dompurify/dist/purify.es.mjs') },
      { find: /^highlight\.js\/lib\/common$/, replacement: path.join(DEPS, 'highlight.js/lib/common.js') },
      { find: /^highlight\.js$/, replacement: path.join(DEPS, 'highlight.js/es/index.js') },
      { find: /^mermaid$/, replacement: path.join(DEPS, 'mermaid/dist/mermaid.esm.min.mjs') },
      { find: /^@codemirror\/(.*)$/, replacement: path.join(DEPS, '@codemirror/$1') },
      { find: /^@lezer\/(.*)$/, replacement: path.join(DEPS, '@lezer/$1') },
      { find: /^codemirror$/, replacement: path.join(DEPS, 'codemirror') },
      { find: /^style-mod$/, replacement: path.join(DEPS, 'style-mod') },
      { find: /^w3c-keyname$/, replacement: path.join(DEPS, 'w3c-keyname') },
      { find: /^crelt$/, replacement: path.join(DEPS, 'crelt') },
    ],
  },
  server: {
    port: 5175,
    strictPort: true,
    fs: {
      allow: [SRC, __dirname, DEPS],
    },
  },
  build: {
    outDir: 'D:/OmniaData/build/ui-dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor_code: ['@codemirror/view', '@codemirror/state', '@codemirror/commands', '@codemirror/language'],
          vendor_xterm: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-webgl'],
          vendor_math: ['katex', 'marked', 'dompurify', 'highlight.js'],
          vendor_mermaid: ['mermaid'],
          vendor_diffs: ['@pierre/diffs'],
        },
      },
    },
  },
});
