import { afterEach, expect, it, vi } from "vitest";
import { SessionController } from "../src/session";
import type { RemoteClient } from "../src/client";
const controllers: SessionController[]=[];
const scopes=["capabilities.read","session.state.read","session.history.read","session.message.send","session.events.read","session.messages.read"];
function fixture(overrides: (path:string,options?:unknown)=>unknown = ()=>undefined) {
 const calls:Array<{path:string;options:unknown}>=[];
 const api={ request:vi.fn(async(path:string,options?:unknown)=>{calls.push({path,options});const result=overrides(path,options);if(result!==undefined)return await result;if(path==="/capabilities")return {protocol:"piora.remote.v1",grantedScopes:scopes};if(path==="/sessions")return {sessions:[{id:"one"},{id:"two"}]};if(path.endsWith("/history"))return {messages:[]};if(path.endsWith("/state"))return {runtime:"idle"};return {commandId:"command"};}), stream:vi.fn((_path:string,_event:unknown,signal:AbortSignal)=>new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}))) };
 const controller=new SessionController(api as Pick<RemoteClient,"request"|"stream">);controllers.push(controller);return {controller,calls,api};
}
afterEach(()=>controllers.splice(0).forEach(controller=>controller.disconnect()));
it("discovers protocol and authorized sessions",async()=>{const {controller}=fixture();await controller.connect();expect(controller.state.connected).toBe(true);expect(controller.state.sessions).toHaveLength(2);});
it("loads the negotiated model catalog",async()=>{
 const {controller}=fixture(path=>path==="/capabilities"?{protocol:"piora.remote.v1",grantedScopes:scopes,features:{models:true}}:path==="/models"?{models:[{provider:"fixture",id:"model",name:"Fixture"}]}:undefined);
 await controller.connect();expect(controller.models).toEqual([{provider:"fixture",id:"model",name:"Fixture"}]);
});
it("refuses incompatible protocol",async()=>{const {controller}=fixture(path=>path==="/capabilities"?{protocol:"other",grantedScopes:scopes}:undefined);await expect(controller.connect()).rejects.toThrow(/协议/);});
it("retries an ambiguous delivery with identical key and body",async()=>{
 let attempts=0;const {controller,calls}=fixture(path=>{if(path.endsWith("/messages")&&++attempts===1)throw new Error("network");});
 await controller.connect();await controller.select("one");await expect(controller.send("hello")).rejects.toThrow();expect(controller.state.uncertain).toBe(true);await controller.retry();
 const sent=calls.filter(call=>call.path.endsWith("/messages"));expect(sent).toHaveLength(2);expect(sent[0].options).toEqual(sent[1].options);expect(controller.state.uncertain).toBe(false);
});
it("late history from a previous selection cannot overwrite current session",async()=>{
 let release:(value:unknown)=>void=()=>{};const waiting=new Promise(resolve=>{release=resolve;});
 const {controller}=fixture(path=>path==="/sessions/one/history"?waiting:undefined);await controller.connect();const old=controller.select("one");await controller.select("two");release({messages:[{role:"assistant",content:"stale"}]});await old;expect(controller.state.selectedId).toBe("two");expect(controller.state.history.messages).toEqual([]);
});
it("does not deliver to a session outside the discovered allowlist",async()=>{const {controller}=fixture();await controller.connect();await expect(controller.select("unauthorized")).rejects.toThrow(/授权/);});
it("fails closed for notes mode on legacy servers",async()=>{const {controller}=fixture();await controller.connect();await expect(controller.create({cwd:"fixture",policy:"notes"})).rejects.toThrow(/笔记助手/);});
it("does not call abort without the scope",async()=>{const {controller,calls}=fixture();await controller.connect();await controller.select("one");await expect(controller.stop()).rejects.toThrow(/权限/);expect(calls.some(call=>call.path.endsWith("/abort"))).toBe(false);});
it("applies content snapshot tool labels without exposing raw arguments",async()=>{
 const {controller,api}=fixture();await controller.connect();controller.state.capabilities!.features={contentStream:true};
 api.stream.mockImplementation(async(path,event,signal)=>{if(path.endsWith("/content-events"))(event as (event:unknown)=>void)({type:"content.snapshot",text:"live",tools:["read"],args:{secret:"never"}});await new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}));});
 await controller.select("one");expect(controller.state.tools).toEqual(["read"]);expect(controller.state.live).toBe("live");
});
it("journals the idempotency key before delivery and the receipt after acknowledgement",async()=>{
 const saved:Array<unknown>=[];const {api}=fixture();const controller=new SessionController(api as Pick<RemoteClient,"request"|"stream">,()=>{},async task=>{saved.push(task);});controllers.push(controller);
 await controller.connect();await controller.select("one");await controller.send("private note");
 expect(saved).toHaveLength(2);expect(saved[0]).toMatchObject({sessionId:"one",key:expect.any(String)});expect(saved[1]).toMatchObject({commandId:"command"});expect(JSON.stringify(saved)).not.toContain("private note");
});
it("restored unacknowledged tasks block new messages until explicit resolution",async()=>{
 const {controller}=fixture();await controller.connect();await controller.select("one");controller.restoreTask({sessionId:"one",key:"previous"});
 expect(controller.state.uncertain).toBe(true);await expect(controller.send("do not duplicate")).rejects.toThrow();await controller.forgetTask();expect(controller.state.uncertain).toBe(false);
});
