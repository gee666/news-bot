export const EVENT_INTEGRITY_FAILED = 'event_integrity_failed';

/** A known mixed event is withheld locally; transport and unexpected failures still stop processing. */
export class StoryIntegrityError extends Error {
  readonly code = EVENT_INTEGRITY_FAILED;
  constructor(readonly storyId: string, readonly inputFingerprint: string) {
    super('Story contains unconnected event reports');
    this.name = 'StoryIntegrityError';
  }
}
