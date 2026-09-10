import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react()],
    server: {
      port: Number(env.VITE_PORT) || 1302,
      proxy: {
        '/api': {
          target: env.VITE_API_PROXY_TARGET || 'http://localhost:1303',
          changeOrigin: true,
        },
        // Uploaded avatars are stored by the API and referenced by
        // root-relative URLs, so they have to reach it too.
        '/uploads': {
          target: env.VITE_API_PROXY_TARGET || 'http://localhost:1303',
          changeOrigin: true,
        },
      },
    },
  }
})