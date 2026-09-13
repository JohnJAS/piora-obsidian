import {expect,it,vi} from "vitest";
import {mkdtemp,mkdir,writeFile,symlink} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {discoverLocalServices} from "../src/discovery";
const serverId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";const instanceId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";const now=100000;
async function fixture(){const parent=await mkdtemp(join(tmpdir(),"piora-discovery-reader-"));const root=join(parent,"services");await mkdir(root,{mode:0o700});return {root,parent};}
async function record(root:string,pid:number,extra:Record<string,unknown>={}){await writeFile(join(root,pid+"-"+instanceId+".json"),JSON.stringify({version:1,protocol:"piora.remote.discovery.v1",address:"http://127.0.0.1:30142/api/remote/v1",serverId,instanceId,pid,updatedAt:now,expiresAt:now+90000,...extra}),{mode:0o600});}
it("uses only live local registrations and anonymously verifies the recorded identity",async()=>{
 const {root}=await fixture();await record(root,1);await record(root,2,{expiresAt:now-1});await record(root,3,{address:"http://remote.example"});await record(root,4,{serverId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc",address:"http://127.0.0.1:30143/api/remote/v1"});
 const probe=vi.fn(async()=>serverId);const result=await discoverLocalServices({root,now,probe});expect(result.services).toHaveLength(1);expect(result.services[0]).toMatchObject({serverId,address:"http://127.0.0.1:30142/api/remote/v1"});expect(probe).toHaveBeenCalledTimes(2);expect(result.skipped).toBe(3);
});
it("ignores corrupt and oversized files and refuses directory links before probing",async()=>{
 const {root,parent}=await fixture();await writeFile(join(root,"1-"+instanceId+".json"),"broken");await writeFile(join(root,"2-"+instanceId+".json"),"x".repeat(5000));const probe=vi.fn(async()=>serverId);
 const result=await discoverLocalServices({root,now,probe});expect(result.skipped).toBe(2);expect(probe).not.toHaveBeenCalled();
 const linked=join(parent,"linked");await symlink(root,linked,process.platform==="win32"?"junction":"dir");await expect(discoverLocalServices({root:linked,now,probe})).rejects.toThrow();
});
it("cancels discovery without probing or returning stale results",async()=>{
 const {root}=await fixture();await record(root,1);const abort=new AbortController();abort.abort();const probe=vi.fn(async()=>serverId);await expect(discoverLocalServices({root,now,signal:abort.signal,probe})).rejects.toThrow();expect(probe).not.toHaveBeenCalled();
});
it("bounds anonymous probes and reports an incomplete discovery instead of scanning extra ports",async()=>{
 const {root}=await fixture();for(let pid=1;pid<=20;pid++)await record(root,pid,{address:"http://127.0.0.1:"+(31000+pid)+"/api/remote/v1"});let active=0;let maximum=0;
 const probe=vi.fn(async()=>{active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,5));active--;return serverId;});
 const result=await discoverLocalServices({root,now,probe});expect(probe).toHaveBeenCalledTimes(16);expect(maximum).toBeLessThanOrEqual(2);expect(result.services).toHaveLength(16);expect(result.limited).toBe(true);
});
