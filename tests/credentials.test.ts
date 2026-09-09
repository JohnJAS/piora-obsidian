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
