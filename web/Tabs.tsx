import { useRef, type KeyboardEvent } from 'react';

export const tabs = [
  { id: 'activity', label: 'Activity' },
  { id: 'usage', label: 'Usage & costs' },
  { id: 'sources', label: 'Sources' },
  { id: 'settings', label: 'Settings' },
  { id: 'connections', label: 'Connections' },
] as const;
export type Tab = typeof tabs[number]['id'];

export function Tabs({ selected, select }: { selected: Tab; select: (tab: Tab) => void }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const navigate = (event: KeyboardEvent, index: number) => {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    const tab = tabs[next];
    if (tab) { select(tab.id); buttons.current[next]?.focus(); }
  };
  return <nav aria-label="Workspace"><div className="tabs" role="tablist" aria-label="News bot workspace">
    {tabs.map((tab, index) => <button key={tab.id} ref={node => { buttons.current[index] = node; }}
      type="button" role="tab" id={`tab-${tab.id}`} aria-controls={`panel-${tab.id}`}
      aria-selected={selected === tab.id} tabIndex={selected === tab.id ? 0 : -1}
      onClick={() => select(tab.id)} onKeyDown={event => navigate(event, index)}>{tab.label}</button>)}
  </div></nav>;
}
