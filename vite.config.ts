import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: '/sql-stuff/', // GitHub Pages base path
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
