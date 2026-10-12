import { describe, expect, it } from 'vitest';
import { eventComparison } from './consolidation-input.js';
import { jevTemplates } from '../models/templates.js';
import { consolidationContext } from './consolidation.js';

describe('event identity inputs', () => {
  it('propagates the durable caller attempt and request owner instead of resetting retries', () => {
    expect(consolidationContext('story', { id: 'stage', batchId: 'batch', attempt: 4 }))
      .toEqual({ id: 'stage', storyId: 'story', revisionId: null, batchId: 'batch', attempt: 4 });
    expect(() => consolidationContext('story', { id: 'stage', batchId: null, attempt: 0 })).toThrow();
  });
  it('uses the fuller aggregate as context in either arrival order without dropping claims', () => {
    const preview = 'Новый тариф дороже 200$, с большими лимитами.';
    const aggregate = [
      'По слухам, Астра сможет работать в 8 раз быстрее.',
      'Запустили Ultrafast для Astra: в 8 раз быстрее. Новый тариф за $500, лимиты x25.',
      'Ultrafast: обещают 300 токенов в секунду, только в тарифе за 500 долларов.',
    ].join('\n\n');
    expect(eventComparison(preview, aggregate)).toEqual({ mention: preview, candidate: aggregate });
    expect(eventComparison(aggregate, preview)).toEqual(eventComparison(preview, aggregate));
    expect(eventComparison('same', 'same')).toEqual({ mention: 'same', candidate: 'same' });
  });
  it('keeps event identity binary; new information is a freshness decision, not a competing identity class', () => {
    expect(Object.keys(jevTemplates.duplicate.questions.relation.criteria)).toEqual(['same', 'different']);
    expect(jevTemplates.duplicate.version).toBe('duplicate-v4');
  });
});
