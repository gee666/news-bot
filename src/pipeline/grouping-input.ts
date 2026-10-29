import type { EventInput } from './consolidation-input.js';

/** Aggregate text duplicates reports. Keep full text, URLs and dates exactly once. */
export function groupingState(incoming: EventInput, candidate: EventInput) {
  const evidence = ({ id, reports }: EventInput) => ({ id, reports });
  return { incoming: evidence(incoming), candidate: evidence(candidate) };
}
