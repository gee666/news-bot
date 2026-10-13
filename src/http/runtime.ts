import type { Express } from 'express';
import { z } from 'zod';
import { usageOutboxStatus, usageOutboxStatusSchema, type UsageOutboxStatus } from '../models/usage-outbox-status.js';

const runtimeStatusSchema = z.object({
  automaticWorkEnabled: z.boolean(), manualMutationsAllowed: z.boolean(),
  usageOutbox: usageOutboxStatusSchema,
});
export interface RuntimeReadOptions {
  usageOutboxStatus?: () => Promise<UsageOutboxStatus>;
  backgroundHealthy?: () => boolean;
}
export function runtimeRoutes(app: Express, options: RuntimeReadOptions): void {
  app.get('/api/runtime', async (_req, res) => {
    res.json(runtimeStatusSchema.parse({ automaticWorkEnabled: true,
      manualMutationsAllowed: true, usageOutbox: await (options.usageOutboxStatus ?? usageOutboxStatus)() }));
  });
}
