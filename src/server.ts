import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app, close } = await buildApp(config, { logger: true });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void close().finally(() => process.exit(0));
  });
}

await app.listen({ port: config.port, host: '0.0.0.0' });
