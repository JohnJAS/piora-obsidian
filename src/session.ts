import type { RemoteClient } from "./client";
import { ApiError } from "./client";
import { randomUUID } from "node:crypto";
import { checkRequest } from "./core";
import { LiveStateGate } from "./live-state";
import type {ToolCall} from "./tool-calls";
import {snapshotImages,type ImageInput} from "./attachments";
export interface Capabilities { protocol: string; grantedScopes: string[]; serverId?: string; authentication?:{scheme:string;capabilityId?:string}; features?: { contentStream?: boolean;contentStreamIdentity?:string;toolLifecycle?:string;messageImages?:string; sessionPolicies?: string[]; models?: boolean;commandCancellation?:boolean }; sessionCreation?: { fields: string[]; thinkingLevels?: string[]; allowedPolicies?:string[]; cwdRoots?:string[]|null; legacyUnrestricted?:boolean } }
export interface ModelInfo {id:string;provider:string;name?:string;thinkingLevels?:string[]}
export interface SessionInfo { id: string; name?: string; cwd?: string }
export interface ChatMessage { role: string; content: unknown;toolCallId?:string;toolName?:string;isError?:boolean }
export interface History { messages: ChatMessage[]; entryIds?: string[]; model?: {provider: string; modelId: string}; thinkingLevel?: string; remotePolicy?: "notes"|"agent" }
export interface ControlState { runtime: string; queueLength?: number; pendingApproval?: boolean; activeRunId?: string }
export interface TaskReceipt {sessionId:string;key:string;commandId?:string;delivery?:"next_turn"|"steer";status?:string;queuePosition?:number}
export interface CreationInput {cwd:string;policy:"notes"|"agent";name?:string;provider?:string;modelId?:string;thinkingLevel?:string}
export interface CreationReceipt {key:string;capabilityId:string;input:CreationInput;sessionId?:string}
export function readCreationInput(value:unknown):CreationInput {
  if(!value||typeof value!=="object")throw new Error("无效会话创建参数");const record=value as Record<string,unknown>;
  if(typeof record.cwd!=="string"||!record.cwd.trim()||record.cwd.length>32768||(record.policy!=="notes"&&record.policy!=="agent"))throw new Error("无效会话创建目录或模式");
  const input:CreationInput={cwd:record.cwd.trim(),policy:record.policy};
  for(const [key,limit] of [["name",200],["provider",200],["modelId",300],["thinkingLevel",40]] as const){const field=record[key];if(field!==undefined&&(typeof field!=="string"||field.length>limit))throw new Error("无效会话创建参数");if(typeof field==="string"&&field.trim())input[key]=field.trim();}
  if(Boolean(input.provider)!==Boolean(input.modelId))throw new Error("模型提供商和模型 ID 必须同时填写");checkRequest(input);return input;
}
export function readCreationReceipt(value:unknown):CreationReceipt {
  if(!value||typeof value!=="object")throw new Error("无效会话创建回执");const record=value as Record<string,unknown>;
  for(const key of ["key","capabilityId"]){if(typeof record[key]!=="string"||!/^[A-Za-z0-9._:-]{1,512}$/.test(record[key]))throw new Error("无效会话创建回执身份");}
  if(record.sessionId!==undefined&&(typeof record.sessionId!=="string"||!/^[A-Za-z0-9._:-]{1,200}$/.test(record.sessionId)))throw new Error("无效创建回执会话 ID");
  return {key:record.key as string,capabilityId:record.capabilityId as string,input:readCreationInput(record.input),...(typeof record.sessionId==="string"?{sessionId:record.sessionId}:{})};
}
export interface SessionUiState { connected: boolean; sessions: SessionInfo[]; selectedId?: string; history: History; control: ControlState; error: string; sending: boolean; uncertain: boolean; creating:boolean;creation?:CreationReceipt; live: string; tools: string[];toolCalls:ToolCall[];omittedToolCalls:number; tasks:TaskReceipt[]; capabilities?: Capabilities }
const TERMINAL_STATUSES=new Set(["completed","failed","cancelled","expired","interrupted"]);
export class SessionController {
  models:ModelInfo[]=[];
  restoreTask(task:TaskReceipt):void {
    if(this.receipts.has(task.key))return;
    this.receipts.set(task.key,{...task});this.syncTasks();
    if(task.sessionId===this.state.selectedId)this.schedule(this.generation,500);this.changed();
  }
  async forgetTask():Promise<void> {
    if(this.state.sending)throw new Error("投递中不能解除锁定");
    for(const task of this.state.tasks)if(!task.commandId||task.key===this.pending?.key){await this.saveTask(null,task.key);this.receipts.delete(task.key);}
    this.pending=undefined;this.state.error="";this.syncTasks();this.changed();
  }
  state: SessionUiState = { connected:false,sessions:[],history:{messages:[]},control:{runtime:"idle"},error:"",sending:false,uncertain:false,creating:false,live:"",tools:[],toolCalls:[],omittedToolCalls:0,tasks:[] };
  constructor(private api: Pick<RemoteClient,"request"|"stream">, private changed: ()=>void = ()=>{}, private saveTask:(task:TaskReceipt|null,key?:string)=>Promise<void> = async()=>{},private saveCreation:(receipt:CreationReceipt|null)=>Promise<void> = async()=>{}) {}
  private generation = 0;
  private watch?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private refreshing = false;
  private pending?: {sessionId:string;path:string;body:{content:string;delivery?:"next_turn";images?:ImageInput[]};delivery:"next_turn"|"steer";key:string};
  private receipts=new Map<string,TaskReceipt>();
  private liveState=new LiveStateGate("");
  private reconciliationError?:string;
  private syncTasks():void {
    this.state.tasks=[...this.receipts.values()].filter(task=>task.sessionId===this.state.selectedId).map(task=>({...task}));
    this.state.uncertain=this.state.tasks.some(task=>!task.commandId)||Boolean(this.pending);
    if(this.state.uncertain&&!this.state.sending&&!this.state.error)this.state.error="上次投递未收到确认，正文未落盘；请重试或在 Piora 核对后解除锁定。";
  }
  has(scope:string): boolean { return this.state.capabilities?.grantedScopes.includes(scope) === true; }
  private require(scope:string): void { if (!this.has(scope)) throw new Error("缺少权限："+scope); }
  private path(suffix:string): string { if (!this.state.selectedId) throw new Error("请先选择会话"); return "/sessions/"+encodeURIComponent(this.state.selectedId)+suffix; }
  async connect(): Promise<void> {
    this.disconnect();
    const generation=this.generation;
    const capabilities=await this.api.request<Capabilities>("/capabilities");
    if(capabilities.protocol!=="piora.remote.v1" || !Array.isArray(capabilities.grantedScopes)) throw new Error("不兼容的 Piora 协议");
    if(generation!==this.generation)return;
    this.state.capabilities={...capabilities,grantedScopes:[...capabilities.grantedScopes]};
    this.models=[];
    if(capabilities.features?.models){const catalog=await this.api.request<{models:ModelInfo[]}>("/models");if(generation!==this.generation)return;this.models=Array.isArray(catalog.models)?catalog.models.filter(model=>typeof model.id==="string"&&typeof model.provider==="string"):[];}
    this.require("session.state.read");this.require("session.history.read");
    const result=await this.api.request<{sessions:SessionInfo[]}>("/sessions");
    if(!Array.isArray(result.sessions))throw new Error("无效会话列表");
    if(generation!==this.generation)return;
    this.state.sessions=result.sessions;this.state.connected=true;this.state.error="";this.changed();
    if(this.state.selectedId&&this.state.uncertain&&this.state.sessions.some(session=>session.id===this.state.selectedId)) {this.watch=new AbortController();this.startStreams(generation,this.watch.signal);this.schedule(generation);}
  }
  async select(id:string):Promise<void> {
    if(!this.state.sessions.some(session=>session.id===id))throw new Error("会话未授权");
    if(this.state.sending || this.pending)throw new Error("请先处理当前未确认的消息");
    this.cancelWatch(); const generation=++this.generation;
    this.liveState=new LiveStateGate(id,this.state.capabilities?.features?.toolLifecycle==="tool-calls-v1");
    this.state.selectedId=id;this.state.history={messages:[]};this.state.live="";this.state.tools=[];this.state.toolCalls=[];this.state.omittedToolCalls=0;this.state.error="";this.syncTasks();
    this.watch=new AbortController();this.changed();
    await this.refresh(generation);
    if(generation!==this.generation)return;
    this.startStreams(generation,this.watch.signal);this.schedule(generation);
  }
  private cancelWatch():void { this.watch?.abort();clearTimeout(this.timer);this.refreshing=false; }
  private async refresh(generation=this.generation):Promise<boolean> {
    const base=this.path("");
    const revision=this.liveState.revision;
    const [history,control]=await Promise.all([this.api.request<History>(base+"/history"),this.api.request<ControlState>(base+"/state")]);
    if(generation!==this.generation)return false;
    if(!Array.isArray(history.messages)||typeof control.runtime!=="string")throw new Error("无效会话响应");
    if(this.has("session.messages.read"))for(const task of this.state.tasks) {
      if(!task.commandId)continue;
      const command=await this.api.request<{status?:string;command?:{status?:string}}>("/commands/"+encodeURIComponent(task.commandId));
      if(generation!==this.generation)return false;
      const status=command.status??command.command?.status;
      if(typeof status!=="string")continue;
      if(TERMINAL_STATUSES.has(status)) {
        if(status!=="completed")this.state.error="任务状态："+status;
        await this.saveTask(null,task.key);this.receipts.delete(task.key);
        if(generation!==this.generation)return false;
      }else if(this.receipts.get(task.key)?.commandId===task.commandId)this.receipts.set(task.key,{...task,status});
    }
    this.syncTasks();
    if(revision!==this.liveState.revision||!this.liveState.reconcile(control)){this.changed();return false;}
    if(control.runtime==="idle"&&!control.activeRunId||control.activeRunId&&control.activeRunId!==this.state.control.activeRunId){this.state.live="";this.state.tools=[];this.state.toolCalls=[];this.state.omittedToolCalls=0;}
    this.state.history=history;this.state.control=control;
    if(this.reconciliationError&&this.state.error===this.reconciliationError)this.state.error="";
    this.reconciliationError=undefined;
    if(control.runtime==="idle"&&((control.queueLength??0)>0||this.state.tasks.some(task=>task.commandId&&!TERMINAL_STATUSES.has(task.status??""))))this.state.control={...control,runtime:"queued"};
    this.changed();
    return true;
  }
  private schedule(generation:number,delay=10000):void {
    clearTimeout(this.timer);
    this.timer=setTimeout(()=>{
      if(generation!==this.generation)return;
      if(this.refreshing){this.schedule(generation);return;}
      this.refreshing=true;
      void this.refresh(generation).then(updated=>{if(generation===this.generation)this.schedule(generation,updated?10000:400);}).catch(error=>{
        if(generation!==this.generation)return;
        this.reconciliationError=error instanceof Error?error.message:"连接中断";this.state.error=this.reconciliationError;this.changed();
        if(error instanceof ApiError&&[401,403].includes(error.status)){this.disconnect();return;}
        this.schedule(generation,error instanceof ApiError?Math.max(error.retryAfterMs,10000):15000);
      }).finally(()=>{if(generation===this.generation)this.refreshing=false;});
    },delay);
  }
  private startStreams(generation:number,signal:AbortSignal):void {
    if(!this.has("session.events.read"))return;
    const consume=async(suffix:string)=>{
      let failures=0;
      let lastError:string|undefined;
      while(!signal.aborted&&generation===this.generation){
        let accepting=true;
        const connection=suffix==="/content-events"?this.liveState.openStream():undefined;
        try {
          await this.api.stream(this.path(suffix),event=>{
            if(!accepting||signal.aborted||generation!==this.generation)return;
            if(event.sessionId!==undefined&&event.sessionId!==this.state.selectedId)return;
            if(event.type==="stream.reset")throw new ApiError(409,"REMOTE_SESSION_RESTARTED");
            if(event.type==="error")throw new ApiError(403,"REMOTE_ACCESS_ENDED");
            if(event.type==="content.snapshot"&&connection!==undefined){
              const frame=this.liveState.accept(event,connection);if(!frame)return;
              this.state.live=frame.text;this.state.tools=frame.tools;this.state.toolCalls=frame.toolCalls;this.state.omittedToolCalls=frame.omittedToolCalls;
              if(frame.running)this.state.control={...this.state.control,runtime:"running",activeRunId:frame.runId!};else this.schedule(generation,400);
            }
            if(["snapshot","session_state","prompt_started","prompt_done","prompt_error","command_completed","command_failed","command_cancelled","command_expired","command_interrupted","command_queued"].includes(String(event.type)))this.schedule(generation,400);
            if(lastError&&this.state.error===lastError)this.state.error="";lastError=undefined;failures=0;
            this.changed();
          },signal);
          if(signal.aborted)return;
          failures++;
        }catch(error){
          if(signal.aborted||generation!==this.generation)return;
          lastError=error instanceof Error?error.message:"事件流中断";this.state.error=lastError;this.changed();
          if(error instanceof ApiError&&[401,403,404].includes(error.status)){this.disconnect();return;}
          failures++;
        }finally{accepting=false;}
        const delay=Math.min(30000,1000*2**Math.min(failures,5))+Math.random()*500;
        await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener("abort",done);resolve();};const timer=setTimeout(done,delay);signal.addEventListener("abort",done,{once:true});});
      }
    };
    void consume("/events");
    if(this.state.capabilities?.features?.contentStream&&this.state.capabilities.features.contentStreamIdentity==="run-sequence-v1")void consume("/content-events");
  }
  async send(content:string,images:ImageInput[]=[]):Promise<void> {await this.submit(content,false,images);}
  async enqueue(content:string,images:ImageInput[]=[]):Promise<void> {this.require("session.messages.read");await this.submit(content,true,images);}
  private assertDelivery(content:string,images:ImageInput[]):ImageInput[] {
    if(this.state.creating)throw new Error("请等待会话创建请求结束");
    if(!this.state.connected)throw new Error("请先连接 Piora");
    if(!content.trim()&&!images.length)throw new Error("请输入消息");
    if(this.state.sending||this.pending||this.state.uncertain)throw new Error("上一条消息尚未确认，请重试或核对状态");
    if(this.state.tasks.length>=10)throw new Error("当前会话最多跟踪 10 条未完成命令，请等待完成后再发送");
    if(this.receipts.size>=100)throw new Error("最多保留 100 条任务回执，请先切换会话核对未完成任务");
    if(images.length&&this.state.capabilities?.features?.messageImages!=="base64-images-v1")throw new Error("此 Piora 未声明图片消息能力，请升级服务端");
    const attached=snapshotImages(images);checkRequest({content,delivery:"next_turn",...(attached.length?{images:attached}:{})});return attached;
  }
  private async submit(content:string,queued:boolean,images:ImageInput[]):Promise<void> {
    this.require("session.message.send");
    const attached=this.assertDelivery(content,images);
    if(!queued&&this.state.control.runtime!=="idle")throw new Error("任务正在运行；请等待、排队或使用引导");
    this.pending={sessionId:this.state.selectedId!,path:this.path("/messages"),body:{content,delivery:"next_turn",...(attached.length?{images:attached}:{})},delivery:"next_turn",key:randomUUID()};await this.deliver();
  }
  private async deliver():Promise<void> {
    if(!this.pending||this.state.sending)throw new Error("没有可重试的消息");
    if(!this.state.connected)throw new Error("请先连接 Piora");
    const pending=this.pending;const generation=this.generation;this.state.sending=true;this.state.error="";this.changed();
    try {
      const task:TaskReceipt={sessionId:pending.sessionId,key:pending.key,delivery:pending.delivery};
      this.receipts.set(task.key,task);this.syncTasks();
      await this.saveTask(task);
      const result=await this.api.request<{commandId:string;status?:string;queuePosition?:number}>(pending.path,{body:pending.body,key:pending.key});
      if(typeof result.commandId!=="string"||!result.commandId)throw new Error("投递结果不明确，请重试");
      const acknowledged:TaskReceipt={...task,commandId:result.commandId,status:typeof result.status==="string"?result.status:"accepted",...(Number.isInteger(result.queuePosition)&&result.queuePosition!>=0?{queuePosition:result.queuePosition}:{})};
      await this.saveTask(acknowledged);this.receipts.set(task.key,acknowledged);this.pending=undefined;this.syncTasks();
      if(generation===this.generation){
        if(pending.delivery==="next_turn"&&!TERMINAL_STATUSES.has(acknowledged.status!))this.state.control={...this.state.control,runtime:this.state.control.runtime==="idle"?(acknowledged.status==="running"?"running":"queued"):this.state.control.runtime,...(acknowledged.queuePosition!==undefined?{queueLength:acknowledged.queuePosition}:{})};
        this.schedule(generation,500);
      }
    } catch(error) { this.state.uncertain=true;this.state.error=error instanceof Error?error.message:"投递未确认";throw error; }
    finally {this.state.sending=false;this.changed();}
  }
  async retry():Promise<void> { await this.deliver(); }
  restoreCreation(value:CreationReceipt):void {const receipt=readCreationReceipt(value);if(this.state.creation){if(this.state.creation.key!==receipt.key)throw new Error("请先核对上一条会话创建回执");return;}this.state.creation=receipt;this.changed();}
  async retryCreation():Promise<string> {if(!this.state.creation)throw new Error("没有可恢复的会话创建");return this.create(this.state.creation.input);}
  async clearCreation():Promise<void> {if(this.state.creating)throw new Error("创建请求仍在处理中");await this.saveCreation(null);this.state.creation=undefined;this.changed();}
  async create(value:CreationInput):Promise<string> {
    if(!this.state.connected)throw new Error("请先连接 Piora");if(this.state.creating)throw new Error("已有会话创建请求正在处理中");
    const input=readCreationInput(value);
    if(input.policy==="notes"&&!this.state.capabilities?.features?.sessionPolicies?.includes("notes"))throw new Error("此 Piora 尚不支持安全笔记助手，请更新服务端");
    this.require("session.create");
    const allowedPolicies=this.state.capabilities?.sessionCreation?.allowedPolicies;
    if(allowedPolicies&&!allowedPolicies.includes(input.policy))throw new Error("此令牌不允许创建所选模式的会话");
    if(this.state.sending||this.state.uncertain)throw new Error("请先处理待确认消息");
    const capabilityId=this.state.capabilities?.authentication?.capabilityId;if(!capabilityId)throw new Error("服务未提供创建恢复所需令牌身份，请更新 Piora");
    if(this.state.creation&&JSON.stringify(this.state.creation.input)!==JSON.stringify(input))throw new Error("上一条会话创建尚未完成，请重试原请求或核对后清除创建回执");
    if(this.state.creation&&this.state.creation.capabilityId!==capabilityId)throw new Error("创建回执属于另一枚令牌，请使用原令牌或核对后清除回执");
    this.state.creation??=readCreationReceipt({input,key:randomUUID(),capabilityId});this.state.creating=true;this.changed();
    const generation=this.generation;
    try{
      await this.saveCreation(readCreationReceipt(this.state.creation));
      if(generation!==this.generation||!this.state.connected)throw new Error("连接已变化，创建回执已保留，请重新连接后核对");
      if(!this.state.creation.sessionId){
        const result=await this.api.request<{sessionId:string}>("/sessions",{body:input,key:this.state.creation.key,capabilityId});
        const receipt=readCreationReceipt({...this.state.creation,sessionId:result.sessionId});if(!receipt.sessionId)throw new Error("无效会话创建响应");
        this.state.creation=receipt;await this.saveCreation(readCreationReceipt(receipt));
      }
      const id=this.state.creation.sessionId!;
      if(generation!==this.generation||!this.state.connected)throw new Error("连接已变化，已创建会话的回执已保留，请重新连接后恢复");
      if(!this.state.sessions.some(session=>session.id===id))this.state.sessions.unshift({id,name:input.name,cwd:input.cwd});
      await this.select(id);if(this.generation!==generation+1||!this.state.connected||this.state.selectedId!==id)throw new Error("连接或会话已变化，创建回执已保留");return id;
    }finally{this.state.creating=false;this.changed();}
  }
  async stop():Promise<void> {this.require("session.abort");if(!this.state.connected)throw new Error("请先连接 Piora");await this.api.request(this.path("/abort"),{body:{}});this.schedule(this.generation,400);}
  async cancel(commandId:string):Promise<void> {
    this.require("session.abort");if(!this.state.connected)throw new Error("请先连接 Piora");
    if(!this.state.capabilities?.features?.commandCancellation)throw new Error("此 Piora 不支持按命令取消，请升级服务端");
    if(!this.state.tasks.some(task=>task.commandId===commandId))throw new Error("当前会话没有此命令回执");
    await this.api.request("/commands/"+encodeURIComponent(commandId)+"/cancel",{body:{}});this.schedule(this.generation,400);
  }
  async steer(content:string,images:ImageInput[]=[]):Promise<void> {
    this.require("session.steer");if(this.state.control.runtime!=="running")throw new Error("只有运行中的任务可被引导");
    const attached=this.assertDelivery(content,images);
    this.pending={sessionId:this.state.selectedId!,path:this.path("/steer"),body:{content,...(attached.length?{images:attached}:{})},delivery:"steer",key:randomUUID()};await this.deliver();
  }
  disconnect():void {this.cancelWatch();this.generation++;this.state.connected=false;this.changed();}
}
