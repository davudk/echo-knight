import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    // three.js alone is ~600 kB; that's expected for this prototype.
    chunkSizeWarningLimit: 1000,
  },
});
