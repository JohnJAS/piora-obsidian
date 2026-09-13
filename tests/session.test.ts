import { afterEach, expect, it, vi } from "vitest";
import { SessionController, type CreationReceipt } from "../src/session";
import type { RemoteClient } from "../src/client";
import {ApiError} from "../src/client";
import {prepareAttachment} from "../src/attachments";
function fixtureImages(){const item=prepareAttachment("fixture.png",Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64"));if(item.kind!=="image")throw new Error("fixture");return [item.image];}
const controllers: SessionController[]=[];
const scopes=["capabilities.read","session.state.read","session.history.read","session.message.send","session.events.read","session.messages.read"];
function fixture(overrides: (path:string,options?:unknown)=>unknown = ()=>undefined,saveCreation?:(receipt:CreationReceipt|null)=>Promise<void>) {
 const calls:Array<{path:string;options:unknown}>=[];
 const api={ request:vi.fn(async(path:string,options?:unknown)=>{calls.push({path,options});const result=overrides(path,options);if(result!==undefined)return await result;if(path==="/capabilities")return {protocol:"piora.remote.v1",grantedScopes:scopes};if(path==="/sessions")return {sessions:[{id:"one"},{id:"two"}]};if(path.endsWith("/history"))return {messages:[]};if(path.endsWith("/state"))return {runtime:"idle"};return {commandId:"command"};}), stream:vi.fn((_path:string,_event:unknown,signal:AbortSignal)=>new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}))) };
 const controller=new SessionController(api as Pick<RemoteClient,"request"|"stream">,()=>{},async()=>{},saveCreation);controllers.push(controller);return {controller,calls,api};
}
afterEach(()=>{controllers.splice(0).forEach(controller=>controller.disconnect());vi.useRealTimers();});
it("keeps negotiated image bytes and the idempotency key unchanged across delivery retries",async()=>{
 let attempts=0;const {controller,calls}=fixture(path=>{if(path.endsWith("/messages")&&++attempts===1)throw new Error("network");});await controller.connect();await controller.select("one");controller.state.capabilities!.features={messageImages:"base64-images-v1"};
 const images=fixtureImages();const original=images[0].data;await expect(controller.send("picture",images)).rejects.toThrow("network");images[0].data="changed";await controller.retry();
 const requests=calls.filter(call=>call.path.endsWith("/messages"));expect(requests[0].options).toEqual(requests[1].options);expect(requests[1].options).toMatchObject({body:{images:[{data:original}]}});
});
it("rejects images without negotiation and counts their base64 in the complete request",async()=>{
 const {controller,calls}=fixture();await controller.connect();await controller.select("one");await expect(controller.send("picture",fixtureImages())).rejects.toThrow(/图片/);controller.state.capabilities!.features={messageImages:"base64-images-v1"};
 await expect(controller.send("x".repeat(256*1024-40),fixtureImages())).rejects.toThrow(/256/);expect(calls.some(call=>call.path.endsWith("/messages"))).toBe(false);
});
it("sends images through queued and steering deliveries without persisting media in receipts",async()=>{
 const saved:unknown[]=[];const {api,calls}=fixture();const controller=new SessionController(api as never,()=>{},async receipt=>{saved.push(receipt);});controllers.push(controller);await controller.connect();await controller.select("one");controller.state.capabilities!.features={messageImages:"base64-images-v1"};controller.state.capabilities!.grantedScopes=[...scopes,"session.steer"];controller.state.control.runtime="running";
 await controller.enqueue("queued",fixtureImages());await controller.steer("steer",fixtureImages());expect(calls.filter(call=>call.path.endsWith("/messages")||call.path.endsWith("/steer")).every(call=>(call.options as any).body.images.length===1)).toBe(true);expect(JSON.stringify(saved)).not.toContain(fixtureImages()[0].data);
});

