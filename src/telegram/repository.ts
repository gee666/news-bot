import { z } from "zod";
import { db, transaction } from "../db.js";
import type { Destination, DiscoveredChannel, TelegramSource } from "./types.js";

export const cursorSchema = z.object({
  lastMessageId: z.number().int().nonnegative().default(0),
  cutoff: z.iso.datetime().nullable().default(null),
});

const sourceSchema = z.object({
  id: z.uuid(),
  external_id: z.string(),
  name: z.string(),
  access: z.enum(["public", "restricted", "unknown"]),
  enabled: z.boolean(),
  active: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
  collection_cursor: cursorSchema,
});

export function parseSource(value: unknown): TelegramSource {
  const row = sourceSchema.parse(value);
  return {
    id: row.id, externalId: row.external_id, name: row.name, access: row.access,
    enabled: row.enabled, active: row.active, metadata: row.metadata, cursor: row.collection_cursor,
  };
}

export async function refreshSources(channels: readonly DiscoveredChannel[], destination: Destination): Promise<TelegramSource[]> {
  await transaction(async client => {
    await client.query(
      "UPDATE sources SET active=false, updated_at=now() WHERE connector_type='telegram'",
    );
    for (const channel of channels.filter(channel => channel.externalId !== destination.channelId)) {
      await client.query(
        `INSERT INTO sources(connector_type, external_id, name, original_url, access, metadata)
         VALUES('telegram', $1, $2, $3, $4, $5::jsonb)
         ON CONFLICT(connector_type, external_id) DO UPDATE
         SET name=EXCLUDED.name, original_url=EXCLUDED.original_url, access=EXCLUDED.access,
             metadata=EXCLUDED.metadata, active=true, updated_at=now()`,
        [channel.externalId, channel.name, channel.originalUrl, channel.access, JSON.stringify(channel.metadata)],
      );
    }
    await client.query(
      `INSERT INTO operational_state(key,value) VALUES('telegram_destination',$1::jsonb)
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [JSON.stringify(destination)],
    );
  });
  return await listSources();
}

export async function listSources(): Promise<TelegramSource[]> {
  const result = await db.query(
    "SELECT id, external_id, name, access, enabled, active, metadata, collection_cursor FROM sources WHERE connector_type='telegram' ORDER BY name,id",
  );
  return result.rows.map((row: unknown) => parseSource(row));
}

export async function prepareBatchSources(batchId: string): Promise<TelegramSource[]> {
  await db.query(
    `INSERT INTO batch_sources(batch_id,source_id,cursor_before)
     SELECT $1,id,collection_cursor FROM sources
     WHERE connector_type='telegram' AND enabled AND active
       AND NOT EXISTS(SELECT 1 FROM batch_sources bs JOIN sources prior ON prior.id=bs.source_id
         WHERE bs.batch_id=$1 AND prior.connector_type='telegram')
     ON CONFLICT(batch_id,source_id) DO NOTHING`,
    [batchId],
  );
  const result = await db.query(
    `SELECT s.id,s.external_id,s.name,s.access,s.enabled,s.active,s.metadata,
            bs.cursor_before AS collection_cursor
     FROM batch_sources bs JOIN sources s ON s.id=bs.source_id
     WHERE bs.batch_id=$1 AND bs.status <> 'completed' AND s.connector_type='telegram'
     ORDER BY s.id`,
    [batchId],
  );
  return result.rows.map((row: unknown) => parseSource(row));
}
