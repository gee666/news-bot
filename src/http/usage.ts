import type { Express } from 'express';
import { callsPageSchema, callsQuerySchema, usageQuerySchema, usageStatsSchema,
  type UsageServices } from '../usage/contracts.js';

export function usageRoutes(app: Express, services: UsageServices): void {
  app.get('/api/usage', async (req, res) => {
    const query = usageQuerySchema.parse(req.query);
    res.json(usageStatsSchema.parse(await services.usage(query)));
  });
  app.get('/api/usage/calls', async (req, res) => {
    const query = callsQuerySchema.parse(req.query);
    res.json(callsPageSchema.parse(await services.usageCalls(query)));
  });
}
