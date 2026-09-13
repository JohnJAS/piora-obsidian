// @vitest-environment happy-dom
import {afterEach,beforeEach,expect,it,vi} from "vitest";
vi.mock("obsidian",()=>import("./obsidian-mock"));
vi.mock("../src/vault-path",()=>({assertVaultTarget:vi.fn(),assertVaultAttachment:vi.fn()}));
import PioraPlugin, {ChatView} from "../src/main";
import {FileSystemAdapter,MarkdownView,Modal,Notice,TFile} from "./obsidian-mock";
import type {Editor} from "obsidian";
import type {SessionController} from "../src/session";
import {buildPrompt} from "../src/core";
import {RemoteClient} from "../src/client";
import {assertVaultTarget,assertVaultAttachment} from "../src/vault-path";
import {prepareAttachment} from "../src/attachments";

beforeEach(()=>{Modal.opened=[];Notice.messages=[];vi.mocked(assertVaultTarget).mockReset();vi.mocked(assertVaultAttachment).mockReset();});
afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks();});

function hostFixture() {
  const file=new TFile("fixture.md");let value="original";
  const editor={getValue:()=>value,getCursor:()=>({line:0,ch:0}),posToOffset:()=>0,offsetToPos:(offset:number)=>({line:0,ch:offset}),replaceRange:vi.fn((replacement:string,from:{ch:number},to:{ch:number})=>{value=value.slice(0,from.ch)+replacement+value.slice(to.ch);})};
  const markdown=new MarkdownView(file,editor);
  const handlers=new Map<string,Function>();
  const workspace={getActiveViewOfType:vi.fn(()=>markdown),getLeavesOfType:vi.fn((type:string)=>type==="markdown"?[{view:markdown}]:[]),on:vi.fn((name:string,callback:Function)=>{handlers.set(name,callback);return {};})};
  const plugin=new PioraPlugin({} as never,{} as never);
  Object.assign(plugin,{app:{workspace,vault:{adapter:new FileSystemAdapter(),getAbstractFileByPath:vi.fn(()=>file),process:vi.fn(),create:vi.fn()}}});
  return {plugin,file,editor,workspace,handlers,setValue:(next:string)=>{value=next;}};
}

function controllerFixture() {
  const scopes=new Set(["session.message.send","session.messages.read","session.abort","session.steer"]);
  const controller={state:{connected:true,selectedId:"session",sessions:[{id:"session"}],sending:false,uncertain:false,control:{runtime:"idle"},history:{messages:[],entryIds:[],remotePolicy:"notes"},live:"",tools:[],error:""},has:(scope:string)=>scopes.has(scope),disconnect:vi.fn(),send:vi.fn(async (_content:string)=>{}),steer:vi.fn(async (_content:string)=>{})};
  return {controller,scopes};
}

