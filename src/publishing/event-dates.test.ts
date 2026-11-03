import { describe, expect, it } from 'vitest';
import { admitPublicationInputs } from './input-admission.js';
import { reportBoundary, type PublicationBoundary } from './input-evidence.js';
import type { PrimaryEventDate } from './event-dates.js';

const now = Date.parse('2026-11-03T08:00:00Z');
const primary = (publishedAt: string | null): PrimaryEventDate => ({
  evidenceId: 'f70c22db-c60d-43e9-818b-45ba6cc8feb2',
  url: 'https://blog.google/innovation-and-ai/technology/developers-tools/embeddinggemma-2/', publishedAt,
});
function recap(dates: PrimaryEventDate[]): PublicationBoundary {
  return { ...reportBoundary([{ item_id: '1c55af11-373e-4d18-acd2-569452695a57', content_hash: 'november-monthly-recap',
    text: 'EmbeddingGemma 2 is available', source_time: '2026-11-02T12:00:00Z', urls: [] }]), primaryEventDates: dates };
}
const empty: PublicationBoundary = { version: 'publication-input-v2', inputs: [] };

describe('informational primary event dates', () => {
  it.each(['2026-10-06', '2026-10-08', '2026-10-14', '2026-10-15', '2026-10-27'])(
    'allows the fresh Nov 2 recap discussing an old %s primary', date => {
      expect(admitPublicationInputs(recap([primary(`${date}T00:00:00.000Z`)]), empty, false, true, 48, now))
        .toEqual({ allowed: true });
    });
  it.each([null, '2026-11-03T07:00:00.000Z', '2026-12-01T00:00:00.000Z'])(
    'does not use additional primary date %s for admission', date => {
      expect(admitPublicationInputs(recap([primary('2026-10-06T00:00:00.000Z'), primary(date)]), empty, false, true, 48, now))
        .toEqual({ allowed: true });
    });
  it('applies the current collection window to the report date, not the event date', () => {
    const input = recap([primary('2026-10-06T00:00:00.000Z')]);
    expect(admitPublicationInputs(input, empty, false, true, 20, now)).toEqual({ allowed: true });
    expect(admitPublicationInputs(input, empty, false, true, 19, now))
      .toEqual({ allowed: false, reason: 'stale_source_input' });
    const oldReport = { ...input, inputs: input.inputs.map(input => ({ ...input, sourceTime: '2026-10-21T12:00:00Z' })),
      primaryEventDates: [primary('2026-11-03T07:00:00.000Z')] };
    expect(admitPublicationInputs(oldReport, empty, false, true, 48, now))
      .toEqual({ allowed: false, reason: 'stale_source_input' });
  });
  it('leaves all-undated event age unknown rather than manufacturing a date', () => {
    const input = recap([primary(null)]);
    expect(input.primaryEventDates?.[0]?.publishedAt).toBeNull();
    expect(admitPublicationInputs(input, empty, false, true, 48, now)).toEqual({ allowed: true });
  });
  it('allows a saved v2 input baseline without event dates but still rejects unchanged reprocessing', () => {
    const input = recap([]);
    const previous: PublicationBoundary = { version: 'publication-input-v2', inputs: input.inputs };
    expect(admitPublicationInputs(previous, empty, false, true, 48, now)).toEqual({ allowed: true });
    expect(admitPublicationInputs(input, previous, true, true, 48, now))
      .toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
});
