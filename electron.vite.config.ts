import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';
export default defineConfig({
  main: { build: { rollupOptions: { external: ['electron'], input: resolve('src/main/index.ts'), output: { format: 'es' } } } },
  preload: { build: { rollupOptions: { external: ['electron'], input: { index: resolve('src/preload/index.ts'), print: resolve('src/preload/print.ts') }, output: { format: 'cjs', entryFileNames: '[name].cjs' } } } },
  renderer: { root: 'src/renderer', build: { rollupOptions: { input: { preview: resolve('src/renderer/preview/index.html'), print: resolve('src/renderer/print/index.html') } } } }
});
