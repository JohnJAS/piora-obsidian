import {expect,it} from "vitest";
import {Credentials} from "../src/credentials";
it("memory-only credentials survive address normalization but never cross hosts or vaults",()=>{
 const credentials=new Credentials(()=>undefined);credentials.set("http://localhost:30141","vault","fixture",false);
 expect(credentials.get("http://127.0.0.1:30141/api/remote/v1","vault",false)).toBe("fixture");
 expect(credentials.get("http://127.0.0.1:63966","vault",false)).toBe("");expect(credentials.get("http://localhost:30141","other",false)).toBe("");
 credentials.clear();expect(credentials.get("http://localhost:30141","vault",false)).toBe("");
});
it("stores secrets only when requested and falls back to memory on host storage errors",()=>{
 const values=new Map<string,string>();const credentials=new Credentials(()=>({getSecret:id=>values.get(id)??null,setSecret:(id,value)=>{values.set(id,value);}}));
 credentials.set("http://localhost:1","vault","fixture",true);expect(values.size).toBe(1);credentials.clear();expect(credentials.get("http://localhost:1","vault",true)).toBe("fixture");expect(credentials.get("http://localhost:1","vault",false)).toBe("");
 const broken=new Credentials(()=>({getSecret:()=>{throw new Error("locked");},setSecret:()=>{throw new Error("locked");}}));
 broken.set("http://localhost:1","vault","memory",true);expect(broken.get("http://localhost:1","vault",true)).toBe("memory");
});

it("turning off persistence clears only this connection's saved value and retains its memory token",()=>{
 const values=new Map<string,string>();const store={getSecret:(id:string)=>values.get(id)??null,setSecret:(id:string,value:string)=>{values.set(id,value);}};
 const credentials=new Credentials(()=>store);credentials.set("http://localhost:1","vault","first",true);credentials.set("http://localhost:2","vault","other",true);credentials.clear();
 credentials.setRemembered("http://localhost:1","vault",false);expect(credentials.get("http://localhost:1","vault",false)).toBe("first");
 const reloaded=new Credentials(()=>store);expect(reloaded.get("http://localhost:1","vault",true)).toBe("");expect(reloaded.get("http://localhost:2","vault",true)).toBe("other");
 credentials.setRemembered("http://localhost:1","vault",true);expect(reloaded.get("http://localhost:1","vault",true)).toBe("first");
});

it("explicit forgetting clears memory and saved values without touching another vault",()=>{
 const values=new Map<string,string>();const credentials=new Credentials(()=>({getSecret:id=>values.get(id)??null,setSecret:(id,value)=>{values.set(id,value);}}));
 credentials.set("http://localhost:1","vault","first",true);credentials.set("http://localhost:1","other-vault","other",true);
 credentials.forget("http://localhost:1","vault");expect(credentials.get("http://localhost:1","vault",true)).toBe("");expect(credentials.get("http://localhost:1","other-vault",true)).toBe("other");
});

it("reports a failed secret-store clear instead of claiming the token was forgotten",()=>{
 const credentials=new Credentials(()=>({getSecret:()=>"saved",setSecret:()=>{throw new Error("secret backend detail");}}));
 expect(()=>credentials.setRemembered("http://localhost:1","vault",false)).toThrow("秘密存储");expect(()=>credentials.forget("http://localhost:1","vault")).toThrow("秘密存储");
 expect(credentials.get("http://localhost:1","vault",true)).toBe("saved");
});
