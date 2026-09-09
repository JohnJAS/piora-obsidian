import type { RemoteClient } from "./client";
import { ApiError } from "./client";
import { randomUUID } from "node:crypto";
export interface Capabilities { protocol: string; grantedScopes: string[]; serverId?: string; features?: { contentStream?: boolean; sessionPolicies?: string[]; models?: boolean }; sessionCreation?: { fields: string[]; thinkingLevels?: string[] } }
export interface ModelInfo {id:string;provider:string;name?:string;thinkingLevels?:string[]}
export interface SessionInfo { id: string; name?: string; cwd?: string }
export interface ChatMessage { role: string; content: unknown }
export interface History { messages: ChatMessage[]; entryIds?: string[]; model?: {provider: string; modelId: string}; thinkingLevel?: string; remotePolicy?: "notes"|"agent" }
export interface ControlState { runtime: string; queueLength?: number; pendingApproval?: boolean; activeRunId?: string }
export interface TaskReceipt {sessionId:string;key:string;commandId?:string}
export interface SessionUiState { connected: boolean; sessions: SessionInfo[]; selectedId?: string; history: History; control: ControlState; error: string; sending: boolean; uncertain: boolean; live: string; tools: string[]; capabilities?: Capabilities }
export class SessionController {
  models:ModelInfo[]=[];
  restoreTask(task:TaskReceipt):void {
    if(task.sessionId!==this.state.selectedId)return;
    this.activeCommand=task.commandId;
    if(!task.commandId){this.state.uncertain=true;this.state.error="上次投递未收到确认，正文未落盘；请在 Piora 核对执行情况后解除锁定，不要重复发送。";}
    this.schedule(this.generation,500);this.changed();
  }
  async forgetTask():Promise<void> {if(this.state.sending)throw new Error("投递中不能解除锁定");await this.saveTask(null);this.pending=undefined;this.state.uncertain=false;this.state.error="";this.changed();}
  state: SessionUiState = { connected:false,sessions:[],history:{messages:[]},control:{runtime:"idle"},error:"",sending:false,uncertain:false,live:"",tools:[] };
  constructor(private api: Pick<RemoteClient,"request"|"stream">, private changed: ()=>void = ()=>{}, private saveTask:(task:TaskReceipt|null)=>Promise<void> = async()=>{}) {}
  private generation = 0;
  private watch?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private refreshing = false;
  private pending?: {path:string;body:{content:string};key:string};
  private creation?: {body:unknown;key:string};
  private activeCommand?: string;
  has(scope:string): boolean { return this.state.capabilities?.grantedScopes.includes(scope) === true; }
  private require(scope:string): void { if (!this.has(scope)) throw new Error("缺少权限："+scope); }
  private path(suffix:string): string { if (!this.state.selectedId) throw new Error("请先选择会话"); return "/sessions/"+encodeURIComponent(this.state.selectedId)+suffix; }
  async connect(): Promise<void> {
    this.disconnect();
    const generation=this.generation;
    const capabilities=await this.api.request<Capabilities>("/capabilities");
    if(capabilities.protocol!=="piora.remote.v1" || !Array.isArray(capabilities.grantedScopes)) throw new Error("不兼容的 Piora 协议");
    if(generation!==this.generation)return;
    this.state.capabilities=capabilities;
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
    if(this.state.sending || this.state.uncertain)throw new Error("请先处理当前未确认的消息");
    this.cancelWatch(); const generation=++this.generation;
    this.state.selectedId=id;this.state.history={messages:[]};this.state.live="";this.state.tools=[];this.activeCommand=undefined;this.state.error="";
    this.watch=new AbortController();this.changed();
    await this.refresh(generation);
    if(generation!==this.generation)return;
    this.startStreams(generation,this.watch.signal);this.schedule(generation);
  }
  private cancelWatch():void { this.watch?.abort();clearTimeout(this.timer);this.refreshing=false; }
  private async refresh(generation=this.generation):Promise<void> {
    const base=this.path("");
    const [history,control]=await Promise.all([this.api.request<History>(base+"/history"),this.api.request<ControlState>(base+"/state")]);
    if(generation!==this.generation)return;
    if(!Array.isArray(history.messages)||typeof control.runtime!=="string")throw new Error("无效会话响应");
    this.state.history=history;this.state.control=control;
    if(control.runtime==="idle")this.state.live="";
    if(this.activeCommand&&this.has("session.messages.read")) {
      const commandId=this.activeCommand;
      const command=await this.api.request<{status?:string;command?:{status?:string}}>("/commands/"+encodeURIComponent(commandId));
      if(generation!==this.generation)return;
      const status=command.status??command.command?.status;
      if(status&&["failed","cancelled","expired","interrupted"].includes(status)) this.state.error="任务状态："+status;
      if(status&&["completed","failed","cancelled","expired","interrupted"].includes(status)&&this.activeCommand===commandId){this.activeCommand=undefined;await this.saveTask(null);}
      else if(status&&control.runtime==="idle")this.state.control={...control,runtime:"queued"};
    }
    this.changed();
  }
  private schedule(generation:number,delay=10000):void {
    clearTimeout(this.timer);
    this.timer=setTimeout(()=>{
      if(generation!==this.generation)return;
      if(this.refreshing){this.schedule(generation);return;}
      this.refreshing=true;
      void this.refresh(generation).then(()=>{if(generation===this.generation)this.schedule(generation);}).catch(error=>{
        if(generation!==this.generation)return;
        this.state.error=error instanceof Error?error.message:"连接中断";this.changed();
        if(error instanceof ApiError&&[401,403].includes(error.status)){this.cancelWatch();return;}
        this.schedule(generation,error instanceof ApiError?Math.max(error.retryAfterMs,10000):15000);
      }).finally(()=>{if(generation===this.generation)this.refreshing=false;});
    },delay);
  }
  private startStreams(generation:number,signal:AbortSignal):void {
    if(!this.has("session.events.read"))return;
    const consume=async(suffix:string)=>{
      let failures=0;
      while(!signal.aborted&&generation===this.generation){
        try {
          await this.api.stream(this.path(suffix),event=>{
            if(signal.aborted||generation!==this.generation)return;
            if(event.type==="content.snapshot"&&typeof event.text==="string")this.state.live=event.text;
            if(event.type==="content.snapshot"&&Array.isArray(event.tools))this.state.tools=event.tools.filter((name):name is string=>typeof name==="string").slice(-20);
            if(event.type==="error")throw new ApiError(403,"REMOTE_ACCESS_ENDED");
            if(event.type==="tool.started"&&typeof event.name==="string")this.state.tools=[...this.state.tools.slice(-19),event.name];
            if(event.type==="snapshot"&&event.state&&typeof event.state==="object")this.state.control=event.state as ControlState;
            if(["prompt_done","prompt_error","command_completed","command_failed"].includes(String(event.type)))this.schedule(generation,400);
            this.changed();
          },signal);
          if(signal.aborted)return;
          failures++;
        }catch(error){
          if(signal.aborted||generation!==this.generation)return;
          this.state.error=error instanceof Error?error.message:"事件流中断";this.changed();
          if(error instanceof ApiError&&[401,403,404].includes(error.status))return;
          failures++;
        }
        const delay=Math.min(30000,1000*2**Math.min(failures,5))+Math.random()*500;
        await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener("abort",done);resolve();};const timer=setTimeout(done,delay);signal.addEventListener("abort",done,{once:true});});
      }
    };
    void consume("/events");
    if(this.state.capabilities?.features?.contentStream)void consume("/content-events");
  }
  async send(content:string):Promise<void> {
    this.require("session.message.send");
    if(!content.trim())throw new Error("请输入消息");
    if(this.state.sending||this.pending||this.state.uncertain)throw new Error("上一条消息尚未确认，请重试或核对状态");
    if(this.state.control.runtime!=="idle")throw new Error("任务正在运行；请等待或使用引导");
    this.pending={path:this.path("/messages"),body:{content},key:randomUUID()};await this.deliver();
  }
  private async deliver():Promise<void> {
    if(!this.pending||this.state.sending)throw new Error("没有可重试的消息");
    const pending=this.pending;this.state.sending=true;this.state.error="";this.changed();
    try {
      const task:TaskReceipt={sessionId:this.state.selectedId!,key:pending.key};
      await this.saveTask(task);
      const result=await this.api.request<{commandId:string}>(pending.path,{body:pending.body,key:pending.key});
      if(typeof result.commandId!=="string")throw new Error("投递结果不明确，请重试");
      await this.saveTask({...task,commandId:result.commandId});
      this.activeCommand=result.commandId;this.pending=undefined;this.state.uncertain=false;this.state.control={runtime:"running"};this.schedule(this.generation,500);
    } catch(error) { this.state.uncertain=true;this.state.error=error instanceof Error?error.message:"投递未确认";throw error; }
    finally {this.state.sending=false;this.changed();}
  }
  async retry():Promise<void> { await this.deliver(); }
  async create(input:{cwd:string;policy:"notes"|"agent";name?:string;provider?:string;modelId?:string;thinkingLevel?:string}):Promise<string> {
    if(input.policy==="notes"&&!this.state.capabilities?.features?.sessionPolicies?.includes("notes"))throw new Error("此 Piora 尚不支持安全笔记助手，请更新服务端");
    this.require("session.create");
    if(this.state.sending||this.state.uncertain)throw new Error("请先处理待确认消息");
    const body={...input};
    if(!this.creation||JSON.stringify(this.creation.body)!==JSON.stringify(body))this.creation={body,key:randomUUID()};
    const result=await this.api.request<{sessionId:string}>("/sessions",this.creation);
    if(typeof result.sessionId!=="string")throw new Error("无效会话创建响应");
    this.creation=undefined;
    if(!this.state.sessions.some(session=>session.id===result.sessionId))this.state.sessions.unshift({id:result.sessionId,name:input.name,cwd:input.cwd});
    await this.select(result.sessionId);return result.sessionId;
  }
  async stop():Promise<void> {this.require("session.abort");await this.api.request(this.path("/abort"),{body:{}});this.schedule(this.generation,400);}
  async steer(content:string):Promise<void> {
    this.require("session.steer");if(this.state.control.runtime!=="running")throw new Error("只有运行中的任务可被引导");
    if(!content.trim()||this.pending)throw new Error("请输入引导消息并处理未确认投递");
    this.pending={path:this.path("/steer"),body:{content},key:randomUUID()};await this.deliver();
  }
  disconnect():void {this.cancelWatch();this.generation++;this.state.connected=false;this.changed();}
}