const createInput={cwd:"fixture-vault",policy:"notes" as const,name:"Synthetic creation"};
function creationCapabilities(capabilityId="fixture-capability") {return {protocol:"piora.remote.v1",authentication:{scheme:"Bearer",capabilityId},grantedScopes:[...scopes,"session.create"],features:{sessionPolicies:["notes"]}};}
it("persists a creation key before POST and retains acknowledgement until the caller saves selection",async()=>{
 const order:string[]=[];let saved:CreationReceipt|null=null;
 const {controller}=fixture((path,options)=>{if(path==="/capabilities")return creationCapabilities();if(path==="/sessions"&&options){order.push("post");return {sessionId:"created"};}},async receipt=>{order.push(receipt?.sessionId?"ack":"save");saved=structuredClone(receipt);});
 await controller.connect();expect(await controller.create(createInput)).toBe("created");expect(order).toEqual(["save","post","ack"]);expect(saved).toMatchObject({input:createInput,capabilityId:"fixture-capability",sessionId:"created"});
 await controller.clearCreation();expect(saved).toBeNull();
});
it("creation persistence failure prevents a create request",async()=>{
 const {controller,calls}=fixture(path=>path==="/capabilities"?creationCapabilities():undefined,async()=>{throw new Error("disk full");});await controller.connect();await expect(controller.create(createInput)).rejects.toThrow("disk full");expect(calls.some(call=>call.path==="/sessions"&&call.options)).toBe(false);
});
it("a recreated controller retries an unacknowledged creation with the original key and input",async()=>{
 let saved:CreationReceipt|null=null;const save=async(receipt:CreationReceipt|null)=>{saved=structuredClone(receipt);};
 const first=fixture((path,options)=>{if(path==="/capabilities")return creationCapabilities();if(path==="/sessions"&&options)throw new Error("timeout");},save);await first.controller.connect();await expect(first.controller.create(createInput)).rejects.toThrow("timeout");expect(saved).not.toBeNull();first.controller.disconnect();
 const second=fixture((path,options)=>path==="/capabilities"?creationCapabilities():path==="/sessions"&&options?{sessionId:"created"}:undefined,save);await second.controller.connect();second.controller.restoreCreation(saved!);await second.controller.retryCreation();
 expect(second.calls.find(call=>call.path==="/sessions"&&call.options)!.options).toEqual(first.calls.find(call=>call.path==="/sessions"&&call.options)!.options);
});
it("an acknowledged creation retries selection without another POST",async()=>{
 const {controller,calls}=fixture(path=>path==="/capabilities"?creationCapabilities():undefined);await controller.connect();controller.restoreCreation({key:"same",capabilityId:"fixture-capability",input:createInput,sessionId:"created"});await controller.retryCreation();expect(calls.some(call=>call.path==="/sessions"&&call.options)).toBe(false);expect(controller.state.selectedId).toBe("created");
});
it("pending creation cannot be replaced by changed settings or retried with a different capability",async()=>{
 const {controller,calls}=fixture(path=>path==="/capabilities"?creationCapabilities("different-token"):undefined);await controller.connect();controller.restoreCreation({key:"same",capabilityId:"fixture-capability",input:createInput});
 await expect(controller.create({...createInput,name:"Changed"})).rejects.toThrow("创建");await expect(controller.retryCreation()).rejects.toThrow("令牌");expect(calls.some(call=>call.path==="/sessions"&&call.options)).toBe(false);
});
it("a late creation reply after disconnect stays durable without reopening session streams",async()=>{
 let release!:(value:unknown)=>void;let saved:CreationReceipt|null=null;const response=new Promise(resolve=>{release=resolve;});
 const {controller,calls,api}=fixture((path,options)=>path==="/capabilities"?creationCapabilities():path==="/sessions"&&options?response:undefined,async receipt=>{saved=structuredClone(receipt);});
 await controller.connect();const creating=controller.create(createInput);await vi.waitFor(()=>expect(calls.some(call=>call.path==="/sessions"&&call.options)).toBe(true));controller.disconnect();release({sessionId:"created"});
 await expect(creating).rejects.toThrow("连接");expect(saved).toMatchObject({sessionId:"created"});expect(api.stream).not.toHaveBeenCalled();expect(controller.state.connected).toBe(false);
});
it("disconnect during creation checkpoint persistence prevents the pending POST",async()=>{
 let release!:()=>void;const saved=new Promise<void>(resolve=>{release=resolve;});const {controller,calls}=fixture(path=>path==="/capabilities"?creationCapabilities():undefined,()=>saved);
 await controller.connect();const creating=controller.create(createInput);controller.disconnect();release();await expect(creating).rejects.toThrow("连接");expect(calls.some(call=>call.path==="/sessions"&&call.options)).toBe(false);
});
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
 const {controller,api}=fixture();await controller.connect();controller.state.capabilities!.features={contentStream:true,contentStreamIdentity:"run-sequence-v1"};
 api.stream.mockImplementation(async(path,event,signal)=>{if(path.endsWith("/content-events"))(event as (event:unknown)=>void)({type:"content.snapshot",sessionId:"one",streamId:"wrapper",runId:"run",sequence:1,running:true,text:"live",tools:["read"],args:{secret:"never"}});await new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}));});
 await controller.select("one");expect(controller.state.tools).toEqual(["read"]);expect(controller.state.live).toBe("live");
});
it("negotiates tool lifecycle snapshots and clears cards when selecting another session",async()=>{
 const {controller,api}=fixture();await controller.connect();controller.state.capabilities!.features={contentStream:true,contentStreamIdentity:"run-sequence-v1",toolLifecycle:"tool-calls-v1"};
 const toolCalls=[{toolCallId:"call",toolName:"read",status:"running",output:"reading",truncated:false}];
 api.stream.mockImplementation(async(path,event,signal)=>{if(path==="/sessions/one/content-events")(event as (event:unknown)=>void)({type:"content.snapshot",sessionId:"one",streamId:"wrapper",runId:"run",sequence:1,running:true,text:"",tools:["read"],toolCalls,omittedToolCalls:2});await new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}));});
 await controller.select("one");expect(controller.state.toolCalls).toEqual(toolCalls);expect(controller.state.omittedToolCalls).toBe(2);
 await controller.select("two");expect(controller.state.toolCalls).toEqual([]);expect(controller.state.omittedToolCalls).toBe(0);
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

