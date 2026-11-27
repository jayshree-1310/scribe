import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

/** Files under `dir`, as site paths (`/assets/index-abc.js`). */
function sitePaths(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    return statSync(full).isDirectory()
      ? sitePaths(full, base)
      : [`/${path.relative(base, full).split(path.sep).join('/')}`]
  })
}

/**
 * Writes `dist/sw.js` from `sw/service-worker.js` once the build is on disk:
 * the list of every file it wrote, for the worker to keep, and a hash of
 * their contents as its version, so each release is a new worker. After the
 * bundle and `public/` are both written, which is why `closeBundle` and not a
 * bundle hook: the public files never pass through the bundle.
 *
 * Build only. In development there is no worker, because one that serves
 * saved files would fight Vite's hot reload.
 */
function serviceWorker(): Plugin {
  let outDir = 'dist'
  return {
    name: 'scribe-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const files = sitePaths(outDir)
        .filter((file) => file !== '/sw.js' && !file.endsWith('.map'))
        .sort()
      const hash = createHash('sha256')
      for (const file of files) hash.update(file).update(readFileSync(path.join(outDir, file)))
      const version = hash.digest('hex').slice(0, 12)

      const template = readFileSync(path.resolve(import.meta.dirname, 'sw/service-worker.js'), 'utf8')
      writeFileSync(
        path.join(outDir, 'sw.js'),
        template
          .replace("'__SCRIBE_VERSION__'", JSON.stringify(version))
          .replace('__SCRIBE_PRECACHE__', JSON.stringify(files, null, 2)),
      )
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [react(), serviceWorker()],
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
