import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// base './' : la SPA est servie derrière un préfixe de proxy variable, résolu à
// l'exécution par la balise <base> injectée par le GUI worker.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    // La GUI partage les schémas avec le serveur MCP.
    alias: { '@shared': path.resolve(import.meta.dirname, '../shared') },
  },
})