it("queues another turn with its own receipt without replacing the running command",async()=>{
 let serial=0;const {controller,calls}=fixture(path=>path.endsWith("/messages")?{commandId:"command-"+(++serial),status:"queued",queuePosition:serial}:undefined);
 await controller.connect();await controller.select("one");await controller.send("first");await controller.enqueue("second");
 const sent=calls.filter(call=>call.path.endsWith("/messages"));expect(sent).toHaveLength(2);expect(sent[1].options).toMatchObject({body:{content:"second",delivery:"next_turn"}});
 expect(controller.state.tasks.map(task=>task.commandId)).toEqual(["command-1","command-2"]);expect(controller.state.control.queueLength).toBe(2);
});

it("completion of a steering receipt does not forget the original running command",async()=>{
 vi.useFakeTimers();const removals:string[]=[];
 const {api,calls}=fixture(path=>path.endsWith("/messages")?{commandId:"original",status:"running"}:path.endsWith("/steer")?{commandId:"guide",status:"completed"}:path.startsWith("/commands/")?{status:path.endsWith("original")?"running":"completed"}:undefined);
 const controller=new SessionController(api as Pick<RemoteClient,"request"|"stream">,()=>{},async(task,key)=>{if(!task&&key)removals.push(key);});controllers.push(controller);
 await controller.connect();controller.state.capabilities!.grantedScopes.push("session.steer","session.messages.read");await controller.select("one");await controller.send("first");await controller.steer("guide");
 await vi.advanceTimersByTimeAsync(500);expect(calls.some(call=>call.path==="/commands/original")).toBe(true);expect(calls.some(call=>call.path==="/commands/guide")).toBe(true);
 expect(controller.state.tasks.map(task=>task.commandId)).toEqual(["original"]);expect(removals).toHaveLength(1);expect(controller.state.control.runtime).not.toBe("idle");
});

it("restores all session receipts and rechecks them when returning to a session",async()=>{
 const {controller,calls}=fixture(path=>path.startsWith("/commands/")?{status:"running"}:undefined);
 await controller.connect();controller.state.capabilities!.grantedScopes.push("session.messages.read");
 controller.restoreTask({sessionId:"one",key:"first-key",commandId:"first"});controller.restoreTask({sessionId:"two",key:"second-key",commandId:"second"});
 await controller.select("one");expect(controller.state.tasks.map(task=>task.commandId)).toEqual(["first"]);
 await controller.select("two");expect(controller.state.tasks.map(task=>task.commandId)).toEqual(["second"]);
 await controller.select("one");expect(calls.filter(call=>call.path==="/commands/first")).toHaveLength(2);
});

