import {expect,it} from "vitest";
import {readStoredTasks,updateStoredTasks} from "../src/task-storage";

it("migrates the legacy task and keeps only receipt metadata",()=>{
 const tasks=readStoredTasks({task:{address:"http://localhost:30141",sessionId:"one",key:"key",commandId:"command",content:"private note",token:"private credential"}});
 expect(tasks).toEqual([{address:"http://127.0.0.1:30141/api/remote/v1",sessionId:"one",key:"key",commandId:"command"}]);
 expect(JSON.stringify(tasks)).not.toContain("private");
});

it("upserts by server and key and removes only the named receipt",()=>{
 let tasks=readStoredTasks({tasks:[{address:"http://localhost:1",sessionId:"one",key:"same",commandId:"first"},{address:"http://localhost:2",sessionId:"two",key:"same",commandId:"other"}]});
 tasks=updateStoredTasks(tasks,"http://localhost:1",{sessionId:"one",key:"next",commandId:"next-command"});
 tasks=updateStoredTasks(tasks,"http://localhost:1",{sessionId:"one",key:"same",commandId:"acknowledged"});
 expect(tasks).toHaveLength(3);tasks=updateStoredTasks(tasks,"http://localhost:1",null,"same");expect(tasks.map(task=>task.commandId)).toEqual(["other","next-command"]);
 expect(()=>updateStoredTasks(tasks,"http://localhost:1",null)).toThrow();
});

it("does not silently discard malformed recovery data",()=>{
 expect(()=>readStoredTasks({tasks:[{address:"http://localhost:1",sessionId:"one"}]})).toThrow("回执");
 expect(()=>readStoredTasks({tasks:"broken"})).toThrow("回执");
 expect(readStoredTasks(null)).toEqual([]);
});

it("partitions receipts by instance as well as address and never adopts legacy receipts",()=>{
 const address="http://localhost:1";const first="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";const second="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
 let tasks=readStoredTasks({tasks:[{address,sessionId:"legacy",key:"same"}]});
 tasks=updateStoredTasks(tasks,address,{sessionId:"first",key:"same"},undefined,first);
 tasks=updateStoredTasks(tasks,address,{sessionId:"second",key:"same"},undefined,second);
 expect(tasks).toHaveLength(3);expect(readStoredTasks({tasks})).toEqual(tasks);
 tasks=updateStoredTasks(tasks,address,null,"same",first);expect(tasks.map(task=>task.sessionId)).toEqual(["legacy","second"]);
});
