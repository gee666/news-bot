import { expect, it, vi } from 'vitest';
import { applyPanelResult } from './panel-refresh';

it('updates successful panels independently, retains failed panels, and hides failure details', async () => {
  const sources = vi.fn();
  const primarySources = vi.fn();
  const status = vi.fn();
  const [telegram, primary, dashboard] = await Promise.allSettled([
    Promise.resolve(['channel']), Promise.reject(new Error('SECRET-provider-body')), Promise.resolve({ completed: 2 }),
  ]);
  expect(applyPanelResult(telegram, sources, 'Telegram sources')).toBe('');
  const error = applyPanelResult(primary, primarySources, 'primary sources');
  expect(error).toContain('Could not load primary sources');
  expect(error).not.toContain('SECRET');
  expect(primarySources).not.toHaveBeenCalled();
  expect(applyPanelResult(dashboard, status, 'status')).toBe('');
  expect(sources).toHaveBeenCalledWith(['channel']);
  expect(status).toHaveBeenCalledWith({ completed: 2 });
  expect(applyPanelResult({ status: 'fulfilled', value: [] }, primarySources, 'primary sources')).toBe('');
  expect(primarySources).toHaveBeenCalledWith([]);
});