it("resolving an unknown delivery removes only its receipt, not acknowledged work",async()=>{
 const removed:string[]=[];const {api}=fixture();const controller=new SessionController(api as Pick<RemoteClient,"request"|"stream">,()=>{},async(task,key)=>{if(!task&&key)removed.push(key);});controllers.push(controller);
 await controller.connect();await controller.select("one");controller.restoreTask({sessionId:"one",key:"running-key",commandId:"running"});controller.restoreTask({sessionId:"one",key:"unknown-key"});
 await controller.forgetTask();expect(controller.state.tasks.map(task=>task.commandId)).toEqual(["running"]);expect(removed).toEqual(["unknown-key"]);expect(controller.state.uncertain).toBe(false);
});

it("retries a queued timeout with one logical key while retaining other receipts",async()=>{
 let attempts=0;const {controller,calls}=fixture(path=>{if(path.endsWith("/messages")){attempts++;if(attempts===2)throw new Error("timeout");return {commandId:attempts===1?"original":"queued",status:"queued"};}});
 await controller.connect();controller.state.capabilities!.grantedScopes.push("session.messages.read");await controller.select("one");await controller.send("first");await expect(controller.enqueue("second")).rejects.toThrow("timeout");await controller.retry();
 const sent=calls.filter(call=>call.path.endsWith("/messages"));expect(sent[1].options).toEqual(sent[2].options);expect(controller.state.tasks.map(task=>task.commandId)).toEqual(["original","queued"]);
});

it("does not transmit a message when the durable journal fails",async()=>{
 const {api,calls}=fixture();const controller=new SessionController(api as Pick<RemoteClient,"request"|"stream">,()=>{},async()=>{throw new Error("disk full");});controllers.push(controller);
 await controller.connect();await controller.select("one");await expect(controller.send("private")).rejects.toThrow("disk full");expect(calls.some(call=>call.path.endsWith("/messages"))).toBe(false);
 expect(controller.state.uncertain).toBe(true);
});

it("queues only with command-read permission and never while disconnected",async()=>{
 const {controller,calls}=fixture();await controller.connect();await controller.select("one");controller.state.capabilities!.grantedScopes=controller.state.capabilities!.grantedScopes.filter(scope=>scope!=="session.messages.read");
 await expect(controller.enqueue("queued")).rejects.toThrow("session.messages.read");controller.state.capabilities!.grantedScopes.push("session.messages.read");controller.disconnect();
 await expect(controller.enqueue("queued")).rejects.toThrow("连接");expect(calls.some(call=>call.path.endsWith("/messages"))).toBe(false);
});

it("caps outstanding receipts rather than silently losing task recovery",async()=>{
 const {controller,calls}=fixture();await controller.connect();controller.state.capabilities!.grantedScopes.push("session.messages.read");await controller.select("one");
 for(let index=0;index<10;index++)controller.restoreTask({sessionId:"one",key:"key-"+index,commandId:"command-"+index});
 await expect(controller.enqueue("overflow")).rejects.toThrow("10");expect(calls.some(call=>call.path.endsWith("/messages"))).toBe(false);
});

it("cancels only a tracked command after capability and scope checks",async()=>{
 const {controller,calls}=fixture();await controller.connect();await controller.select("one");controller.restoreTask({sessionId:"one",key:"key",commandId:"tracked"});
 await expect(controller.cancel("tracked")).rejects.toThrow("权限");controller.state.capabilities!.grantedScopes.push("session.abort");
 await expect(controller.cancel("tracked")).rejects.toThrow("支持");controller.state.capabilities!.features={commandCancellation:true};
 await expect(controller.cancel("unknown")).rejects.toThrow("回执");await controller.cancel("tracked");
 expect(calls.filter(call=>call.path.endsWith("/cancel"))).toEqual([{path:"/commands/tracked/cancel",options:{body:{}}}]);
 expect(controller.state.tasks).toHaveLength(1);
});

