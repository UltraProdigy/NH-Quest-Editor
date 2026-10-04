import { defineConfig } from 'vite';

// Relative base so the site works both at the Pages project path and locally.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    assetsDir: 'app',
    // Generated data (public/data) is large; nothing to inline.
    assetsInlineLimit: 0,
  },
});
