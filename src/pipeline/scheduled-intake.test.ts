import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {defaultSettings} from '../settings.js';
const query=vi.hoisted(()=>vi.fn<(sql:string,args?:unknown[])=>Promise<{rows:unknown[]}>>().mockResolvedValue({rows:[]}));
vi.mock('../db.js',()=>({db:{query}}));
import {requestLatestScheduledIntake} from './scheduled-intake.js';
beforeEach(()=>vi.clearAllMocks());
afterEach(()=>vi.restoreAllMocks());
it('catches up the latest missed Berlin slot without replaying every lost collection',async()=>{
  await requestLatestScheduledIntake(defaultSettings,new Date('2026-10-13T21:27:00Z'));
  expect(query).toHaveBeenCalledOnce();
  expect(query.mock.calls[0]?.[1]).toEqual(['scheduled_intake:2026-10-13T19:00:00.000Z',JSON.stringify({slot:'2026-10-13T19:00:00.000Z'})]);
  expect(query.mock.calls[0]?.[0]).toContain('ON CONFLICT DO NOTHING');
});
it('uses the cron matcher for DST and explicit seconds',async()=>{
  await requestLatestScheduledIntake({...defaultSettings,collectionCron:'15 30 2 * * *'},new Date('2026-10-25T02:00:00Z'));
  expect(query.mock.calls[0]?.[1]?.[0]).toBe('scheduled_intake:2026-10-25T01:30:15.000Z');
});
it('does not replay a stale infrequent slot outside the collection window',async()=>{
  await requestLatestScheduledIntake({...defaultSettings,collectionCron:'0 0 1 * *'},new Date('2026-10-13T21:00:00Z'));
  expect(query).not.toHaveBeenCalled();
});