function findButton(root:HTMLElement,label:string):HTMLButtonElement {
  const target=Array.from(root.querySelectorAll("button")).find(button=>button.textContent===label);
  if(!target)throw new Error("Missing button: "+label);return target;
}
function discoveredService(){return {address:"http://127.0.0.1:39999/api/remote/v1",serverId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",instanceId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",pid:123,expiresAt:Date.now()+90000};}
it("selects a confirmed discovered instance without connecting or migrating credentials",async()=>{
 const {plugin}=hostFixture();const service=discoveredService();const probe=vi.spyOn(RemoteClient.prototype,"identify").mockResolvedValue(service.serverId);const request=vi.spyOn(RemoteClient.prototype,"request");const connect=vi.spyOn(plugin,"connect");
 await plugin.chooseDiscoveredService(service);expect(probe).toHaveBeenCalledOnce();expect(request).not.toHaveBeenCalled();expect(connect).not.toHaveBeenCalled();expect(plugin.settings.address).toBe(service.address);expect(plugin.boundServerId()).toBe(service.serverId);expect(vi.mocked(plugin.saveData).mock.calls.at(-1)![0]).toMatchObject({address:service.address,serverBindings:{[service.address]:service.serverId}});
});
it("rejects changed discovery identities and failed persistence without replacing connection settings",async()=>{
 const {plugin}=hostFixture();const before=plugin.settings.address;const service=discoveredService();const probe=vi.spyOn(RemoteClient.prototype,"identify").mockResolvedValue("cccccccc-cccc-4ccc-8ccc-cccccccccccc");await expect(plugin.chooseDiscoveredService(service)).rejects.toThrow(/身份|实例/);expect(plugin.settings.address).toBe(before);
 probe.mockResolvedValue(service.serverId);vi.mocked(plugin.saveData).mockRejectedValue(new Error("disk failure"));await expect(plugin.chooseDiscoveredService(service)).rejects.toThrow("disk failure");expect(plugin.settings.address).toBe(before);expect(plugin.boundServerId()).toBe("尚未绑定");
});
it("discovery UI requires a second explicit confirmation before selecting an address",async()=>{
 const {plugin}=hostFixture();const service=discoveredService();Object.assign(plugin,{discoverServices:vi.fn(async()=>({services:[service],source:"fixture directory",skipped:0,limited:false}))});const choose=vi.spyOn(plugin,"chooseDiscoveredService").mockResolvedValue();
 plugin.openDiscovery();await vi.waitFor(()=>expect(Modal.opened[0].contentEl.textContent).toContain(service.address));findButton(Modal.opened[0].contentEl,"选择此实例").click();await vi.waitFor(()=>expect(Modal.opened).toHaveLength(2));expect(choose).not.toHaveBeenCalled();findButton(Modal.opened[1].contentEl,"确认选择").click();await vi.waitFor(()=>expect(choose).toHaveBeenCalledWith(service));
});
it("never replaces an existing address binding through discovery or scans automatically on load",async()=>{
 const {plugin}=hostFixture();const service=discoveredService();const original="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
 vi.mocked(plugin.loadData).mockResolvedValue({serverBindings:{[service.address]:original}});const discover=vi.spyOn(plugin,"discoverServices");const probe=vi.spyOn(RemoteClient.prototype,"identify");await plugin.onload();expect(discover).not.toHaveBeenCalled();
 await expect(plugin.chooseDiscoveredService(service)).rejects.toThrow(/不能自动覆盖/);expect(probe).not.toHaveBeenCalled();expect(plugin.saveData).not.toHaveBeenCalled();plugin.onunload();
});
it("closing discovery aborts the scan and ignores late candidates",async()=>{
 const {plugin}=hostFixture();let release!:(value:unknown)=>void;let signal:AbortSignal|undefined;
 Object.assign(plugin,{discoverServices:(current:AbortSignal)=>{signal=current;return new Promise(resolve=>{release=resolve;});}});plugin.openDiscovery();const modal=Modal.opened[0];modal.close();expect(signal!.aborted).toBe(true);
 release({services:[discoveredService()],skipped:0,limited:false,source:"fixture"});await Promise.resolve();await Promise.resolve();expect(modal.contentEl.textContent).not.toContain("39999");
});
it("sends selected attachments while preserving later additions and omitting them from config",async()=>{
 const {plugin}=hostFixture();const {controller}=controllerFixture();plugin.controller=controller as unknown as SessionController;plugin.draft="read attachments";
 const first=prepareAttachment("first.txt",Buffer.from("first snapshot"));const second=prepareAttachment("second.txt",Buffer.from("later snapshot"));plugin.attachments=[first];let release!:()=>void;controller.send.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
 const sending=plugin.send();await vi.waitFor(()=>expect(controller.send).toHaveBeenCalledOnce());expect(controller.send.mock.calls[0][0]).toContain("first snapshot");plugin.attachments.push(second);release();await sending;expect(plugin.attachments).toEqual([second]);await plugin.persist();expect(JSON.stringify(vi.mocked(plugin.saveData).mock.calls)).not.toContain("later snapshot");
});
it("imports only explicitly chosen bytes, enforces limits before reading and discards late imports on unload",async()=>{
 const {plugin}=hostFixture();const read=vi.fn(async()=>new TextEncoder().encode("selected text").buffer);const file={name:"fixture.txt",size:13,arrayBuffer:read} as unknown as File;
 await plugin.addAttachmentFiles([file]);expect(plugin.attachments).toHaveLength(1);expect(plugin.notes).toEqual([]);expect(plugin.saveData).not.toHaveBeenCalled();
 const large={name:"large.txt",size:200000,arrayBuffer:vi.fn()} as unknown as File;await expect(plugin.addAttachmentFiles([large])).rejects.toThrow(/128/);expect(large.arrayBuffer).not.toHaveBeenCalled();
 let release!:(value:ArrayBuffer)=>void;read.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));const pending=plugin.addAttachmentFiles([file]);await vi.waitFor(()=>expect(plugin.readingAttachments).toBe(true));plugin.onunload();release(new TextEncoder().encode("late").buffer);await expect(pending).rejects.toThrow(/卸载/);expect(plugin.attachments).toEqual([]);
});
it("guards Vault attachment reads and exposes removable attachments and steering payloads",async()=>{
 const {plugin}=hostFixture();const file=new TFile("assets/fixture.txt");Object.assign(file,{stat:{size:7}});const readBinary=vi.fn(async()=>new TextEncoder().encode("fixture").buffer);Object.assign(plugin.app.vault,{readBinary});
 vi.mocked(assertVaultAttachment).mockImplementationOnce(()=>{throw new Error("outside Vault");});await expect(plugin.addVaultAttachment(file as never)).rejects.toThrow(/Vault/);expect(readBinary).not.toHaveBeenCalled();await plugin.addVaultAttachment(file as never);
 const {controller}=controllerFixture();plugin.controller=controller as unknown as SessionController;controller.state.control.runtime="running";plugin.draft="steer text";const view=new ChatView({} as never,plugin);await view.onOpen();expect(view.contentEl.textContent).toContain("附件：fixture.txt");findButton(view.contentEl,"引导").click();await vi.waitFor(()=>expect(controller.steer).toHaveBeenCalledOnce());expect(controller.steer.mock.calls[0][0]).toContain("fixture");expect(plugin.attachments).toEqual([]);await view.onClose();
});
it("routes chosen, pasted and dropped files to attachment import without intercepting plain text",async()=>{
 const {plugin}=hostFixture();const add=vi.spyOn(plugin,"addAttachmentFiles").mockResolvedValue();const view=new ChatView({} as never,plugin);await view.onOpen();const input=view.contentEl.querySelector("textarea")!;const file=new File(["synthetic"],"fixture.txt");
 const paste=new Event("paste",{cancelable:true});Object.defineProperty(paste,"clipboardData",{value:{files:[file]}});input.dispatchEvent(paste);expect(paste.defaultPrevented).toBe(true);expect(add).toHaveBeenLastCalledWith([file]);
 const drop=new Event("drop",{cancelable:true});Object.defineProperty(drop,"dataTransfer",{value:{files:[file]}});input.dispatchEvent(drop);expect(drop.defaultPrevented).toBe(true);
 const upload=view.contentEl.querySelector('input[type="file"]')!;Object.defineProperty(upload,"files",{value:[file]});upload.dispatchEvent(new Event("change"));expect(add).toHaveBeenCalledTimes(3);
 const plain=new Event("paste",{cancelable:true});Object.defineProperty(plain,"clipboardData",{value:{files:[]}});input.dispatchEvent(plain);expect(plain.defaultPrevented).toBe(false);expect(add).toHaveBeenCalledTimes(3);await view.onClose();
});
it("searches local unsaved note text without sending it or following outside paths",async()=>{
 const {plugin,file,setValue}=hostFixture();setValue("unsaved keyword");const outside=new TFile("linked.md");
 Object.assign(file,{stat:{size:5}});Object.assign(outside,{stat:{size:5}});const read=vi.fn(async()=>"disk-only");Object.assign(plugin.app.vault,{getMarkdownFiles:()=>[file,outside],read});
 vi.mocked(assertVaultTarget).mockImplementation((_root,path)=>{if(path===outside.path)throw new Error("outside");});
 const result=await plugin.searchNotes("keyword");expect(result.hits.map(hit=>hit.path)).toEqual([file.path]);expect(result.hits[0].snippet).toContain("unsaved keyword");expect(read).not.toHaveBeenCalled();expect(plugin.notes).toEqual([]);expect(plugin.saveData).not.toHaveBeenCalled();
});
it("search UI requires explicit reference selection and ignores closed search results",async()=>{
 const {plugin,file}=hostFixture();const search=vi.fn(async()=>({hits:[{path:file.path,snippet:'<img src="https://invalid.example">',score:1}],scanned:1,skipped:0,limited:false}));
 Object.assign(plugin,{searchNotes:search});const add=vi.spyOn(plugin,"addNote").mockResolvedValue();plugin.openNoteSearch();const modal=Modal.opened[0];
 expect(search).not.toHaveBeenCalled();const input=modal.contentEl.querySelector('input[aria-label="检索词"]') as HTMLInputElement;input.value="keyword";findButton(modal.contentEl,"本地检索").click();await vi.waitFor(()=>expect(modal.contentEl.textContent).toContain(file.path));
 expect(modal.contentEl.querySelector("img")).toBeNull();expect(add).not.toHaveBeenCalled();findButton(modal.contentEl,"加入引用").click();await vi.waitFor(()=>expect(add).toHaveBeenCalledWith(file));
 let release!:(value:unknown)=>void;search.mockImplementation(()=>new Promise(resolve=>{release=resolve;}) as never);findButton(modal.contentEl,"本地检索").click();await vi.waitFor(()=>expect(search).toHaveBeenCalledTimes(2));modal.close();release({hits:[{path:"late.md",snippet:"late",score:1}],scanned:1,skipped:0,limited:false});await Promise.resolve();await Promise.resolve();expect(modal.contentEl.textContent).not.toContain("late.md");
});
it("unloading closes local-search dialogs and aborts their in-flight work",async()=>{
 const {plugin}=hostFixture();let signal:AbortSignal|undefined;
 Object.assign(plugin,{searchNotes:vi.fn(async(_query:string,_folder:string,current:AbortSignal)=>{signal=current;return new Promise(()=>{});})});plugin.openNoteSearch();const modal=Modal.opened[0];
 findButton(modal.contentEl,"本地检索").click();await vi.waitFor(()=>expect(signal).toBeDefined());plugin.onunload();expect(signal!.aborted).toBe(true);expect(Modal.opened).toHaveLength(0);
});
it("renders safe tool status cards and keeps expansion across streaming updates",async()=>{
 const {plugin}=hostFixture();const {controller}=controllerFixture();plugin.controller=controller as unknown as SessionController;
 const toolCalls=[{toolCallId:"read-call",toolName:"read",status:"running",output:'<img src="https://invalid.example/secret" onerror="bad()">',truncated:false},{toolCallId:"bash-call",toolName:"bash",status:"failed",output:"failed output",truncated:true}];
 Object.assign(controller.state,{toolCalls,omittedToolCalls:2});const view=new ChatView({} as never,plugin);await view.onOpen();
 expect(view.contentEl.querySelectorAll(".piora-tool-call")).toHaveLength(2);expect(view.contentEl.textContent).toContain("read · 运行中");expect(view.contentEl.textContent).toContain("bash · 失败");expect(view.contentEl.textContent).toContain("已省略 2 次工具调用");expect(view.contentEl.textContent).toContain("输出已截断");expect(view.contentEl.querySelector("img")).toBeNull();
 const details=view.contentEl.querySelector(".piora-tool-call details") as HTMLDetailsElement;details.open=true;
 toolCalls[0].status="succeeded";toolCalls[0].output="complete";plugin.emit();
 expect(view.contentEl.textContent).toContain("read · 成功");expect((view.contentEl.querySelector(".piora-tool-call details") as HTMLDetailsElement).open).toBe(true);
 await view.onClose();
});
it("aligns live tool calls with historical results without duplicate cards",async()=>{
 const {plugin}=hostFixture();const {controller}=controllerFixture();plugin.controller=controller as unknown as SessionController;
 const call={toolCallId:"shared-call",toolName:"read",status:"running",output:"partial",truncated:false};
 Object.assign(controller.state,{toolCalls:[call],history:{messages:[{role:"assistant",content:[{type:"toolCall",toolCallId:"shared-call",toolName:"read",input:{secret:"private-args"}}]},{role:"toolResult",toolCallId:"shared-call",toolName:"read",isError:false,content:[{type:"text",text:"final result"}]}]}});
 const view=new ChatView({} as never,plugin);await view.onOpen();expect(view.contentEl.querySelectorAll(".piora-tool-call")).toHaveLength(1);expect(view.contentEl.textContent).toContain("read · 成功");expect(view.contentEl.textContent).toContain("final result");expect(view.contentEl.textContent).not.toContain("partial");expect(view.contentEl.textContent).not.toContain("private-args");
 Object.assign(controller.state,{toolCalls:[]});plugin.emit();expect(view.contentEl.querySelectorAll(".piora-tool-call")).toHaveLength(1);await view.onClose();
});
it("shows interrupted or unavailable historical results without inventing success",async()=>{
 const {plugin}=hostFixture();const {controller}=controllerFixture();plugin.controller=controller as unknown as SessionController;
 Object.assign(controller.state,{history:{messages:[{role:"assistant",content:[{type:"toolCall",id:"unfinished",name:"read",arguments:{secret:"do-not-render"}}]},{role:"toolResult",toolCallId:"failed",toolName:"bash",isError:true,content:[{type:"text",text:"failure"}]}]}});
 const view=new ChatView({} as never,plugin);await view.onOpen();expect(view.contentEl.textContent).toContain("read · 未收到结果");expect(view.contentEl.textContent).toContain("bash · 失败");expect(view.contentEl.textContent).not.toContain("do-not-render");await view.onClose();
});
it("opens a connection-first pane with no enabled send button",async()=>{
 const plugin={controller:undefined,settings:{address:"",policy:"notes"},notes:[],listeners:new Set(),draft:"",connect:vi.fn(),openSettings:vi.fn()};
 const view=new ChatView({} as never,plugin as never);await view.onOpen();
 expect(view.contentEl.textContent).toContain("Piora");
 expect(view.contentEl.querySelector<HTMLButtonElement>('[data-action="send"]')?.disabled).toBe(true);
 expect(view.contentEl.textContent).toContain("连接");
});

