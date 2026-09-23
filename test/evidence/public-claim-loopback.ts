import { createServer } from 'node:http';
import { execFile,spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,mkdir,writeFile,readFile,realpath,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture as occurrenceFixture } from './recovery-validation/occurrence-fixtures.js';
import { convergeRunStatePath } from '../../src/converge/run-state.js';
import { sha,uuid } from './recovery-validation/fixtures.js';
export async function publicLoopback(input=occurrenceFixture(),commandTimeout=25000) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'rcl-public-mode-b-')));
  const repo=join(root,'repo');
  await mkdir(repo,{ mode: 0o700 });
  await promisify(execFile)('git',['init','-q'],{ cwd: repo });
  const common=join(repo,'.git');
  const f=input;
  const source=f.transfer.split.source;
  const original=f.transfer.split.selection;
  const actor=uuid(900);
  let sequence=2;
  const receipts: any[]=[source.classification,f.originalVerdict];
  const rows=[{ source,receipts }];
  const calls: Array<{
    method: string;
    path: string;
    body?: unknown;
  }>=[];
  let loseAck=false;
  let omitReceipts=false;
  let hideAfterPost=false;
  let hideAfterPostCount=1;
  let deferPostCount=0;
  let change: (body: any,url: URL) => any=body => body;
  const server=createServer(async (req,res) => {
    try {
      const url=new URL(req.url!,'http://127.0.0.1');
      const method=req.method!;
      const chunks: Buffer[]=[];
      for await(const chunk of req)
        chunks.push(Buffer.from(chunk));
      const request=chunks.length? JSON.parse(Buffer.concat(chunks).toString()):undefined;
      calls.push({ method,path: url.pathname+url.search,...(request? { body: request }:{}) });
      if(req.headers.authorization!=='Bearer synthetic-only') {
        res.writeHead(401);
        res.end();
        return;
      }
      let body: any;
      const row=rows.find(r => url.pathname.includes('/runs/'+r.source.scope.run_id))??rows[0]!;
      const selectedSource=row.source;
      const selectedReceipts=row.receipts;
      const selectedSequence=Math.max(0,...selectedReceipts.map(r => r.sequence));
      if(method==='POST'&&url.pathname==='/api/v1/reviews/converge/events') {
        if(calls.filter(c=>c.method==='POST').length===deferPostCount) {req.socket.destroy();return;}
        for(const event of request.events) {
          const old=receipts.find(r => r.id===event.id);
          if(old)
            continue;
          if(event.payload.expected_event_sequence!==sequence) {
            res.writeHead(409);
            res.end('{}');
            return;
          }
          receipts.push({
            ...event,org_id: source.scope.org_id,repo: source.scope.repo,pr_number: source.scope.pr_number,attempt: null,
            actor_user_id: actor,sequence: ++sequence,received_at: new Date().toISOString()
          });
        }
        if(hideAfterPost&&calls.filter(c=>c.method==='POST').length>=hideAfterPostCount) {
          omitReceipts=true;
          req.socket.destroy();
          return;
        }
        if(loseAck) {
          req.socket.destroy();
          return;
        }
        body={ data: { inserted: 1,duplicates: 0 } };
      }
      else if(method!=='GET') {
        res.writeHead(405);
        res.end();
        return;
      }
      else if(url.pathname==='/api/v1/reviews/runs')
        body={
          data: rows.map(r => ({ id: r.source.scope.run_id,target: r.source.storedRun.target,converge: r.source.storedRun.converge })),
          meta: { org_id: source.scope.org_id,evidence_protocol_version: 2,page: 1,page_size: 100,total: rows.length,total_pages: 1 }
        };
      else if(url.pathname.endsWith('/artifacts/report_json')) {
        res.writeHead(200,{ 'x-artifact-sha256': sha(selectedSource.reportJson) });
        res.end(selectedSource.reportJson);
        return;
      }
      else if(url.pathname.endsWith('/events')) {
        if(url.searchParams.get('index')==='claim_recovery') {
          const after=Number(url.searchParams.get('after_sequence')),through=Number(url.searchParams.get('through_sequence'));
          const selected=selectedReceipts.filter(r => r.sequence>after&&r.sequence<=through).slice(0,50);
          const more=selectedReceipts.some(r => r.sequence>(selected.at(-1)?.sequence??after)&&r.sequence<=through);
          body={
            data: selected.map(({ id,sequence,kind }) => ({ id,sequence,kind })),meta: {
              org_id: source.scope.org_id,run_id: selectedSource.scope.run_id,
              claim_recovery_version: 1,through_sequence: through,next_after_sequence: more? selected.at(-1).sequence:null,complete: !more
            }
          };
        }
        else {
          const ids=url.searchParams.get('ids')!.split(',');
          body={
            data: omitReceipts? []:selectedReceipts.filter(r => ids.includes(r.id)),
            meta: { org_id: source.scope.org_id,run_id: selectedSource.scope.run_id,claim_recovery_version: 1 }
          };
        }
      }
      else
        body={
          data: projectedRun(selectedSource.storedRun,selectedReceipts),meta: {
            org_id: source.scope.org_id,actor_user_id: actor,evidence_protocol_version: 2,claim_recovery_version: 1,
            recovery: {
              event_sequence: selectedSequence,truncated: false,classification_event: {
                id: selectedSource.classification.id,sequence: selectedSource.classification.sequence,round: selectedSource.classification.round,
                identities: selectedSource.classification.payload.identities,...(selectedSource.classification.payload.classification_version===1? { classification_version: 1,report_json_sha256: selectedSource.classification.payload.report_json_sha256,legacy_pending_identities: selectedSource.classification.payload.legacy_pending_identities }:{})
              },native_corrections: [],claim_events_complete: true,claim_events: selectedReceipts.map(({ id,sequence,kind }) => ({ id,sequence,kind }))
            }
          }
        };
      res.writeHead(200,{ 'content-type': 'application/json' });
      res.end(JSON.stringify(change(body,url)));
    }
    catch {
      res.writeHead(500);
      res.end('{}');
    }
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {
    port: number;
  };
  const url=`http://127.0.0.1:${address.port}`;
  source.scope.base_url=url;
  original.scope.base_url=url;
  const statePath=convergeRunStatePath(common,original.target);
  await mkdir(dirname(statePath),{ recursive: true,mode: 0o700 });
  await writeFile(statePath,original.nativeJson,{ mode: 0o600 });
  const operation=join(root,'operation');
  await mkdir(operation,{ mode: 0o700 });
  const selection={
    version: 1,source: {
      scope: source.scope,target: original.target,
      round: source.classification.round!,headSha: (source.storedRun.target as any).head_sha,reportSha256: sha(source.reportJson)
    },findingRef: original.findingRef,
    previousIdentity: original.previousIdentity,identity: original.identity,descriptor: original.descriptor,reason: original.reason,
    disposition: { mode: 'fresh',verdict: 'dismissed',severity: 'important',reason: 'Synthetic individual source adjudication.' }
  };
  const selectionPath=join(operation,'selection.json');
  await writeFile(selectionPath,JSON.stringify(selection),{ mode: 0o600 });
  const manifest=join(operation,'manifest.json');
  function replaceOriginal(report: any) {
    source.reportJson=JSON.stringify(report);
    original.reportJson=source.reportJson;
    selection.source.reportSha256=sha(source.reportJson);
    const all=[...report.findings,...report.belowThresholdFindings];
    source.storedRun.artifacts=[{ kind: 'report_json',declared_sha256: sha(source.reportJson),declared_bytes: Buffer.byteLength(source.reportJson),stored: true }];
    (source.storedRun.findings as any[]).forEach((row,i) => { row.claim_descriptor=all[i].claimDescriptor??null; });
    (source.classification.payload.identities as any[]).forEach((row,i) => {
      if(all[i].claimDescriptor)
        row.claim_descriptor=all[i].claimDescriptor;
      else
        delete row.claim_descriptor;
    });
  }
  const env={
    PATH: process.env.PATH,HOME: root,XDG_CONFIG_HOME: join(root,'config'),RCL_DATA_DIR: join(root,'data'),RCL_NO_HARNESS_KEYS: '1',
    HARNESS_API_URL: url,HARNESS_API_TOKEN: 'synthetic-only',GIT_CONFIG_GLOBAL: '/dev/null',GIT_CONFIG_SYSTEM: '/dev/null'
  };
  for(const key of ['NODE_OPTIONS','RCL_GUARD_LOG','RCL_GUARD_LOOPBACK'])
    if(process.env[key])
      Object.assign(env,{ [key]: process.env[key] });
  const entry=process.env.RCL_TEST_PACKAGED_CLI??fileURLToPath(new URL('../../dist/index.js',import.meta.url));
  async function command(args: string[]) {
    return new Promise<{
      exit: number|null;
      stdout: string;
      stderr: string;
    }>(resolve => {
      const child=spawn(process.execPath,[entry,'evidence','recover-claim',...args],{ cwd: repo,env,timeout: commandTimeout,stdio: ['ignore','pipe','pipe'] });
      let stdout='',stderr='';
      child.stdout.on('data',b => stdout+=b);
      child.stderr.on('data',b => stderr+=b);
      child.on('close',exit => resolve({ exit,stdout,stderr }));
    });
  }
  return {
    root,source,original,selection,replaceOriginal,addReceipt: (receipt: any) => { receipts.push({ ...receipt,sequence: ++sequence }); },addSource: (value: typeof source) => { value.scope.base_url=url; rows.push({ source: value,receipts: [value.classification,...value.corrections] }); },selectionPath,manifest,statePath,calls,receipts,command,
    preview: () => command(['--preview','--selection',selectionPath,'--manifest',manifest,'--json']),
    execute: async (mode='apply') => command([`--${mode}`,'--manifest',manifest,'--manifest-sha256',sha(await readFile(manifest,'utf8')),'--json']),
    loseAck: () => { loseAck=true; },deferPostAt: (count:number) => {deferPostCount=count;},hideAfterPost: (value=true,count=1) => {
      hideAfterPost=value;hideAfterPostCount=count; if(!value)
        omitReceipts=false;
    },omitReceipts: (v=true) => { omitReceipts=v; },change: (fn: typeof change) => { change=fn; },
    cleanup: async (preserve = false) => { await new Promise<void>((resolve,reject) => server.close(e => e? reject(e):resolve())); if (!preserve) await rm(root,{ recursive: true,force: true }); }
  };
}

/** Match the backend's read-only ClaimSplits.project/2 finding projection. */
export function projectedRun(storedRun: Record<string,unknown>,receipts: any[]) {
  const result=structuredClone(storedRun);
  for(const finding of result.findings as any[]) {
    const event=receipts.find(r=>r.kind==='finding_claim_split'&&r.payload.finding_ref===finding.ref);
    if(!event) continue;
    finding.claim_identity=event.payload.matched_identity;
    finding.identity_provenance={
      source: 'semantic_split',event_id: event.id,actor_user_id: event.actor_user_id,
      reason: event.payload.reason,previous_identity: event.payload.previous_identity,
      report_json_sha256: event.payload.report_json_sha256,claim_descriptor: event.payload.claim_descriptor,
      native_evidence: event.payload.native_evidence,source_event_ids: event.payload.source_event_ids,
      received_at: event.received_at
    };
    if(Object.hasOwn(finding,'verdict')) finding.verdict=null;
  }
  return result;
}
