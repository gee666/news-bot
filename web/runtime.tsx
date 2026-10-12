import type { RuntimeStatus } from './api';

export function runtimeAccess(runtime: RuntimeStatus | null, error: string) {
  if (error) return { mutationsBlocked: true, label: 'Runtime status unavailable',
    message: 'Changes and manual runs are disabled until runtime permissions can be verified. Read-only views and filters remain available. Retrying automatically.' };
  if (!runtime) return { mutationsBlocked: true, label: 'Checking runtime status',
    message: 'Changes and manual runs are disabled until the server reports its runtime permissions. Read-only views and filters remain available.' };
  if (!runtime.manualMutationsAllowed) return { mutationsBlocked: true, label: 'Manual changes are disabled',
    message: `The server has disabled API mutations. Automatic work is ${runtime.automaticWorkEnabled ? 'enabled' : 'disabled'}. Read-only views and filters remain available.` };
  if (!runtime.automaticWorkEnabled) return { mutationsBlocked: false, label: 'Automatic work is disabled',
    message: 'Automatic collection, processing and publication are disabled. The server still allows manual actions and changes.' };
  return { mutationsBlocked: false, label: 'Automatic work enabled', message: '' };
}

export function RuntimeNotice({ access }: { access: ReturnType<typeof runtimeAccess> }) {
  return <div role="status" aria-live="polite">{access.message ? <div className="runtime-notice">
    <strong>{access.label}</strong><p>{access.message}</p>
  </div> : <span className="visually-hidden">{access.label}. Manual changes are allowed.</span>}</div>;
}