it("synchronizes externally changed drafts without resetting an unchanged selection",async()=>{
  const {plugin}=hostFixture();const view=new ChatView({} as never,plugin);await view.onOpen();document.body.append(view.contentEl);
  const input=view.contentEl.querySelector("textarea")!;input.focus();input.value="draft";input.dispatchEvent(new Event("input"));input.setSelectionRange(1,3);
  plugin.emit();expect(input.selectionStart).toBe(1);expect(input.selectionEnd).toBe(3);
  plugin.draft="解释选中的内容";plugin.emit();expect(input.value).toBe(plugin.draft);
  await view.onClose();
});

it("disables steering unless connected, running, authorized and settled",async()=>{
  const {plugin}=hostFixture();const {controller,scopes}=controllerFixture();plugin.controller=controller as unknown as SessionController;
  const view=new ChatView({} as never,plugin);await view.onOpen();const steer=findButton(view.contentEl,"引导");
  expect(steer.disabled).toBe(true);controller.state.control.runtime="running";plugin.emit();expect(steer.disabled).toBe(false);
  scopes.delete("session.steer");plugin.emit();expect(steer.disabled).toBe(true);scopes.add("session.steer");
  controller.state.uncertain=true;plugin.emit();expect(steer.disabled).toBe(true);controller.state.uncertain=false;
  controller.state.sending=true;plugin.emit();expect(steer.disabled).toBe(true);controller.state.sending=false;
  controller.state.connected=false;plugin.emit();expect(steer.disabled).toBe(true);await view.onClose();
});

