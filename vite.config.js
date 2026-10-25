import { defineConfig } from 'vite';
import path from 'node:path';
import { buildContent } from './scripts/build-content.mjs';

// Builds ./content before dev/build, and rebuilds + reloads the browser
// whenever a file under ./content changes during `npm run dev`.
function wikiContent() {
  const contentDir = path.resolve(process.env.CONTENT_DIR || 'content');
  let timer;
  return {
    name: 'wiki-content',
    async buildStart() {
      await buildContent({ quiet: this.meta.watchMode });
    },
    configureServer(server) {
      server.watcher.add(contentDir);
      const rebuild = (file) => {
        if (!path.resolve(file).startsWith(contentDir)) return;
        clearTimeout(timer);
        timer = setTimeout(async () => {
          try {
            await buildContent({ quiet: true });
            server.ws.send({ type: 'full-reload' });
          } catch (err) {
            server.config.logger.error(err.message);
          }
        }, 150);
      };
      server.watcher.on('add', rebuild).on('change', rebuild).on('unlink', rebuild);
    },
  };
}

export default defineConfig({
  base: './', // works under any path prefix
  plugins: [wikiContent()],
  server: {
    watch: { ignored: ['**/public/**'] }, // generated output, don't loop
  },
});
