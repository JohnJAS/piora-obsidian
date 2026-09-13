import {constants} from "node:fs";
import {lstat,open,opendir,realpath} from "node:fs/promises";
import {homedir} from "node:os";
import {join,relative,resolve} from "node:path";
import {isServerId,normalizeAddress} from "./core";
import {RemoteClient} from "./client";
export interface DiscoveredService {address:string;serverId:string;instanceId:string;pid:number;expiresAt:number}
export interface DiscoveryResult {services:DiscoveredService[];skipped:number;limited:boolean;source:string}
export async function probeLocalIdentity(address:string,signal?:AbortSignal):Promise<string>{
  const timeout=AbortSignal.timeout(2000);return new RemoteClient(address,()=>{throw new Error("发现过程不得读取令牌");}).identify(signal?AbortSignal.any([signal,timeout]):timeout);
}
function privateToUser(stat:{uid:number;mode:number}):boolean{return typeof process.getuid!=="function"||stat.uid===process.getuid()&&(stat.mode&0o077)===0;}
async function readRecord(path:string):Promise<Record<string,unknown>>{
  const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||before.size>4096||!privateToUser(before))throw new Error("登记文件不安全或超限");
  const file=await open(path,constants.O_RDONLY|(process.platform==="win32"?0:constants.O_NOFOLLOW));
  try{
    const after=await file.stat();if(after.ino!==before.ino||after.dev!==before.dev||!after.isFile()||after.size>4096||after.nlink!==1||!privateToUser(after))throw new Error("登记文件已变化");
    const bytes=Buffer.alloc(4097);let total=0;
    while(total<bytes.length){const result=await file.read(bytes,total,bytes.length-total,null);if(!result.bytesRead)break;total+=result.bytesRead;}
    if(total>4096)throw new Error("登记文件超限");return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes.subarray(0,total)));
  }finally{await file.close();}
}
function candidate(record:Record<string,unknown>,filename:string,now:number):DiscoveredService{
  if(!record||record.version!==1||record.protocol!=="piora.remote.discovery.v1"||!isServerId(record.serverId)||!isServerId(record.instanceId)||typeof record.pid!=="number"||!Number.isSafeInteger(record.pid)||record.pid<1||filename!==record.pid+"-"+record.instanceId+".json")throw new Error("登记身份无效");
  if(typeof record.updatedAt!=="number"||!Number.isSafeInteger(record.updatedAt)||record.updatedAt>now+10000||typeof record.expiresAt!=="number"||record.expiresAt!==record.updatedAt+90000||record.expiresAt<=now)throw new Error("登记已过期");
  if(typeof record.address!=="string"||record.address.length>200)throw new Error("登记地址无效");
  return {address:normalizeAddress(record.address),serverId:record.serverId,instanceId:record.instanceId,pid:record.pid,expiresAt:record.expiresAt};
}
export async function discoverLocalServices(options:{root?:string;now?:number;signal?:AbortSignal;probe?:(address:string,signal:AbortSignal)=>Promise<string>}={}):Promise<DiscoveryResult>{
  const root=resolve(options.root??process.env.PIORA_DISCOVERY_DIR??join(homedir(),".piora","services"));const result:DiscoveryResult={services:[],skipped:0,limited:false,source:root};
  const checkAbort=()=>{if(options.signal?.aborted)throw new Error("发现已取消");};checkAbort();
  let stat;try{stat=await lstat(root);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return result;throw error;}
  if(!stat.isDirectory()||stat.isSymbolicLink()||relative(root,await realpath(root))||!privateToUser(stat))throw new Error("发现目录必须属于当前用户且不能经过链接；请改用手动地址");
  const records:DiscoveredService[]=[];let examined=0;const directory=await opendir(root);
  for await(const entry of directory){
    checkAbort();if(++examined>128){result.limited=true;break;}
    if(!/^[1-9][0-9]*-[0-9a-f-]{36}\.json$/.test(entry.name))continue;
    try{records.push(candidate(await readRecord(join(root,entry.name)),entry.name,options.now??Date.now()));}catch{result.skipped++;}
  }
  records.sort((first,second)=>second.expiresAt-first.expiresAt);if(records.length>16)result.limited=true;
  const candidates=records.slice(0,16);let next=0;
  const worker=async()=>{while(next<candidates.length){checkAbort();const service=candidates[next++];try{
    const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(2000)]):AbortSignal.timeout(2000);
    const serverId=await (options.probe??probeLocalIdentity)(service.address,signal);checkAbort();
    if(serverId!==service.serverId||service.expiresAt<=(options.now??Date.now()))throw new Error("实例身份不一致或登记已过期");
    if(!result.services.some(current=>current.address===service.address&&current.serverId===service.serverId))result.services.push(service);
  }catch{checkAbort();result.skipped++;}}};
  await Promise.all([worker(),worker()]);checkAbort();result.services.sort((first,second)=>first.address.localeCompare(second.address));return result;
}