it("captures an already active editor when the plugin loads",async()=>{
  const {plugin,workspace}=hostFixture();await plugin.onload();workspace.getActiveViewOfType.mockReturnValue(null as never);
  await plugin.addCurrent();expect(plugin.notes).toEqual([expect.objectContaining({path:"fixture.md",text:"original"})]);plugin.onunload();
});

it("opens actionable connection settings from the pane",()=>{
  const {plugin}=hostFixture();plugin.openSettings();expect(Modal.opened).toHaveLength(1);
  expect(Modal.opened[0].contentEl.textContent).toContain("本机服务地址");expect(Modal.opened[0].contentEl.querySelector('input[type="password"]')).not.toBeNull();
});

it("registers the designed new-session command without bypassing the mode confirmation",async()=>{
  const {plugin}=hostFixture();await plugin.onload();const create=vi.spyOn(plugin,"newSession").mockResolvedValue();
  const commands=(plugin as unknown as {commands:{id:string;callback?:()=>void}[]}).commands;
  const command=commands.find(candidate=>candidate.id==="new-session");expect(command).toBeDefined();command!.callback!();
  await vi.waitFor(()=>expect(create).toHaveBeenCalledOnce());plugin.onunload();
});

it("validates all open editor buffers before changing any of them",async()=>{
  const {plugin,file,editor,workspace}=hostFixture();const changed={...editor,getValue:()=>"other view changed",replaceRange:vi.fn()};
  workspace.getLeavesOfType.mockReturnValue([{view:new MarkdownView(file,editor)},{view:new MarkdownView(file,changed)}]);
  await expect(plugin.apply({path:file.path,text:"original",original:"original"},"replacement")).rejects.toThrow("冲突");
  expect(editor.replaceRange).not.toHaveBeenCalled();expect(changed.replaceRange).not.toHaveBeenCalled();
});

