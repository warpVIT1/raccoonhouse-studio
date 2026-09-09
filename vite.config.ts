import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import path from 'path'

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
      preload: {
        input: path.join(__dirname, 'electron/preload.ts'),
        vite: {
          build: {
            outDir: 'dist-electron',
          },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // jassub (libass/WASM subtitle renderer, see VideoPlayer.tsx) constructs
  // its own `new Worker(new URL(...))` internally — Vite's default worker
  // output format (IIFE) can't code-split, which jassub's worker bundle
  // needs, and the build fails outright without this. Vite's own
  // documented fix for this exact "UMD and IIFE output formats are not
  // supported for code-splitting builds" error.
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
  },
})
