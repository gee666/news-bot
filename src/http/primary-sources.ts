import type { Express, ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { primarySourceInput, primarySourcePatch, primarySourceViewSchema, type PrimarySourceView } from '../sources/index.js';
import { ResearchFetchError } from '../pipeline/research-fetch.js';

export interface PrimarySourceServices {
  primarySources(): Promise<PrimarySourceView[]>;
  addPrimarySource(input: unknown): Promise<PrimarySourceView>;
  editPrimarySource(id: string, patch: unknown): Promise<PrimarySourceView>;
  seedPrimarySources(): Promise<PrimarySourceView[]>;
}

export const publicPrimarySourceSchema = primarySourceViewSchema;
const listSchema = z.array(publicPrimarySourceSchema);

export function primarySourceRoutes(app: Express, services: PrimarySourceServices) {
  app.get('/api/primary-sources', async (_req, res) => {
    res.json(listSchema.parse(await services.primarySources()));
  });
  app.post('/api/primary-sources', async (req, res) => {
    const input = primarySourceInput.parse(req.body);
    res.status(201).json(publicPrimarySourceSchema.parse(await services.addPrimarySource(input)));
  });
  app.post('/api/primary-sources/seed', async (req, res) => {
    z.object({}).strict().parse(req.body);
    res.json(listSchema.parse(await services.seedPrimarySources()));
  });
  app.patch('/api/primary-sources/:id', async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const patch = primarySourcePatch.parse(req.body);
    res.json(publicPrimarySourceSchema.parse(await services.editPrimarySource(id, patch)));
  });
  const errors: ErrorRequestHandler = (error: unknown, req, res, next) => {
    if (!req.path.startsWith('/api/primary-sources')) { next(error); return; }
    if (error instanceof ResearchFetchError) {
      res.status(400).json({ error: 'Source URL must be a reachable public HTTP or HTTPS endpoint without credentials.' });
    } else if (error instanceof Error && error.message === 'primary_source_identity_locked') {
      res.status(409).json({ code: 'replace_source_required',
        error: 'This source has collection history. Add a replacement source to change kind or URL. Disable the old source to preserve its history.' });
    } else if (error instanceof Error && error.message === 'primary_source_invalid_config') {
      res.status(400).json({ code: 'primary_source_invalid_config',
        error: 'Source needs configuration. Only disabling is allowed. Add a replacement source and preserve the old history.' });
    } else if (error instanceof Error && error.message === 'primary_source_not_found') {
      res.status(404).json({ error: 'Source not found.' });
    } else { next(error); }
  };
  app.use(errors);
}