it("rechecks non-active note content inside the atomic vault operation",async()=>{
  const {plugin,file,workspace}=hostFixture();workspace.getLeavesOfType.mockReturnValue([]);
  const process=vi.fn(async (_file:unknown,transform:(text:string)=>string)=>transform("changed before write"));Object.assign(plugin.app.vault,{process});
  await expect(plugin.apply({path:file.path,text:"original",original:"original"},"replacement")).rejects.toThrow("冲突");expect(process).toHaveBeenCalledOnce();
});

it("preserves drafts and replacement references edited while delivery is pending",async()=>{
  const {plugin}=hostFixture();const {controller}=controllerFixture();let acknowledge!:()=>void;
  controller.send.mockImplementation(()=>new Promise<void>(resolve=>{acknowledge=resolve;}));plugin.controller=controller as unknown as SessionController;
  const first={path:"fixture.md",text:"original",original:"original"};const next={...first,text:"updated",original:"updated"};
  plugin.draft="first";plugin.notes=[first];const sending=plugin.send();plugin.draft="second";plugin.notes=[next];acknowledge();await sending;
  expect(controller.send).toHaveBeenCalledWith(buildPrompt("first",[first]));expect(plugin.draft).toBe("second");expect(plugin.notes).toEqual([next]);
});

it("clears acknowledged input but retains newly added references",async()=>{
  const {plugin}=hostFixture();const {controller}=controllerFixture();let acknowledge!:()=>void;
  controller.send.mockImplementation(()=>new Promise<void>(resolve=>{acknowledge=resolve;}));plugin.controller=controller as unknown as SessionController;
  const first={path:"fixture.md",text:"original",original:"original"};const next={...first,path:"next.md"};plugin.draft="first";plugin.notes=[first];
  const sending=plugin.send();plugin.notes.push(next);acknowledge();await sending;expect(plugin.draft).toBe("");expect(plugin.notes).toEqual([next]);
});

it("keeps the entire draft and references after a failed delivery",async()=>{
  const {plugin}=hostFixture();const {controller}=controllerFixture();controller.send.mockRejectedValue(new Error("timeout"));plugin.controller=controller as unknown as SessionController;
  plugin.draft="first";const notes=[{path:"fixture.md",text:"original",original:"original"}];plugin.notes=notes;
  await expect(plugin.send()).rejects.toThrow("timeout");expect(plugin.draft).toBe("first");expect(plugin.notes).toEqual(notes);
});

