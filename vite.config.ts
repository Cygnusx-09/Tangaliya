import { defineConfig } from 'vite'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'


export default defineConfig({
  // GitHub Pages serves this project site under /Tangaliya/. Only apply that
  // base in CI so local dev / preview keep working at the root.
  base: process.env.GITHUB_ACTIONS ? '/Tangaliya/' : '/',
  plugins: [
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },

  // Multi-page: the editor (index.html) + the standalone full-screen image tool.
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        image: path.resolve(__dirname, 'image.html'),
        text: path.resolve(__dirname, 'text.html'),
      },
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],
})
