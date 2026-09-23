import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fixture, cleanup } from './round-gap-fixtures.js';
import { loadConvergeRunState } from '../../src/converge/run-state.js';
const fault=vi.hoisted(()=>({suffix:'',fail:false,failed:0,synced:0,skip:0}));
vi.mock('node:fs/promises',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs/promises')>();
  return {...actual,open:async(...args:Parameters<typeof actual.open>)=>{
    const handle=await actual.open(...args);
    if(!fault.suffix||!String(args[0]).endsWith(fault.suffix))return handle;
    return new Proxy(handle,{get(target,key){
      if(key==='sync')return async()=>{if(fault.fail&&fault.skip--<=0){fault.failed++;throw Object.assign(new Error('synthetic fsync EIO'),{code:'EIO'});} await target.sync();fault.synced++;};
      const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
    }});
  }};
});
afterEach(async()=>{fault.suffix='';fault.fail=false;fault.failed=0;fault.synced=0;fault.skip=0;await cleanup();});
it.each(['native-before.json','attempts-before.json','source-0.bin','native-after.json'])(
  'refuses persistent initial fsync failure and resyncs identical retained %s before success',async suffix=>{
    const f=await fixture();await f.prepare();const before=await readFile(f.statePath);
    fault.suffix=suffix;fault.fail=true;
    await expect(f.apply()).rejects.toThrow('synthetic fsync EIO');
    await expect(f.apply('resume')).rejects.toThrow('synthetic fsync EIO');
    expect(fault.failed).toBe(2);expect(await readFile(f.statePath)).toEqual(before);
    fault.fail=false;expect(await f.apply('resume')).toBe('applied');expect(fault.synced).toBeGreaterThan(0);
    expect((await loadConvergeRunState(f.dir,f.target))?.roundGapAudit?.entries).toHaveLength(1);
  });
it('resyncs a fully written checkpoint after failed initial file fsync before native mutation',async()=>{
  const f=await fixture();await f.prepare();const before=await readFile(f.statePath);
  fault.suffix='00000001.json';fault.fail=true;
  await expect(f.apply()).rejects.toThrow('synthetic fsync EIO');
  await expect(f.apply('resume')).rejects.toThrow('synthetic fsync EIO');
  expect(await readFile(f.statePath)).toEqual(before);fault.fail=false;
  expect(await f.apply('resume')).toBe('applied');expect(fault.synced).toBeGreaterThan(0);
});
it('resyncs the native directory before acknowledging a renamed but not durably synced audit',async()=>{
  const f=await fixture();await f.prepare();fault.suffix='rcl-converge-runs';fault.fail=true;fault.skip=1;
  await expect(f.apply()).rejects.toThrow('synthetic fsync EIO');
  const committed=await readFile(f.statePath);expect((await loadConvergeRunState(f.dir,f.target))?.roundGapAudit?.entries).toHaveLength(1);
  await expect(f.apply('resume')).rejects.toThrow('synthetic fsync EIO');
  fault.fail=false;expect(await f.apply('resume')).toBe('resumed');expect(fault.synced).toBeGreaterThan(0);
  expect(await readFile(f.statePath)).toEqual(committed);
});