it("does not clear text typed while a steering request is pending",async()=>{
  const {plugin}=hostFixture();const {controller}=controllerFixture();controller.state.control.runtime="running";let acknowledge!:()=>void;
  controller.steer.mockImplementation(()=>new Promise<void>(resolve=>{acknowledge=resolve;}));plugin.controller=controller as unknown as SessionController;
  plugin.draft="guide";const view=new ChatView({} as never,plugin);await view.onOpen();findButton(view.contentEl,"引导").click();await vi.waitFor(()=>expect(controller.steer).toHaveBeenCalledWith("guide"));
  const input=view.contentEl.querySelector("textarea")!;input.value="next prompt";input.dispatchEvent(new Event("input"));acknowledge();await new Promise(resolve=>setTimeout(resolve,0));
  expect(plugin.draft).toBe("next prompt");expect(input.value).toBe("next prompt");await view.onClose();
});

it("requires confirmation before editing and applies through editor undo history",async()=>{
  const {plugin,file,editor}=hostFixture();plugin.capture(editor as unknown as Editor,file as never,false);plugin.review("inserted",true);
  const modal=Modal.opened[0];expect(editor.replaceRange).not.toHaveBeenCalled();findButton(modal.contentEl,"取消").click();await vi.waitFor(()=>expect(Modal.opened).toHaveLength(0));expect(editor.replaceRange).not.toHaveBeenCalled();
  plugin.review("inserted",true);findButton(Modal.opened[0].contentEl,"确认写入").click();await vi.waitFor(()=>expect(editor.replaceRange).toHaveBeenCalledWith("inserted",{line:0,ch:0},{line:0,ch:0}));
});

it("refuses edits made after preview and leaves the confirmation open",async()=>{
  const {plugin,file,editor,setValue}=hostFixture();plugin.capture(editor as unknown as Editor,file as never,false);plugin.review("inserted",true);const modal=Modal.opened[0];setValue("user changed");
  findButton(modal.contentEl,"确认写入").click();await vi.waitFor(()=>expect(Notice.messages.join(" ")).toContain("冲突"));expect(editor.replaceRange).not.toHaveBeenCalled();expect(Modal.opened).toContain(modal);expect(findButton(modal.contentEl,"确认写入").disabled).toBe(false);
});

it("offers explicit next-turn queueing with count and scope protection",async()=>{
  const {plugin}=hostFixture();const {controller,scopes}=controllerFixture();controller.state.control={runtime:"running",queueLength:2} as never;
  plugin.controller=controller as unknown as SessionController;const send=vi.spyOn(plugin,"send").mockResolvedValue();
  const view=new ChatView({} as never,plugin);await view.onOpen();const queue=findButton(view.contentEl,"排队下一轮");
  expect(queue.disabled).toBe(false);expect(view.contentEl.textContent).toContain("排队：2");queue.click();await vi.waitFor(()=>expect(send).toHaveBeenCalledWith(true));
  scopes.delete("session.messages.read");plugin.emit();expect(queue.disabled).toBe(true);scopes.add("session.messages.read");controller.state.uncertain=true;plugin.emit();expect(queue.disabled).toBe(true);
  await view.onClose();
});

it("keeps multiple persisted receipts when a legacy task is loaded",async()=>{
  const {plugin}=hostFixture();const loadData=vi.spyOn(plugin,"loadData").mockResolvedValue({task:{address:"http://localhost:1",sessionId:"one",key:"old",commandId:"old-command"}});
  await plugin.onload();await plugin.persist();expect(loadData).toHaveBeenCalledOnce();
  const saveData=vi.mocked(plugin.saveData);const data=saveData.mock.calls.at(-1)![0];expect(data).toMatchObject({tasks:[{address:"http://127.0.0.1:1/api/remote/v1",key:"old",commandId:"old-command"}]});expect(data).not.toHaveProperty("task");plugin.onunload();
});

it("lets the user cancel a tracked queued command without forgetting its receipt",async()=>{
  const {plugin}=hostFixture();const {controller}=controllerFixture();const cancel=vi.fn(async()=>{});
  Object.assign(controller,{cancel});Object.assign(controller.state,{tasks:[{sessionId:"session",key:"queued-key",commandId:"queued-command",status:"queued",delivery:"next_turn"}],capabilities:{features:{commandCancellation:true}}});
  plugin.controller=controller as unknown as SessionController;const view=new ChatView({} as never,plugin);await view.onOpen();findButton(view.contentEl,"取消任务").click();
  await vi.waitFor(()=>expect(cancel).toHaveBeenCalledWith("queued-command"));expect(view.contentEl.textContent).toContain("queued-comma");await view.onClose();
});

