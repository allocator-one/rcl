import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { HarnessSink } from '../../src/telemetry/sink.js';
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const credential = { url:'http://127.0.0.1:41230',token:'aone_SYNTHETIC_LOCAL_ONLY',source:'env' as const };
it('compares raw bytes without UTF-8 reinterpretation and bounds streamed and nonstreamed artifact responses', async () => {
  const bytes=Buffer.from([0xff,0x00,0x81]);
  for(const streamed of [true,false]) {
    const fetchImpl=(async()=>streamed ? new Response(bytes,{headers:{'x-artifact-sha256':hash(bytes)}}) : ({status:200,body:null,headers:new Headers({'x-artifact-sha256':hash(bytes)}),arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)}) as Response) as typeof fetch;
    const sink=new HarnessSink({credential,rclVersion:'3.7.0',fetchImpl});
    const result=await sink.getArtifact('original','report_json',3);
    expect(result.kind).toBe('ok');if(result.kind==='ok')expect(result.value.bytes).toEqual(bytes);
    expect(await sink.getArtifact('original','report_json',2)).toMatchObject({kind:'rejected',error:'malformed_artifact_response'});
  }
});
it('refuses redirects, absent/wrong digest headers and arbitrary artifact path selections', async()=>{
  const requests: RequestInit[]=[];
  const fetchImpl=(async(_url:unknown,init?:RequestInit)=>{requests.push(init!);return new Response('',{status:302,headers:{location:'https://elsewhere.invalid'}});}) as typeof fetch;
  const sink=new HarnessSink({credential,rclVersion:'3.7.0',fetchImpl});
  expect(await sink.getArtifact('x/../../elsewhere','report_json',10)).toMatchObject({kind:'rejected',error:'redirected'});
  expect(requests[0]!.redirect).toBe('manual');
  expect(await sink.getArtifact('x','../../elsewhere' as 'report_json',10)).toMatchObject({kind:'rejected',error:'unknown_artifact_kind'});expect(requests).toHaveLength(1);
  for(const digest of [undefined,'a'.repeat(64)]) {
    const s=new HarnessSink({credential,rclVersion:'3.7.0',fetchImpl:(async()=>new Response('original',{headers:digest?{'x-artifact-sha256':digest}:{}})) as typeof fetch});
    expect(await s.getArtifact('x','report_json',8)).toMatchObject({kind:'rejected',error:'malformed_artifact_response'});
  }
});
