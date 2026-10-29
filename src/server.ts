import { cleanupMedia } from './media/story-media.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { db, migrate } from './db.js';
import { getSettings } from './settings.js';
import { openPiRuntime } from './models/index.js';
import { initializeUsageOutbox, startUsageRecovery, usageRecoveryInterval } from './models/usage-delivery.js';
import { usageOutboxStatus } from './models/usage-outbox-status.js';
import { createPipeline } from './pipeline/index.js';
import { startPublicationMaintenance } from './publishing/index.js';
import { createApp } from './http/app.js';
import { createServices } from './http/services.js';

export async function startServer(): Promise<() => Promise<void>> {
  const port = z.coerce.number().int().min(1).max(65535).parse(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  const usageRetryMs = usageRecoveryInterval();
  await migrate();
  await cleanupMedia();
  const settings = await getSettings();
  const runtime = await openPiRuntime(resolve(process.env.PI_AUTH_PATH ?? 'tmp/models-private-auth/auth.json'));
  await initializeUsageOutbox();
  if ((await usageOutboxStatus()).state !== 'ready') throw new Error('Model usage storage is not private and ready');
  const pipeline = await createPipeline();
  const { services, operations, oauth } = createServices(pipeline, runtime);
  let backgroundHealthy=true;
  const app = createApp(services, {
    allowedHosts: (process.env.APP_ALLOWED_HOSTS ?? '').split(',').map(value => value.trim()).filter(Boolean),
    webDirectory: resolve('dist/web'), usageOutboxStatus, backgroundHealthy:()=>backgroundHealthy,
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolveServer, reject) => {
    const listener = app.listen(port, host, () => resolveServer(listener));
    listener.once('error', reject);
  });
  const stopUsageRecovery = startUsageRecovery(usageRetryMs,{ settings });
  console.info(`Settings server listening on port ${port}. Access through loopback or an SSH tunnel only.`);
  let stopBot: (() => Promise<void>) | undefined;
  const ready = Promise.allSettled([
    operations.resume().catch(() => { backgroundHealthy=false; console.error('Saved operation recovery failed; health is degraded.'); }),
    startPublicationMaintenance().then(stop => { stopBot = stop; }).catch(() => { backgroundHealthy=false; console.error('Telegram publication maintenance failed to start; health is degraded.'); }),
    pipeline.start().catch(() => { backgroundHealthy=false; console.error('Processing service failed to start; health is degraded. Check saved processing status.'); }),
  ]);
  const mediaCleanup = setInterval(() => { void cleanupMedia().catch(() => {
    console.error('Temporary media cleanup failed.');
  }); }, 60 * 60 * 1000);
  mediaCleanup.unref();
  let stopping = false;
  return async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(mediaCleanup);
    const closed = new Promise<void>(resolveClosed => { server.close(() => resolveClosed()); });
    server.closeIdleConnections();
    const stoppingWork = Promise.allSettled([oauth.cancel(), operations.stop(), pipeline.stop()]);
    await ready;
    // Startup can finish after shutdown begins. Stop again to clear late-installed schedules.
    await Promise.allSettled([stoppingWork, pipeline.stop(), stopBot?.()]);
    await closed;
    await stopUsageRecovery();
    await db.end();
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const stop = await startServer();
    const shutdown = () => { void stop().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch {
    console.error('Server startup failed. Check database, authentication storage and configuration.');
    process.exitCode = 1;
    await db.end();
  }
}