it("reconnects an ambiguous in-memory delivery without reselecting or losing its key",async()=>{
  const {plugin}=hostFixture();let attempts=0;const sent:unknown[]=[];
  vi.spyOn(plugin,"loadData").mockResolvedValue({lastSession:"one",lastServerId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"});
  vi.spyOn(RemoteClient.prototype,"identify").mockResolvedValue("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  vi.spyOn(RemoteClient.prototype,"request").mockImplementation((async(path:string,options:unknown)=>{
    if(path==="/capabilities")return {protocol:"piora.remote.v1",grantedScopes:["session.state.read","session.history.read","session.message.send","session.messages.read"]};
    if(path==="/sessions")return {sessions:[{id:"one"}]};if(path.endsWith("/history"))return {messages:[]};if(path.endsWith("/state"))return {runtime:"idle"};
    if(path.endsWith("/messages")){sent.push(options);if(++attempts===1)throw new Error("timeout");return {commandId:"receipt",status:"queued"};}return {status:"queued"};
  }) as never);
  await plugin.onload();await plugin.connect();plugin.draft="synthetic prompt";await expect(plugin.send()).rejects.toThrow("timeout");
  await expect(plugin.connect()).resolves.toBeUndefined();expect(plugin.controller!.state.uncertain).toBe(true);await plugin.controller!.retry();
  expect(sent).toHaveLength(2);expect(sent[0]).toEqual(sent[1]);plugin.onunload();
});

