import { pathToFileURL } from 'node:url';
import { createApp } from './src/server/app.js';
import { loadConfig } from './src/server/config.js';

export { createApp };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const app = createApp({ config });
  const server = app.listen(config.port, config.host, () => {
    console.info(`Flappy Fish listening on port ${config.port}; ranked=${Boolean(config.configured && config.rankedEnabled)}`);
    if (!config.configured) console.warn('Ranked storage/secrets not configured. Practice remains available. See .env.example.');
  });
  const stop = () => {
    server.close(async () => { await app.locals.close(); });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
