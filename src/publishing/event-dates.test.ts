import { describe, expect, it } from 'vitest';
import { admitPublicationInputs } from './input-admission.js';
import { reportBoundary, type PublicationBoundary } from './input-evidence.js';
import { stalePrimaryEvent, type PrimaryEventDate } from './event-dates.js';

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

describe('known primary event age', () => {
  it.each(['2026-10-06', '2026-10-08', '2026-10-14', '2026-10-15', '2026-10-27'])(
    'rejects an old %s primary despite the recent Nov 2 recap on a first publication', date => {
      expect(admitPublicationInputs(recap([primary(`${date}T00:00:00.000Z`)]), empty, false, true, 48, now))
        .toEqual({ allowed: false, reason: 'stale_source_input' });
    });
  it('does not let an undated primary erase a known old event date', () => {
    expect(admitPublicationInputs(recap([primary('2026-10-06T00:00:00.000Z'), primary(null)]), empty, false, true, 48, now))
      .toEqual({ allowed: false, reason: 'stale_source_input' });
  });
  it.each(['2026-11-02T12:00:00.000Z', '2026-11-03T07:00:00.000Z'])(
    'allows a genuinely recent %s primary alongside old primary background', date => {
      expect(admitPublicationInputs(recap([primary('2026-10-06T00:00:00.000Z'), primary(date)]), empty, false, true, 48, now))
        .toEqual({ allowed: true });
    });
  it('uses the collection window, including its exact boundary, without treating future dates as recent proof', () => {
    expect(stalePrimaryEvent([primary('2026-11-01T08:00:00.000Z')], 48, now)).toBe(false);
    expect(stalePrimaryEvent([primary('2026-11-01T08:00:00.000Z')], 24, now)).toBe(true);
    expect(stalePrimaryEvent([primary('2026-12-01T00:00:00.000Z')], 48, now)).toBe(true);
  });
  it('leaves all-undated event age unknown rather than manufacturing a date', () => {
    const input = recap([primary(null)]);
    expect(input.primaryEventDates?.[0]?.publishedAt).toBeNull();
    expect(admitPublicationInputs(input, empty, false, true, 48, now)).toEqual({ allowed: true });
  });
  it('blocks a pre-fix prepared baseline without event-date provenance but still compares it as published input', () => {
    const input = recap([]);
    const previous: PublicationBoundary = { version: 'publication-input-v2', inputs: input.inputs };
    expect(admitPublicationInputs(previous, empty, false, true, 48, now))
      .toEqual({ allowed: false, reason: 'publication_input_unverifiable' });
    expect(admitPublicationInputs(input, previous, true, true, 48, now))
      .toEqual({ allowed: false, reason: 'no_new_source_input' });
  });
});