const fixtureIdentity="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function mockIdentityConnection(identity=fixtureIdentity){
 vi.spyOn(RemoteClient.prototype,"identify").mockResolvedValue(identity);
 return vi.spyOn(RemoteClient.prototype,"request").mockImplementation((async(path:string)=>{
  if(path==="/capabilities")return {protocol:"piora.remote.v1",serverId:identity,grantedScopes:["session.state.read","session.history.read"]};
  if(path==="/sessions")return {sessions:[]};throw new Error("Unexpected request: "+path);
 }) as never);
}
it("persists the explicitly connected address identity before any authenticated request",async()=>{
 const {plugin}=hostFixture();const request=mockIdentityConnection();await plugin.onload();
 vi.mocked(plugin.saveData).mockImplementationOnce(async data=>{expect(request).not.toHaveBeenCalled();expect(data.serverBindings[plugin.settings.address]).toBe(fixtureIdentity);});
 await plugin.connect();expect(request).toHaveBeenCalledWith("/capabilities");expect(plugin.saveData).toHaveBeenCalled();plugin.onunload();
});
it("rejects an instance change before invoking authenticated APIs or restoring old tasks",async()=>{
 const {plugin}=hostFixture();const address=plugin.settings.address;
 vi.mocked(plugin.loadData).mockResolvedValue({serverBindings:{[address]:fixtureIdentity}});const request=mockIdentityConnection("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
 await plugin.onload();await expect(plugin.connect()).rejects.toThrow("实例");expect(request).not.toHaveBeenCalled();plugin.onunload();
});
it("failed binding persistence prevents token requests and cannot become an in-memory trust bypass",async()=>{
 const {plugin}=hostFixture();const request=mockIdentityConnection();await plugin.onload();vi.mocked(plugin.saveData).mockRejectedValue(new Error("disk full"));
 await expect(plugin.connect()).rejects.toThrow("disk full");await expect(plugin.connect()).rejects.toThrow("disk full");expect(request).not.toHaveBeenCalled();plugin.onunload();
});
it("preserves but does not restore receipts from another or unknown instance",async()=>{
 const {plugin}=hostFixture();const address=plugin.settings.address;
 vi.mocked(plugin.loadData).mockResolvedValue({serverBindings:{[address]:fixtureIdentity},tasks:[{address,sessionId:"legacy",key:"old"},{address,serverId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",sessionId:"other",key:"other"}]});
 mockIdentityConnection();await plugin.onload();await plugin.connect();expect(plugin.controller!.state.uncertain).toBe(false);await plugin.persist();expect(vi.mocked(plugin.saveData).mock.calls.at(-1)![0].tasks).toHaveLength(2);expect(Notice.messages.join(" ")).toContain("回执");plugin.onunload();
});
it("replacing an instance requires confirmation and clears credentials without deleting old receipts",async()=>{
 const {plugin}=hostFixture();const address=plugin.settings.address;const values=new Map<string,string>();Object.assign(plugin.app,{secretStorage:{getSecret:(id:string)=>values.get(id)??null,setSecret:(id:string,value:string)=>values.set(id,value)}});
 vi.mocked(plugin.loadData).mockResolvedValue({serverBindings:{[address]:fixtureIdentity},tasks:[{address,serverId:fixtureIdentity,sessionId:"old",key:"keep"}]});
 await plugin.onload();plugin.setToken("fixture-token");plugin.openSettings();findButton(Modal.opened[0].contentEl,"更换实例绑定").click();await vi.waitFor(()=>expect(Modal.opened).toHaveLength(2));
 expect([...values.values()]).toEqual(["fixture-token"]);findButton(Modal.opened[1].contentEl,"确认清除绑定和凭证").click();await vi.waitFor(()=>expect(plugin.settings.rememberToken).toBe(false));
 expect([...values.values()]).toEqual([""]);const saved=vi.mocked(plugin.saveData).mock.calls.at(-1)![0];expect(saved.serverBindings[address]).toBeUndefined();expect(saved.tasks).toHaveLength(1);plugin.onunload();
});
it("restores a creation checkpoint without sending a new create request and offers explicit recovery",async()=>{
 const {plugin}=hostFixture();const address=plugin.settings.address;const creation={address,serverId:fixtureIdentity,key:"original-create",capabilityId:"fixture-capability",input:{cwd:"fixture-vault",policy:"notes"}};
 vi.mocked(plugin.loadData).mockResolvedValue({serverBindings:{[address]:fixtureIdentity},creations:[creation]});const request=mockIdentityConnection();await plugin.onload();await plugin.connect();
 expect(plugin.controller!.state.creation).toMatchObject({key:"original-create"});expect(request.mock.calls.some(([path,options])=>path==="/sessions"&&options)).toBe(false);
 const view=new ChatView({} as never,plugin);await view.onOpen();expect(view.contentEl.textContent).toContain("会话创建");expect(findButton(view.contentEl,"重试原会话创建")).toBeDefined();
 findButton(view.contentEl,"核对创建回执").click();await vi.waitFor(()=>expect(Modal.opened).toHaveLength(1));expect(plugin.controller!.state.creation).toBeDefined();findButton(Modal.opened[0].contentEl,"已核对，清除创建回执").click();await vi.waitFor(()=>expect(plugin.controller!.state.creation).toBeUndefined());expect(vi.mocked(plugin.saveData).mock.calls.at(-1)![0].creations).toEqual([]);await view.onClose();plugin.onunload();
});
it("keeps other-instance creation checkpoints and rejects malformed creation metadata",async()=>{
 const {plugin}=hostFixture();const address=plugin.settings.address;const creation={address,serverId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",key:"other-create",capabilityId:"fixture-capability",input:{cwd:"fixture-vault",policy:"notes"}};
 vi.mocked(plugin.loadData).mockResolvedValue({serverBindings:{[address]:fixtureIdentity},creations:[creation]});mockIdentityConnection();await plugin.onload();await plugin.connect();expect(plugin.controller!.state.creation).toBeUndefined();await plugin.persist();expect(vi.mocked(plugin.saveData).mock.calls.at(-1)![0].creations).toEqual([creation]);plugin.onunload();
 const broken=hostFixture().plugin;vi.mocked(broken.loadData).mockResolvedValue({creations:[{address,serverId:fixtureIdentity,key:"broken"}]});await expect(broken.onload()).rejects.toThrow("创建");
});
it("saves the created selection before clearing its durable checkpoint",async()=>{
 const {plugin}=hostFixture();Object.assign(plugin.app.vault,{getName:()=>"Synthetic Vault"});const calls:string[]=[];
 const controller={state:{connected:true},create:vi.fn(async()=>"created"),clearCreation:vi.fn(async()=>{calls.push("clear");})};plugin.controller=controller as unknown as SessionController;
 vi.mocked(plugin.saveData).mockImplementation(async data=>{expect(data.lastSession).toBe("created");calls.push("save");});await plugin.newSession();expect(calls).toEqual(["save","clear"]);
});

it("explains history-only fallback rather than showing a fake live stream",async()=>{
 const {plugin}=hostFixture();const {controller}=controllerFixture();plugin.controller=controller as unknown as SessionController;
 const view=new ChatView({} as never,plugin);await view.onOpen();expect(view.contentEl.textContent).toContain("历史同步");
 Object.assign(controller.state,{capabilities:{features:{contentStream:true,contentStreamIdentity:"run-sequence-v1"}}});plugin.emit();expect(view.contentEl.textContent).not.toContain("历史同步");await view.onClose();
});

it("clears remembered credentials through the setting while retaining the running-process token",async()=>{
 const {plugin}=hostFixture();const values=new Map<string,string>();Object.assign(plugin.app,{secretStorage:{getSecret:(id:string)=>values.get(id)??null,setSecret:(id:string,value:string)=>values.set(id,value)}});
 plugin.setToken("fixture-token");plugin.openSettings();const toggle=Modal.opened[0].contentEl.querySelector<HTMLInputElement>('input[type="checkbox"]')!;toggle.checked=false;toggle.dispatchEvent(new Event("change"));
 await vi.waitFor(()=>expect(plugin.settings.rememberToken).toBe(false));expect([...values.values()]).toEqual([""]);
 const forget=findButton(Modal.opened[0].contentEl,"忘记令牌");forget.click();await vi.waitFor(()=>expect(Notice.messages.join(" ")).toContain("已清空"));
});