async function contentFixture(overrides:(path:string)=>unknown=()=>undefined) {
 const {controller,api}=fixture(overrides);await controller.connect();controller.state.capabilities!.features={contentStream:true,contentStreamIdentity:"run-sequence-v1"} as never;
 const sinks=new Map<string,Array<(event:Record<string,unknown>)=>void>>();const releases=new Map<string,Array<()=>void>>();
 api.stream.mockImplementation((path,event,signal)=>new Promise<void>(resolve=>{sinks.set(path,[...(sinks.get(path)??[]),event as (event:Record<string,unknown>)=>void]);releases.set(path,[...(releases.get(path)??[]),resolve]);signal.addEventListener("abort",()=>resolve(),{once:true});}));
 await controller.select("one");return {controller,sinks,releases};
}
function contentFrame(runId:string|null,sequence:number,streamId="wrapper-one") {
 return {type:"content.snapshot",sessionId:"one",streamId,sequence,runId,running:runId!==null,text:runId??"",tools:["read"]};
}
it("fences wrong sessions, retired runs and lifecycle replay from the current view",async()=>{
 const {controller,sinks}=await contentFixture();const content=sinks.get("/sessions/one/content-events")![0];const lifecycle=sinks.get("/sessions/one/events")![0];
 content(contentFrame("old",1));content(contentFrame("current",2));content(contentFrame("old",3));content({...contentFrame("foreign",4),sessionId:"two"});
 lifecycle({type:"snapshot",sessionId:"one",state:{runtime:"idle",activeRunId:"old"}});
 expect(controller.state.live).toBe("current");expect(controller.state.control.activeRunId).toBe("current");expect(controller.state.control.runtime).toBe("running");
});
it("does not let a slow state/history response overwrite a newer streamed run",async()=>{
 vi.useFakeTimers();let slow=false;let release!:(history:unknown)=>void;const history=new Promise(resolve=>{release=resolve;});
 const {controller,sinks}=await contentFixture(path=>slow&&path.endsWith("/history")?history:undefined);const content=sinks.get("/sessions/one/content-events")![0];
 content(contentFrame("first",1));slow=true;await vi.advanceTimersByTimeAsync(10000);content(contentFrame("second",2));release({messages:[{role:"assistant",content:"stale history"}]});await vi.advanceTimersByTimeAsync(0);
 expect(controller.state.live).toBe("second");expect(controller.state.history.messages).toEqual([]);expect(controller.state.control.activeRunId).toBe("second");
});
it("rejects callbacks from a completed SSE transport even within the same selection",async()=>{
 vi.useFakeTimers();const {controller,sinks,releases}=await contentFixture();const content=sinks.get("/sessions/one/content-events")![0];content(contentFrame("old",50));
 releases.get("/sessions/one/content-events")![0]();await vi.advanceTimersByTimeAsync(2600);const next=sinks.get("/sessions/one/content-events")!.at(-1)!;expect(next).not.toBe(content);
 next(contentFrame("new",1,"wrapper-two"));content(contentFrame("old",99));expect(controller.state.live).toBe("new");
});
it("falls back to authoritative history when content identity was not negotiated",async()=>{
 const {controller,api}=fixture();await controller.connect();controller.state.capabilities!.features={contentStream:true};await controller.select("one");
 expect(api.stream.mock.calls.some(call=>call[0].endsWith("/content-events"))).toBe(false);
});

it("recovers a restarted content wrapper and clears only the transport error",async()=>{
 vi.useFakeTimers();const {controller,api}=fixture();let attempts=0;await controller.connect();controller.state.capabilities!.features={contentStream:true,contentStreamIdentity:"run-sequence-v1"};
 api.stream.mockImplementation(async(path,event,signal)=>{if(path.endsWith("/content-events")){if(++attempts===1)throw new ApiError(409,"REMOTE_SESSION_RESTARTED");(event as (event:unknown)=>void)(contentFrame("new",1,"wrapper-new"));}await new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}));});
 await controller.select("one");await vi.advanceTimersByTimeAsync(0);expect(controller.state.error).not.toBe("");expect(controller.state.connected).toBe(true);
 await vi.advanceTimersByTimeAsync(2600);expect(controller.state.live).toBe("new");expect(controller.state.error).toBe("");
});

it("rejects a session mode outside the negotiated token policy before making a create request",async()=>{
 const {controller,calls}=fixture();await controller.connect();controller.state.capabilities!.grantedScopes.push("session.create");controller.state.capabilities!.features={sessionPolicies:["notes","agent"]};
 controller.state.capabilities!.sessionCreation={fields:["policy","cwd"],allowedPolicies:["notes"],cwdRoots:["fixture-vault"]} as never;
 await expect(controller.create({cwd:"fixture-vault",policy:"agent"})).rejects.toThrow("令牌");expect(calls.some(call=>call.path==="/sessions"&&call.options)).toBe(false);
});
