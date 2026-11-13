import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// La SPA est servie à la racine de l'adresse du serveur.
export default defineConfig({
  base: '/',
  plugins: [react()],
  resolve: {
    // La GUI partage les schémas avec le serveur MCP.
    alias: { '@shared': path.resolve(import.meta.dirname, '../shared') },
  },
})
