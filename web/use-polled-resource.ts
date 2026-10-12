import { useCallback, useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import { request } from './api';

interface Snapshot<T> { path: string; data: T | null; error: string; loading: boolean }

export function usePolledResource<T>(path: string, schema: z.ZodType<T>, active: boolean, failureMessage: string, intervalMs = 30000) {
  const [snapshot, setSnapshot] = useState<Snapshot<T>>({ path, data: null, error: '', loading: active });
  const refreshRequest = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRequest.current(), []);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const run = () => {
      if (disposed || inFlight) return;
      clearTimeout(timer);
      inFlight = true;
      controller = new AbortController();
      setSnapshot(previous => ({ path, data: previous.path === path ? previous.data : null,
        error: previous.path === path ? previous.error : '', loading: true }));
      void request(path, schema, undefined, 'GET', controller.signal).then(data => {
        if (!disposed) setSnapshot({ path, data, error: '', loading: false });
      }).catch(() => {
        if (!disposed) setSnapshot(previous => ({ ...previous, error: failureMessage, loading: false }));
      }).finally(() => {
        inFlight = false;
        // Schedule from completion so a slow request is never replaced by its next poll.
        if (!disposed) timer = setTimeout(run, intervalMs);
      });
    };
    refreshRequest.current = run;
    run();
    return () => {
      disposed = true;
      refreshRequest.current = () => {};
      clearTimeout(timer);
      controller?.abort();
    };
  }, [path, schema, active, failureMessage, intervalMs]);
  return { data: snapshot.path === path ? snapshot.data : null,
    error: snapshot.path === path ? snapshot.error : '',
    loading: active && (snapshot.path !== path || snapshot.loading), refresh };
}
