import { createHash } from 'node:crypto';
import { decodeRecoveryDocument } from '../../original-run/decode.js';
export interface RecoveryMaterial {
  sha256: string;
  text: string;
}
export interface RecoveryMaterialReference {
  version: 1;
  rootSha256: string;
}
const MAX_BYTES=64*1024*1024;
const MAX_MATERIALS=20_000;
const MAX_NODES=500_000;
const MAX_DECODE_DEPTH=256;
const digest=(text: string) => createHash('sha256').update(text).digest('hex');
const requireMaterial=(condition: unknown): void => {
  if(!condition)
    throw new Error('recovery_material_conflict');
};
type Node=[
  0,
  null|boolean|number|string
]|[
  1,
  Node[]
]|[
  2,
  Array<[
    string,
    Node
  ]>
]|[
  3,
  string
]|[
  4,
  string
];
/** Lossless tagged encoding; original object keys cannot masquerade as references.
 * Large strings (including original JSON) are retained once by their raw digest. */
export function packRecoveryMaterial(value: unknown): {
  rootSha256: string;
  materials: RecoveryMaterial[];
} {
  const active=new Set<object>();
  let nodes=0;
  const rows=new Map<string,string>();
  let bytes=0;
  const retain=(text: string): string => {
    const sha=digest(text); if(!rows.has(sha)) {
      bytes+=Buffer.byteLength(text);
      requireMaterial(bytes<=MAX_BYTES&&rows.size<MAX_MATERIALS);
      rows.set(sha,text);
    } return sha;
  };
  const encode=(v: unknown,depth: number): {node: Node; decodeDepth: number} => {
    requireMaterial(depth<=128&&++nodes<=MAX_NODES);
    if(typeof v==='string'&&Buffer.byteLength(v)>1024&&!/[\uD800-\uDFFF]/u.test(v))
      return {node: [3,retain(v)],decodeDepth: 0};
    let node: Node;
    let decodeDepth=0;
    const child=(value: unknown): Node => {
      const encoded=encode(value,depth+1);
      decodeDepth=Math.max(decodeDepth,encoded.decodeDepth+1);
      return encoded.node;
    };
    if(v===null||typeof v==='boolean'||typeof v==='number'||typeof v==='string') {
      requireMaterial(typeof v!=='number'||(Number.isFinite(v)&&Math.abs(v)<=Number.MAX_SAFE_INTEGER));
      node=[0,v];
    }
    else {
      requireMaterial(typeof v==='object'&&v!==null&&!active.has(v as object));
      active.add(v as object);
      if(Array.isArray(v))
        node=[1,v.map(x => child(x===undefined? null:x))];
      else {
        requireMaterial(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
        node=[2,Object.entries(v as Record<string,unknown>).filter(([,x]) => x!==undefined).map(([k,x]) => [k,child(x)])];
      }
      active.delete(v as object);
    }
    const text=JSON.stringify(node);
    if(Buffer.byteLength(text)>16384) {
      // The reader visits both the reference and its retained subtree root.
      requireMaterial(++nodes<=MAX_NODES);
      node=[4,retain(text)];
      decodeDepth++;
    }
    requireMaterial(decodeDepth<=MAX_DECODE_DEPTH);
    return {node,decodeDepth};
  };
  const rootSha256=retain(JSON.stringify(encode(value,0).node));
  return { rootSha256,materials: [...rows].map(([sha256,text]) => ({ sha256,text })) };
}
/** Decode only supplied, hash-verified material. Missing/cyclic/unknown encodings
 * and bounded expansion failures refuse; no filesystem or authority is implied. */
/** Validate every supplied row before it can be retained or decoded. */
export function validateRecoveryMaterials(materials: readonly RecoveryMaterial[]): Map<string,string> {
  requireMaterial(Array.isArray(materials)&&materials.length<=MAX_MATERIALS);
  const rows=new Map<string,string>(); let retained=0;
  for(const row of materials) {
    requireMaterial(row&&typeof row.text==='string'&&Buffer.from(row.text,'utf8').toString('utf8')===row.text&&
      /^[a-f0-9]{64}$/.test(row.sha256)&&!rows.has(row.sha256)&&digest(row.text)===row.sha256);
    retained+=Buffer.byteLength(row.text); requireMaterial(retained<=MAX_BYTES); rows.set(row.sha256,row.text);
  }
  return rows;
}
export function unpackRecoveryMaterial(rootSha256: string,materials: readonly RecoveryMaterial[]): unknown {
  const rows=validateRecoveryMaterials(materials);
  let expanded=0,nodes=0;
  const active=new Set<string>();
  const seenStrings=new Set<string>();
  const take=(sha: unknown): string => { requireMaterial(typeof sha==='string'&&/^[a-f0-9]{64}$/.test(sha)&&rows.has(sha)); return rows.get(sha as string)!; };
  const parse=(text: string) => decodeRecoveryDocument(text);
  const read=(sha: unknown,depth: number): unknown => {
    requireMaterial(typeof sha==='string'&&!active.has(sha));
    active.add(sha as string);
    const value=decode(parse(take(sha)),depth);
    active.delete(sha as string);
    return value;
  };
  const decode=(node: unknown,depth: number): unknown => {
    requireMaterial(depth<=MAX_DECODE_DEPTH&&++nodes<=MAX_NODES&&Array.isArray(node)&&node.length===2);
    const [tag,value]=node as unknown[];
    if(tag===4)
      return read(value,depth+1);
    if(tag===3) {
      const text=take(value);
      if(!seenStrings.has(value as string)) {
        expanded+=Buffer.byteLength(text);
        seenStrings.add(value as string);
      }
      requireMaterial(expanded<=MAX_BYTES);
      return text;
    }
    if(tag===0) {
      requireMaterial(value===null||['string','number','boolean'].includes(typeof value));
      expanded+=Buffer.byteLength(JSON.stringify(value));
      requireMaterial(expanded<=MAX_BYTES);
      return value;
    }
    requireMaterial(Array.isArray(value));
    if(tag===1)
      return (value as unknown[]).map(x => decode(x,depth+1));
    requireMaterial(tag===2);
    const object: Record<string,unknown>={};
    for(const entry of value as unknown[]) {
      requireMaterial(Array.isArray(entry)&&entry.length===2&&typeof entry[0]==='string'&&!Object.hasOwn(object,entry[0]));
      const [key,child]=entry as [
        string,
        unknown
      ];
      expanded+=Buffer.byteLength(key);
      requireMaterial(expanded<=MAX_BYTES);
      Object.defineProperty(object,key,{ value: decode(child,depth+1),enumerable: true,writable: true,configurable: true });
    }
    return object;
  };
  return read(rootSha256,0);
}
