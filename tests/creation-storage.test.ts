import {expect,it} from "vitest";
import {readStoredCreations,updateStoredCreations} from "../src/creation-storage";
const address="http://127.0.0.1:30141/api/remote/v1";
const serverId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const receipt={key:"original",capabilityId:"fixture-capability",input:{cwd:"fixture-vault",policy:"notes" as const,name:"Synthetic"}};
it("persists only the whitelisted creation configuration and identifiers",()=>{
 const records=readStoredCreations({creations:[{...receipt,address,serverId,token:"secret-fixture",prompt:"private-note",input:{...receipt.input,content:"private-note",apiKey:"secret-fixture"}}]});
 expect(records).toEqual([{...receipt,address,serverId}]);expect(JSON.stringify(records)).not.toMatch(/secret-fixture|private-note/);
});
it("updates and clears only the addressed instance checkpoint",()=>{
 const otherId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";let records=updateStoredCreations([],address,serverId,receipt);records=updateStoredCreations(records,address,otherId,{...receipt,key:"other"});
 records=updateStoredCreations(records,address,serverId,{...receipt,sessionId:"created"});expect(records).toHaveLength(2);records=updateStoredCreations(records,address,serverId,null);expect(records).toHaveLength(1);expect(records[0].serverId).toBe(otherId);
});
it("fails closed on malformed metadata or conflicting records instead of replacing a checkpoint",()=>{
 expect(()=>readStoredCreations({creations:[{...receipt,address,serverId,input:{cwd:"fixture",policy:"unknown"}}]})).toThrow("创建");
 expect(()=>readStoredCreations({creations:[{...receipt,address,serverId},{...receipt,address,serverId,key:"different"}]})).toThrow("重复");
 expect(()=>readStoredCreations({creations:[{...receipt,address,serverId,key:"bad\nheader"}]})).toThrow("回执");
 expect(readStoredCreations(null)).toEqual([]);
});
