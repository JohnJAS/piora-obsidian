import {validateNotePath} from "./core";
export interface SearchFile {path:string;bytes:number}
export interface SearchHit {path:string;snippet:string;score:number}
export interface SearchResult {hits:SearchHit[];scanned:number;skipped:number;limited:boolean}
export interface SearchSource {files:SearchFile[];read:(path:string)=>Promise<string>}
export async function searchNotes(source:SearchSource,query:string,options:{folder?:string;signal?:AbortSignal}={}):Promise<SearchResult> {
  const terms=[...new Set(query.trim().toLowerCase().split(/\s+/))];
  if(!query.trim()||query.length>200)throw new Error("请输入 1–200 字符的检索词");
  const folder=options.folder?.trim().replace(/\/$/,"")??"";if(folder)validateNotePath(folder+"/search.md");
  const checkAbort=()=>{if(options.signal?.aborted)throw new Error("检索已取消");};checkAbort();
  const files=[...new Map(source.files.filter(file=>{try{validateNotePath(file.path);return !folder||file.path.startsWith(folder+"/");}catch{return false;}}).map(file=>[file.path,file])).values()].sort((first,second)=>first.path.localeCompare(second.path));
  const result:SearchResult={hits:[],scanned:0,skipped:0,limited:files.length>500};let bytes=0;
  for(const file of files.slice(0,500)){
    checkAbort();
    if(!Number.isSafeInteger(file.bytes)||file.bytes<0||file.bytes>256*1024){result.skipped++;continue;}
    if(bytes+file.bytes>8*1024*1024){result.limited=true;break;}
    let text:string;
    try{text=await source.read(file.path);}catch{checkAbort();result.skipped++;continue;}
    checkAbort();const size=Buffer.byteLength(text);bytes+=Math.max(size,file.bytes);result.scanned++;
    if(size>256*1024){result.skipped++;continue;}
    if(bytes>8*1024*1024){result.limited=true;break;}
    const path=file.path.toLowerCase();const body=text.toLowerCase();
    if(terms.every(term=>path.includes(term)||body.includes(term))){
      const score=terms.reduce((total,term)=>total+(path.includes(term)?10:0)+(body.includes(term)?1:0),0);
      const matches=terms.map(term=>body.indexOf(term)).filter(index=>index>=0);const start=Math.max(0,(matches.length?Math.min(...matches):0)-80);
      result.hits.push({path:file.path,snippet:(start?"…":"")+text.slice(start,start+240)+(text.length>start+240?"…":""),score});
      result.hits.sort((first,second)=>second.score-first.score||first.path.localeCompare(second.path));if(result.hits.length>20){result.hits.pop();result.limited=true;}
    }
    if(result.scanned%25===0)await new Promise(resolve=>setTimeout(resolve,0));
  }
  checkAbort();return result;
}
