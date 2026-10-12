export function applyPanelResult<T>(
  result: PromiseSettledResult<T>, update: (value: T) => void, label: string,
): string {
  if (result.status === 'fulfilled') {
    update(result.value);
    return '';
  }
  return `Could not load ${label}. Showing the last loaded data, if available. Retrying automatically.`;
}
