import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

export async function mount(node: ReactNode) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  return { container,
    async rerender(next: ReactNode) { await act(async () => root.render(next)); },
    async unmount() { await act(async () => root.unmount()); container.remove(); } };
}
export function element<T extends Element>(container: Element, selector: string, type: { new(): T }): T {
  const found = container.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`Missing ${selector}`);
  return found;
}
export async function click(button: HTMLElement) {
  await act(async () => button.click());
}
export async function input(control: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = control instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLSelectElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(control, value);
  await act(async () => { control.dispatchEvent(new Event(control instanceof HTMLInputElement ? 'input' : 'change', { bubbles: true })); });
}
