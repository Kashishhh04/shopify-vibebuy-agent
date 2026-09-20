import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Default Vite output hashes filenames (e.g. main-a1b2c3.js) so browsers
    // safely cache old builds forever - fine for an app's own index.html,
    // which always references its current build's exact filenames. This
    // widget instead gets embedded via one hand-written <script src="...">
    // tag in the Shopify theme, which can't know a hash it doesn't have -
    // stable names here mean that tag never needs updating after a rebuild.
    rollupOptions: {
      output: {
        entryFileNames: 'widget.js',
        // Only the stylesheet needs a stable name (it's the other half of
        // what the embed tag loads) - forcing every asset to "widget.ext"
        // collided multiple same-extension files (e.g. two SVGs) into one
        // filename. Everything else keeps Vite's normal hashed naming, which
        // is fine since only the JS bundle's own rewritten import paths ever
        // reference them - nothing outside the build needs to guess those.
        assetFileNames: (assetInfo) =>
          assetInfo.names?.[0]?.endsWith('.css') ? 'widget.css' : 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    // Needed for a tunnel (ngrok, etc.) to reach this dev server at all -
    // host so it listens on every interface, not just localhost, and
    // allowedHosts so Vite doesn't reject the tunnel's Host header (it
    // blocks anything unrecognized by default, to guard against DNS
    // rebinding). Fine to leave permissive here since this is a throwaway
    // dev server, not anything deployed.
    host: true,
    allowedHosts: true,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
})
