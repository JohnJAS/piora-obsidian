import { Component, FileSystemAdapter, FuzzySuggestModal, ItemView, MarkdownRenderer, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, type Editor } from "obsidian";
import { diffLines } from "diff";
import { RemoteClient } from "./client";
import { SessionController } from "./session";
import { applyReplacement, isServerId, normalizeAddress, validateNotePath, type NoteContext } from "./core";
import { messageText, safeMarkdown } from "./presentation";
import { Credentials } from "./credentials";
import { ReplyContexts, replyKey } from "./reply-contexts";
import { assertVaultTarget,assertVaultAttachment } from "./vault-path";
import {readStoredTasks,updateStoredTasks,type StoredTaskReceipt} from "./task-storage";
import {readStoredCreations,updateStoredCreations,type StoredCreationReceipt} from "./creation-storage";
import {historyToolCards,type ToolCard} from "./tool-calls";
import {searchNotes as searchLocalNotes,type SearchResult} from "./note-search";
import {attachmentPayload,prepareAttachment,validateAttachmentPath,ATTACHMENT_ACCEPT,ATTACHMENT_LIMIT,type Attachment} from "./attachments";
import {discoverLocalServices,probeLocalIdentity,type DiscoveryResult,type DiscoveredService} from "./discovery";

const VIEW = "piora-chat";
interface Settings {address:string;policy:"notes"|"agent";cwd:string;lastSession:string;lastServerId:string;provider:string;modelId:string;thinkingLevel:string;rememberToken:boolean}
const defaults:Settings={address:"http://127.0.0.1:30141/api/remote/v1",policy:"notes",cwd:"",lastSession:"",lastServerId:"",provider:"",modelId:"",thinkingLevel:"",rememberToken:true};
function element<K extends keyof HTMLElementTagNameMap>(parent:HTMLElement,tag:K,text?:string,css?:string):HTMLElementTagNameMap[K] {
  const child=document.createElement(tag);if(text!==undefined)child.textContent=text;if(css)child.className=css;parent.appendChild(child);return child;
}
function button(parent:HTMLElement,label:string,action:()=>unknown):HTMLButtonElement {
  const target=element(parent,"button",label);target.type="button";target.onclick=()=>{void Promise.resolve().then(action).catch(error=>new Notice(error instanceof Error?error.message:"操作失败"));};return target;
}
export class ChatView extends ItemView {
  constructor(leaf: WorkspaceLeaf, readonly plugin: PioraPlugin) { super(leaf); }
  private status!:HTMLElement;
  private messages!:HTMLElement;
  private references!:HTMLElement;
  private picker!:HTMLSelectElement;
  private sendButton!:HTMLButtonElement;
  private stopButton!:HTMLButtonElement;
  private steerButton!:HTMLButtonElement;
  private queueButton!:HTMLButtonElement;
  private tasks!:HTMLElement;
  private retryButton!:HTMLButtonElement;
  private resolveButton!:HTMLButtonElement;
  private input!:HTMLTextAreaElement;
  private signature="";
  private renderGeneration=0;
  private renderer=new Component();
  private update=()=>this.refresh();
  getViewType(): string { return VIEW; }
  getDisplayText(): string { return "Piora"; }
  getIcon():string{return "bot";}
  async onOpen(): Promise<void> {
    this.contentEl.replaceChildren();this.contentEl.classList.add("piora-chat");
    const header=element(this.contentEl,"div",undefined,"piora-toolbar");element(header,"h3","Piora");button(header,"连接",()=>this.plugin.connect());button(header,"设置",()=>this.plugin.openSettings());
    const navigation=element(this.contentEl,"div",undefined,"piora-toolbar");this.picker=element(navigation,"select");this.picker.setAttribute("aria-label","Piora 会话");this.picker.onchange=()=>{void this.plugin.select(this.picker.value).catch(error=>new Notice(String(error)));};
    button(navigation,"新会话",()=>this.plugin.newSession());
    this.status=element(this.contentEl,"div",undefined,"piora-status");this.status.setAttribute("role","status");
    this.tasks=element(this.contentEl,"div",undefined,"piora-tasks");this.tasks.setAttribute("aria-label","任务队列");
    this.messages=element(this.contentEl,"div",undefined,"piora-messages");this.messages.setAttribute("aria-label","聊天历史");
    this.references=element(this.contentEl,"div",undefined,"piora-references");
    this.input=element(this.contentEl,"textarea");this.input.placeholder="输入消息；Ctrl/Cmd + Enter 发送";this.input.setAttribute("aria-label","消息");this.input.value=this.plugin.draft;this.input.oninput=()=>{this.plugin.draft=this.input.value;};
    this.input.onkeydown=event=>{if(event.key==="Enter"&&(event.ctrlKey||event.metaKey)&&!event.isComposing){event.preventDefault();if(!this.sendButton.disabled)this.sendButton.click();}};
    const actions=element(this.contentEl,"div",undefined,"piora-toolbar");button(actions,"当前笔记",()=>this.plugin.addCurrent());button(actions,"选择笔记",()=>new NotePicker(this.plugin).open());button(actions,"检索笔记",()=>this.plugin.openNoteSearch());
    const receiveFiles=(files:File[])=>{void this.plugin.addAttachmentFiles(files).catch(error=>new Notice(error instanceof Error?error.message:"附件读取失败"));};
    const upload=element(actions,"input");upload.type="file";upload.multiple=true;upload.accept=ATTACHMENT_ACCEPT;upload.hidden=true;upload.setAttribute("aria-label","选择本机附件");upload.onchange=()=>{const files=Array.from(upload.files??[]);upload.value="";if(files.length)receiveFiles(files);};
    button(actions,"添加文件",()=>upload.click());button(actions,"Vault 附件",()=>new AttachmentPicker(this.plugin).open());
    this.input.onpaste=event=>{const files=Array.from(event.clipboardData?.files??[]);if(files.length){event.preventDefault();receiveFiles(files);}};
    this.input.ondragover=event=>{if(event.dataTransfer?.types.includes("Files"))event.preventDefault();};
    this.input.ondrop=event=>{const files=Array.from(event.dataTransfer?.files??[]);if(files.length){event.preventDefault();receiveFiles(files);}};
    this.retryButton=button(actions,"重试未确认消息",()=>this.plugin.controller?.retry());
    this.resolveButton=button(actions,"核对后解除锁定",()=>this.plugin.resolveTask());
    this.stopButton=button(actions,"停止",()=>this.plugin.controller?.stop());
    this.sendButton=button(actions,"发送",()=>this.plugin.send());this.sendButton.dataset.action="send";
    this.queueButton=button(actions,"排队下一轮",()=>this.plugin.send(true));
    this.steerButton=button(actions,"引导",()=>this.plugin.steer());
    this.plugin.listeners.add(this.update);this.renderer.load();this.refresh();
  }
  private refresh():void {
    const state=this.plugin.controller?.state;
    if(this.input.value!==this.plugin.draft)this.input.value=this.plugin.draft;
    this.status.textContent=state?.error||(!state?.connected?"未连接：请配置本机 Piora 地址和能力令牌。":(state.control.runtime==="idle"?"已连接 · 就绪":"已连接 · "+state.control.runtime)+(state.control.pendingApproval?" · 请在 Piora 处理待确认输入":""));
    if(state?.connected&&state.selectedId)this.status.textContent+=(state.history.remotePolicy==="notes"?" · 笔记助手（工具禁用）":" · 完整 Agent：可能直接修改文件");
    if(state?.connected&&state.selectedId&&(!state.capabilities?.features?.contentStream||state.capabilities.features.contentStreamIdentity!=="run-sequence-v1"))this.status.textContent+=" · 历史同步（未获可验证的正文流能力）";
    const outstanding=state?.tasks??[];this.tasks.replaceChildren();
    if(state?.creation){
      const row=element(this.tasks,"div","会话创建 · "+(state.creating?"处理中":state.creation.sessionId?"已取得会话，待完成选择":"未确认")+" · "+state.creation.input.policy,"piora-muted");
      const retry=button(row,"重试原会话创建",()=>this.plugin.retryCreation());retry.disabled=!state.connected||state.creating||!this.plugin.controller?.has("session.create");
      const resolve=button(row,"核对创建回执",()=>this.plugin.resolveCreation());resolve.disabled=state.creating;
    }
    if((state?.control.queueLength??0)>0)element(this.tasks,"p","排队："+state!.control.queueLength+" · 停止仅中止当前任务，已排队消息仍会执行。","piora-muted");
    for(const task of outstanding){
      const row=element(this.tasks,"div",(task.delivery==="steer"?"引导":"消息")+" · "+(task.commandId?.slice(0,12)??"等待回执")+" · "+(task.status??"未确认"),"piora-muted");
      if(task.commandId){const cancel=button(row,"取消任务",async()=>{cancel.disabled=true;try{await this.plugin.controller?.cancel(task.commandId!);}finally{cancel.disabled=false;}});cancel.disabled=!state?.connected||!state.capabilities?.features?.commandCancellation||!this.plugin.controller?.has("session.abort");cancel.title="取消这一条命令；不会删除笔记或取消其他排队消息。";}
    }
    this.picker.replaceChildren();element(this.picker,"option","选择会话").value="";
    for(const session of state?.sessions??[])element(this.picker,"option",session.name||session.id).value=session.id;
    this.picker.value=state?.selectedId??"";this.picker.disabled=!state?.connected||Boolean(state?.sending||state?.uncertain||state?.creating);
    this.sendButton.disabled=!state?.connected||!state.selectedId||state.sending||state.uncertain||state.creating||state.control.runtime!=="idle"||!this.plugin.controller?.has("session.message.send");
    this.queueButton.disabled=!state?.connected||!state.selectedId||state.sending||state.uncertain||state.creating||state.control.runtime==="idle"||outstanding.length>=10||!this.plugin.controller?.has("session.message.send")||!this.plugin.controller?.has("session.messages.read");
    this.stopButton.disabled=!state?.connected||!state?.selectedId||!this.plugin.controller?.has("session.abort");
    this.steerButton.disabled=!state?.connected||!state.selectedId||state.sending||state.uncertain||state.creating||state.control.runtime!=="running"||!this.plugin.controller?.has("session.steer");
    if(this.plugin.readingAttachments){this.sendButton.disabled=true;this.queueButton.disabled=true;this.steerButton.disabled=true;this.status.textContent+=" · 正在读取附件";}
    this.retryButton.hidden=!state?.uncertain;this.retryButton.disabled=Boolean(state?.sending);
    this.resolveButton.hidden=!state?.uncertain;
    this.references.replaceChildren();
    for(const note of this.plugin.notes)button(this.references,note.path+" · "+Buffer.byteLength(note.text)+" B ×",()=>{this.plugin.notes=this.plugin.notes.filter(candidate=>candidate!==note);this.plugin.emit();});
    for(const attachment of this.plugin.attachments??[])button(this.references,"附件："+attachment.name+" · "+attachment.bytes+" B ×",()=>{this.plugin.attachments=this.plugin.attachments.filter(candidate=>candidate.id!==attachment.id);this.plugin.emit();});
    const signature=JSON.stringify([state?.selectedId,state?.history,state?.live,state?.tools,state?.toolCalls,state?.omittedToolCalls]);
    if(signature===this.signature)return;this.signature=signature;
    this.renderer.unload();this.renderer=new Component();this.renderer.load();const generation=++this.renderGeneration;
    const nearBottom=this.messages.scrollHeight-this.messages.scrollTop-this.messages.clientHeight<100;
    const expandedTools=new Set(Array.from(this.messages.querySelectorAll<HTMLDetailsElement>(".piora-tool-call details[open]")).map(details=>details.dataset.toolKey));
    this.messages.replaceChildren();
    const liveTools=new Map((state?.toolCalls??[]).map(call=>[call.toolCallId,call]));
    const historyTools=new Map<number,ToolCard[]>();
    for(const call of historyToolCards(state?.history.messages??[])){
      const index=call.messageIndex!;const cards=historyTools.get(index)??[];cards.push(call);historyTools.set(index,cards);
    }
    const renderTool=(call:ToolCard)=>{
      const card=element(this.messages,"article",undefined,"piora-message piora-tool-call");card.dataset.status=call.status;
      element(card,"strong",call.toolName+" · "+({running:"运行中",succeeded:"成功",failed:"失败",unavailable:"未收到结果"}[call.status]));
      const details=element(card,"details");details.dataset.toolKey=JSON.stringify([state?.selectedId,call.toolCallId]);details.open=expandedTools.has(details.dataset.toolKey);
      element(details,"summary","展开工具输出");element(details,"pre",call.output||"暂无文本输出");
      if(call.truncated)element(details,"p","输出已截断（最多 2000 字符）；完整结果请在 Piora 核对。","piora-muted");
    };
    if(!state?.selectedId)element(this.messages,"p","连接后新建或选择会话。笔记助手需要服务端支持受限策略；完整 Agent 可能直接修改文件。","piora-muted");
    for(const [index,message] of (state?.history.messages??[]).entries()){
      for(const call of historyTools.get(index)??[]){
        const live=liveTools.get(call.toolCallId);renderTool(call.status==="unavailable"&&live?live:call);liveTools.delete(call.toolCallId);
      }
      if(message.role==="toolResult")continue;
      const text=messageText(message.content);if(!text)continue;
      const card=element(this.messages,"article",undefined,"piora-message piora-"+message.role.replace(/[^a-z]/gi,""));
      element(card,"strong",message.role==="user"?"你":message.role==="assistant"?"Piora":"工具结果");
      const body=element(card,"div",undefined,"piora-message-body");
      void MarkdownRenderer.render(this.plugin.app,safeMarkdown(text),body,"",this.renderer).then(()=>{if(generation===this.renderGeneration&&nearBottom)this.messages.scrollTop=this.messages.scrollHeight;}).catch(()=>{body.textContent=text;});
      if(message.role==="assistant"){
        const key=replyKey(state!.selectedId!,state!.history,index);
        const actions=element(card,"div",undefined,"piora-toolbar");button(actions,"复制",()=>navigator.clipboard.writeText(text));button(actions,"新建笔记",()=>new CreateNoteModal(this.plugin,text).open());button(actions,"预览替换",()=>this.plugin.review(text,false,key));button(actions,"插入光标处",()=>this.plugin.review(text,true));
      }
    }
    if(state?.live){const live=element(this.messages,"article",undefined,"piora-message");element(live,"strong","Piora · 正在生成");element(live,"pre",state.live);}
    for(const call of liveTools.values())renderTool(call);
    if(state?.omittedToolCalls)element(this.messages,"p","已省略 "+state.omittedToolCalls+" 次工具调用；终态历史同步后可查看结果。","piora-muted");
    if(state?.tools.length&&!state.toolCalls?.length)element(this.messages,"p","工具："+state.tools.join(" → "),"piora-muted");
    if(nearBottom)this.messages.scrollTop=this.messages.scrollHeight;
  }
  async onClose():Promise<void>{this.plugin.listeners.delete(this.update);this.renderer.unload();this.renderGeneration++;if(this.plugin.listeners.size===0)this.plugin.controller?.disconnect();}
}

class ReviewModal extends Modal {
  constructor(private plugin:PioraPlugin,private note:NoteContext,private replacement:string){super(plugin.app);}
  onOpen():void {
    this.setTitle("确认修改："+this.note.path);
    element(this.contentEl,"p","只在确认后写入；若笔记已变化，会拒绝覆盖。");
    const preview=element(this.contentEl,"pre",undefined,"piora-diff");
    for(const change of diffLines(this.note.text,this.replacement))element(preview,"span",change.value,change.added?"piora-added":change.removed?"piora-removed":"");
    button(this.contentEl,"取消",()=>this.close());const confirm=button(this.contentEl,"确认写入",async()=>{confirm.disabled=true;try{await this.plugin.apply(this.note,this.replacement);this.close();new Notice("笔记已更新");}catch(error){confirm.disabled=false;throw error;}});
  }
}
class CreateNoteModal extends Modal {
  constructor(private plugin:PioraPlugin,private text:string){super(plugin.app);}
  onOpen():void {
    this.setTitle("将回复保存为新笔记");const input=element(this.contentEl,"input");input.value="Piora-"+Date.now()+".md";input.setAttribute("aria-label","新笔记路径");
    element(this.contentEl,"p","使用 Vault 内已存在的文件夹，不覆盖现有文件。");
    const confirm=button(this.contentEl,"确认创建",async()=>{confirm.disabled=true;try{const path=validateNotePath(input.value.trim());assertVaultTarget(this.plugin.vaultPath(),path,true);if(this.app.vault.getAbstractFileByPath(path))throw new Error("目标已存在，不会覆盖");const file=await this.app.vault.create(path,this.text);this.close();await this.app.workspace.getLeaf(false).openFile(file);}catch(error){confirm.disabled=false;throw error;}});button(this.contentEl,"取消",()=>this.close());
  }
}
class NotePicker extends FuzzySuggestModal<TFile> {
  constructor(private plugin:PioraPlugin){super(plugin.app);this.setPlaceholder("选择要引用的笔记");}
  getItems():TFile[]{return this.app.vault.getMarkdownFiles().filter(file=>{try{validateNotePath(file.path);return true;}catch{return false;}});}
  getItemText(file:TFile):string{return file.path;}
  onChooseItem(file:TFile):void{void this.plugin.addNote(file).catch(error=>new Notice(String(error)));}
}
class AttachmentPicker extends FuzzySuggestModal<TFile> {
  constructor(private plugin:PioraPlugin){super(plugin.app);this.setPlaceholder("选择图片或 UTF-8 文本附件（单个最多 128 KiB）");}
  getItems():TFile[]{return this.app.vault.getFiles().filter(file=>{try{validateAttachmentPath(file.path);return file.stat.size<=ATTACHMENT_LIMIT;}catch{return false;}});}
  getItemText(file:TFile):string{return file.path;}
  onChooseItem(file:TFile):void{void this.plugin.addVaultAttachment(file).catch(error=>new Notice(error instanceof Error?error.message:"附件读取失败"));}
}
class NoteSearchModal extends Modal {
  private search?:AbortController;
  constructor(private plugin:PioraPlugin,private closed:()=>void){super(plugin.app);}
  onOpen():void {
    this.setTitle("本地检索笔记");this.contentEl.classList.add("piora-note-search");
    element(this.contentEl,"p","只在本地检索，不调用模型、不发送笔记。逐项加入引用后，发送消息才会传给 Piora；加入时重新读取当前内容。","piora-muted");
    const query=element(this.contentEl,"input");query.setAttribute("aria-label","检索词");query.placeholder="关键词，以空格分隔（全部匹配）";query.maxLength=200;
    const folder=element(this.contentEl,"input");folder.setAttribute("aria-label","检索文件夹");folder.placeholder="可选：Vault 内文件夹；留空检索整个 Vault";
    const actions=element(this.contentEl,"div",undefined,"piora-toolbar");const status=element(this.contentEl,"p",undefined,"piora-muted");status.setAttribute("role","status");
    const results=element(this.contentEl,"div",undefined,"piora-search-results");
    const submit=button(actions,"本地检索",async()=>{
      this.search?.abort();const search=new AbortController();this.search=search;results.replaceChildren();status.textContent="正在本地检索…";
      try{
        const result=await this.plugin.searchNotes(query.value,folder.value,search.signal);if(search.signal.aborted)return;
        status.textContent="已读取 "+result.scanned+" 篇，显示 "+result.hits.length+" 条；跳过 "+result.skipped+" 篇。"+(result.limited?"已达检索/结果限额，请缩小文件夹或增加关键词。":"");
        for(const hit of result.hits){
          const card=element(results,"article",undefined,"piora-message");element(card,"strong",hit.path);element(card,"pre",hit.snippet);
          const add=button(card,"加入引用",async()=>{const file=this.app.vault.getAbstractFileByPath(hit.path);if(!(file instanceof TFile))throw new Error("笔记已移动或删除，请重新检索");await this.plugin.addNote(file);add.disabled=true;add.textContent="已加入引用";});
        }
      }catch(error){if(!search.signal.aborted)status.textContent=error instanceof Error?error.message:"本地检索失败";}
    });
    query.onkeydown=event=>{if(event.key==="Enter"&&!event.isComposing){event.preventDefault();submit.click();}};
    button(actions,"关闭",()=>this.close());
  }
  onClose():void {this.search?.abort();this.contentEl.replaceChildren();this.closed();}
}
class DiscoveryModal extends Modal {
  private scan?:AbortController;
  private confirmation?:Modal;
  constructor(private plugin:PioraPlugin,private closed:()=>void){super(plugin.app);}
  onOpen():void {
    this.setTitle("发现本机 Piora");element(this.contentEl,"p","只读取当前用户的服务登记并匿名核验；不扫描端口、不读取或发送令牌。选择实例后仍需手动连接。","piora-muted");
    const status=element(this.contentEl,"p");status.setAttribute("role","status");const results=element(this.contentEl,"div");
    const refresh=async()=>{
      this.scan?.abort();this.confirmation?.close();const scan=new AbortController();this.scan=scan;results.replaceChildren();status.textContent="正在读取登记并匿名核验…";
      try{
        const result=await this.plugin.discoverServices(scan.signal);if(scan.signal.aborted)return;
        status.textContent="来源："+result.source+"；可用 "+result.services.length+" 个，跳过 "+result.skipped+" 条。"+(result.limited?"已达发现限额，可改用手动地址。":"")+(!result.services.length?"服务需更新后重新启动以登记；也可手动填写地址。":"");
        for(const service of result.services){const card=element(results,"article",undefined,"piora-message");element(card,"strong",service.address);element(card,"p","服务 ID："+service.serverId);button(card,"选择此实例",()=>{
          this.confirmation?.close();const modal=new Modal(this.app);this.confirmation=modal;modal.setTitle("确认选择本机实例");element(modal.contentEl,"p",service.address+" · "+service.serverId);
          element(modal.contentEl,"p","请与 Piora 设置显示的 ID 核对。登记和 ID 不是密码学认证；确认只保存地址/身份，不搬迁旧地址令牌、任务或会话选择。之后仍需手动连接。旧数据保留。");
          button(modal.contentEl,"取消",()=>modal.close());const confirm=button(modal.contentEl,"确认选择",async()=>{confirm.disabled=true;try{await this.plugin.chooseDiscoveredService(service);modal.close();this.close();new Notice("地址与身份已选择，请在设置中提供此地址的令牌并手动连接");}catch(error){confirm.disabled=false;throw error;}});modal.open();
        });}
      }catch(error){if(!scan.signal.aborted)status.textContent=error instanceof Error?error.message:"本机发现失败，请使用手动地址";}
    };
    button(this.contentEl,"刷新发现",refresh);button(this.contentEl,"关闭",()=>this.close());void refresh();
  }
  onClose():void{this.scan?.abort();this.confirmation?.close();this.contentEl.replaceChildren();this.closed();}
}
class PioraSettingsTab extends PluginSettingTab {
  constructor(private plugin:PioraPlugin){super(plugin.app,plugin);}
  display():void {
    this.containerEl.replaceChildren();element(this.containerEl,"h2","Piora 连接");
    new Setting(this.containerEl).setName("本机服务发现").setDesc("读取本用户目录登记，再匿名核验身份；不扫描端口或迁移令牌。").addButton(control=>control.setButtonText("发现本机 Piora").onClick(()=>this.plugin.openDiscovery()));
    new Setting(this.containerEl).setName("本机服务地址").setDesc("从 Piora → 设置 → 远程控制复制；地址变化后需重新提供令牌。").addText(text=>text.setValue(this.plugin.settings.address).onChange(value=>{this.plugin.settings.address=value;this.plugin.controller?.disconnect();void this.plugin.persist();}));
    new Setting(this.containerEl).setName("能力令牌").setDesc("不显示已保存令牌，不写入插件普通配置。").addText(text=>{text.inputEl.type="password";text.setPlaceholder("输入或更新令牌").onChange(value=>this.plugin.setToken(value));});
    new Setting(this.containerEl).setName("使用宿主秘密存储").setDesc("关闭时清空当前连接的宿主保存值，保留本次内存令牌；不会修改其他连接。").addToggle(toggle=>toggle.setValue(this.plugin.settings.rememberToken).onChange(async value=>{try{await this.plugin.setRememberToken(value);}catch(error){new Notice(error instanceof Error?error.message:"凭证设置失败");}this.display();}));
    new Setting(this.containerEl).setName("清空当前连接凭证").setDesc("清空本机保存值与内存并断开连接；不会撤销 Piora 令牌或停止后台任务。").addButton(control=>control.setButtonText("忘记令牌").onClick(()=>{try{this.plugin.forgetToken();this.display();}catch(error){new Notice(error instanceof Error?error.message:"清空凭证失败");}}));
    new Setting(this.containerEl).setName("服务实例绑定").setDesc(this.plugin.boundServerId()+"；首次连接信任手动填写的地址，ID 不是密码或服务端身份证书。").addButton(control=>control.setButtonText("更换实例绑定").onClick(()=>this.plugin.changeServerBinding()));
    new Setting(this.containerEl).setName("新会话模式").addDropdown(dropdown=>dropdown.addOption("notes","笔记助手（工具禁用）").addOption("agent","完整 Agent（可直接修改文件）").setValue(this.plugin.settings.policy).onChange(async value=>{this.plugin.settings.policy=value==="agent"?"agent":"notes";await this.plugin.persist();}));
    new Setting(this.containerEl).setName("工作目录").setDesc("留空使用当前 Vault。工作目录不是安全沙箱。").addText(text=>text.setValue(this.plugin.settings.cwd).onChange(async value=>{this.plugin.settings.cwd=value;await this.plugin.persist();}));
    if(this.plugin.controller?.models.length)new Setting(this.containerEl).setName("新会话模型").setDesc("目录只包含核心配置；仅在新建会话时生效。").addDropdown(dropdown=>{dropdown.addOption("","Piora 默认模型");for(const model of this.plugin.controller!.models)dropdown.addOption(JSON.stringify([model.provider,model.id]),model.provider+" / "+(model.name||model.id));dropdown.setValue(this.plugin.settings.provider?JSON.stringify([this.plugin.settings.provider,this.plugin.settings.modelId]):"").onChange(async value=>{const pair=value?JSON.parse(value) as string[]:["",""];this.plugin.settings.provider=pair[0];this.plugin.settings.modelId=pair[1];await this.plugin.persist();this.display();});});
    for(const [key,label] of [["provider","模型提供商（留空使用默认）"],["modelId","模型 ID（与提供商同时填写）"],["thinkingLevel","思考级别（留空使用默认）"]] as const)new Setting(this.containerEl).setName(label).addText(text=>text.setValue(this.plugin.settings[key]).onChange(async value=>{this.plugin.settings[key]=value;await this.plugin.persist();}));
    new Setting(this.containerEl).setName("连接测试").addButton(control=>control.setButtonText("连接 Piora").onClick(()=>{void this.plugin.connect().then(()=>{new Notice("Piora 已连接");this.display();}).catch(error=>new Notice(String(error)));}));
  }
}
export default class PioraPlugin extends Plugin {
  settings:Settings={...defaults};controller?:SessionController;notes:NoteContext[]=[];draft="";listeners=new Set<()=>void>();
  private credentials=new Credentials(()=>this.app.secretStorage);private lastEditor?:{editor:Editor;file:TFile};private replyContexts=new ReplyContexts();
  private saveQueue:Promise<void>=Promise.resolve();
  private tasks:StoredTaskReceipt[]=[];private clientAddress="";
  private creations:StoredCreationReceipt[]=[];
  private searchModals=new Set<Modal>();
  private discoveryModals=new Set<Modal>();
  attachments:Attachment[]=[];readingAttachments=false;private attachmentEpoch=0;
  private serverBindings:Record<string,string>={};private clientServerId="";private connecting=false;private connectionEpoch=0;
  async onload():Promise<void>{
    const saved:unknown=await this.loadData();if(saved&&typeof saved==="object")for(const key of Object.keys(defaults) as Array<keyof Settings>){const value=(saved as Record<string,unknown>)[key];if(typeof value===typeof defaults[key])Object.assign(this.settings,{[key]:value});}
    if(!["notes","agent"].includes(this.settings.policy))this.settings.policy="notes";
    const bindings=(saved as {serverBindings?:unknown}|null)?.serverBindings;
    if(bindings!==undefined){
      if(!bindings||typeof bindings!=="object"||Array.isArray(bindings))throw new Error("服务实例绑定记录无效，请先备份配置并核对");
      for(const [address,serverId] of Object.entries(bindings)){const normalized=normalizeAddress(address);if(!isServerId(serverId)||this.serverBindings[normalized]&&this.serverBindings[normalized]!==serverId)throw new Error("服务实例绑定记录无效，请先备份配置并核对");this.serverBindings[normalized]=serverId;}
    }
    this.tasks=readStoredTasks(saved);
    this.creations=readStoredCreations(saved);
    this.registerView(VIEW,leaf=>new ChatView(leaf,this));this.addSettingTab(new PioraSettingsTab(this));
    this.addRibbonIcon("bot","打开 Piora",()=>{void this.open();});this.addCommand({id:"open-chat",name:"打开聊天侧栏",callback:()=>{void this.open();}});
    this.addCommand({id:"new-session",name:"新建会话",callback:()=>{void this.newSession().catch(error=>new Notice(error instanceof Error?error.message:"新建会话失败"));}});
    this.addCommand({id:"search-notes",name:"本地检索并引用笔记",callback:()=>this.openNoteSearch()});
    this.addCommand({id:"reference-note",name:"引用当前笔记",editorCallback:(editor,view)=>{if(view.file){this.capture(editor,view.file,false);void this.open();}}});
    this.addCommand({id:"reference-selection",name:"引用选中文字",editorCallback:(editor,view)=>{if(view.file){this.capture(editor,view.file,true);void this.open();}}});
    this.registerEvent(this.app.workspace.on("editor-menu",(menu,editor,view)=>{if(!view.file)return;const file=view.file;for(const [label,prompt] of [["解释选区","解释选中的内容"],["总结选区","总结选中的内容"],["改写选区","改写选中的内容，仅返回建议正文"]])menu.addItem(item=>item.setTitle("Piora："+label).setIcon("bot").onClick(()=>{this.capture(editor,file,true);this.draft=prompt;void this.open();}));}));
    const rememberEditor=()=>{const view=this.app.workspace.getActiveViewOfType(MarkdownView);if(view?.file)this.lastEditor={editor:view.editor,file:view.file};};
    this.registerEvent(this.app.workspace.on("active-leaf-change",rememberEditor));rememberEditor();
  }
  vaultPath():string{const adapter=this.app.vault.adapter;if(!(adapter instanceof FileSystemAdapter))throw new Error("仅支持桌面文件 Vault");return adapter.getBasePath();}
  setToken(value:string):void{try{this.credentials.set(this.settings.address,this.vaultPath(),value,this.settings.rememberToken);}catch{new Notice("请先填写有效的本机地址");}}
  async setRememberToken(value:boolean):Promise<void>{const available=this.credentials.setRemembered(this.settings.address,this.vaultPath(),value);this.settings.rememberToken=value;await this.persist();if(!available)new Notice("宿主未提供秘密存储，仅使用内存；无法核实历史保存值，请在宿主中检查。");}
  forgetToken():void{const available=this.credentials.forget(this.settings.address,this.vaultPath());this.controller?.disconnect();new Notice(available?"当前连接的保存值和内存令牌已清空；Piora 端令牌未撤销。":"内存令牌已清空；宿主未提供秘密存储，无法核实历史保存值。");}
  boundServerId():string {try{return this.serverBindings[normalizeAddress(this.settings.address)]??"尚未绑定";}catch{return "地址无效";}}
  changeServerBinding():void {
    const address=normalizeAddress(this.settings.address);const modal=new Modal(this.app);modal.setTitle("更换 Piora 实例？");
    element(modal.contentEl,"p",address+" · "+this.boundServerId());
    element(modal.contentEl,"p","请先在原 Piora 核对任务。确认将断开连接、清空此地址的凭证并关闭凭证记忆；旧回执仍保留，不会迁移到新实例。之后重新输入新实例令牌并连接。此操作不撤销服务端令牌，也不停止任务。");
    button(modal.contentEl,"取消",()=>modal.close());const confirm=button(modal.contentEl,"确认清除绑定和凭证",async()=>{
      if(this.connecting||this.controller?.state.sending||this.controller?.state.uncertain||this.controller?.state.creation)throw new Error("请先等待连接结束并核对未确认任务和创建回执，再更换实例");
      if(normalizeAddress(this.settings.address)!==address)throw new Error("地址已变化，请重新确认");
      confirm.disabled=true;
      try{
        this.connectionEpoch++;this.controller?.disconnect();this.credentials.forget(address,this.vaultPath());
        this.settings.rememberToken=false;const bindings={...this.serverBindings};delete bindings[address];
        await this.persist(bindings);this.serverBindings=bindings;this.controller=undefined;this.clientAddress="";this.clientServerId="";this.replyContexts.clear();this.emit();modal.close();new Notice("实例绑定已清除，请重新输入此实例的令牌；旧任务回执仍保留");
      }catch(error){confirm.disabled=false;throw error;}
    });modal.open();
  }
  persist(bindings?:Record<string,string>,creations?:StoredCreationReceipt[],settings?:Settings):Promise<void>{this.saveQueue=this.saveQueue.catch(()=>{}).then(()=>this.saveData({...settings??this.settings,serverBindings:bindings??this.serverBindings,tasks:this.tasks.map(task=>({...task})),creations:readStoredCreations({creations:creations??this.creations})}));return this.saveQueue;}
  discoverServices(signal?:AbortSignal):Promise<DiscoveryResult>{return discoverLocalServices({signal});}
  openDiscovery():void{const modal=new DiscoveryModal(this,()=>this.discoveryModals.delete(modal));this.discoveryModals.add(modal);modal.open();}
  async chooseDiscoveredService(service:DiscoveredService):Promise<void>{
    const address=normalizeAddress(service.address);const before=this.settings.address;
    if(!isServerId(service.serverId)||!Number.isFinite(service.expiresAt)||service.expiresAt<=Date.now()||service.expiresAt>Date.now()+100000)throw new Error("登记已失效，请重新发现并核对身份");
    if(this.connecting||this.controller?.state.sending||this.controller?.state.uncertain||this.controller?.state.creation)throw new Error("请先核对当前连接的未确认任务或会话创建");
    if(this.serverBindings[address]&&this.serverBindings[address]!==service.serverId)throw new Error("此地址的实例身份已变化，请先通过更换实例绑定流程核对，不能自动覆盖");
    const epoch=++this.connectionEpoch;this.connecting=true;this.controller?.disconnect();
    try{
      if(await probeLocalIdentity(address)!==service.serverId)throw new Error("实例身份已变化，请重新发现");
      if(epoch!==this.connectionEpoch||before!==this.settings.address||service.expiresAt<=Date.now())throw new Error("连接状态或登记已变化，请重新选择");
      const bindings={...this.serverBindings,[address]:service.serverId};const settings={...this.settings,address,lastSession:"",lastServerId:""};await this.persist(bindings,undefined,settings);
      if(epoch!==this.connectionEpoch||before!==this.settings.address)throw new Error("连接状态已变化，请重新核对设置");
      this.serverBindings=bindings;this.settings=settings;this.controller=undefined;this.clientAddress="";this.clientServerId="";this.replyContexts.clear();this.emit();
    }finally{this.connecting=false;}
  }
  emit():void{const state=this.controller?.state;if(state?.selectedId)this.replyContexts.observe(state.selectedId,state.history);for(const listener of this.listeners)listener();}
  async connect():Promise<void>{
    if(this.connecting)throw new Error("正在连接 Piora，请稍候");
    if(this.controller?.state.creating)throw new Error("请等待会话创建请求结束后再连接");
    const address=normalizeAddress(this.settings.address);
    if((this.controller?.state.uncertain||this.controller?.state.sending||this.controller?.state.creation)&&this.clientAddress!==address)throw new Error("请先在原服务核对未确认任务和会话创建，再切换地址");
    this.controller?.disconnect();this.settings.address=address;
    const epoch=++this.connectionEpoch;this.connecting=true;
    try{
      const vault=this.vaultPath();const client=new RemoteClient(address,()=>this.credentials.get(address,vault,this.settings.rememberToken));const serverId=await client.identify();
      if(epoch!==this.connectionEpoch||normalizeAddress(this.settings.address)!==address)return;
      const expected=this.serverBindings[address];if(expected&&expected!==serverId)throw new Error("Piora 服务实例已变化；未发送令牌。请核对原任务后在设置中更换实例绑定");
      if(!expected){const bindings={...this.serverBindings,[address]:serverId};await this.persist(bindings);this.serverBindings=bindings;}
      if(epoch!==this.connectionEpoch||normalizeAddress(this.settings.address)!==address)return;
      client.pinServer(serverId);
      if(!this.controller||this.clientAddress!==address||this.clientServerId!==serverId){this.replyContexts.clear();this.controller=new SessionController(client,()=>this.emit(),async(task,key)=>{this.tasks=updateStoredTasks(this.tasks,address,task,key,serverId);await this.persist();},async receipt=>{const records=updateStoredCreations(this.creations,address,serverId,receipt);await this.persist(undefined,records);this.creations=records;});this.clientAddress=address;this.clientServerId=serverId;}
      await this.controller.connect();if(epoch!==this.connectionEpoch||normalizeAddress(this.settings.address)!==address){this.controller.disconnect();return;}
      const tasks=this.tasks.filter(task=>task.address===address&&task.serverId===serverId);for(const task of tasks)this.controller.restoreTask(task);
      const creation=this.creations.find(record=>record.address===address&&record.serverId===serverId);if(creation)this.controller.restoreCreation(creation);
      if(this.tasks.some(task=>task.address===address&&task.serverId!==serverId))new Notice("其他或未知实例的任务回执已保留，不会自动恢复；请在原 Piora 核对");
      const target=tasks.find(task=>!task.commandId)?.sessionId||(this.settings.lastServerId===serverId?this.settings.lastSession:"")||tasks[0]?.sessionId;
      if(target&&!this.controller.state.sending&&!this.controller.state.uncertain&&this.controller.state.sessions.some(session=>session.id===target))await this.controller.select(target);
      await this.persist();
    }catch(error){if(this.controller)this.controller.state.error=error instanceof Error?error.message:"连接失败";this.emit();throw error;}finally{this.connecting=false;}
  }
  resolveTask():void {const modal=new Modal(this.app);modal.setTitle("确认已核对任务？");element(modal.contentEl,"p","解除锁定不会停止已经执行的任务。请先在 Piora 核对，避免重复执行；重启前的消息正文不会自动重发。");button(modal.contentEl,"取消",()=>modal.close());button(modal.contentEl,"已核对，解除锁定",async()=>{await this.controller?.forgetTask();modal.close();});modal.open();}
  async select(id:string):Promise<void>{if(!this.controller||!id)return;if(this.controller.state.creating)throw new Error("请等待会话创建完成");await this.controller.select(id);this.settings.lastSession=id;this.settings.lastServerId=this.clientServerId;await this.persist();}
  private async finishCreation(id:string,controller:SessionController):Promise<void>{
    if(controller!==this.controller||this.clientAddress&&normalizeAddress(this.settings.address)!==this.clientAddress)throw new Error("会话已创建但连接已变化，请回原实例恢复创建回执");
    this.settings.lastSession=id;this.settings.lastServerId=this.clientServerId;await this.persist();await controller.clearCreation();
  }
  async retryCreation():Promise<void>{
    const controller=this.controller;const receipt=controller?.state.creation;if(!controller||!receipt)throw new Error("没有可恢复的会话创建");
    const retry=async()=>{if(this.controller!==controller||controller.state.creation?.key!==receipt.key)throw new Error("创建回执已变化，请重新核对");await this.finishCreation(await controller.retryCreation(),controller);};
    if(receipt.input.policy==="agent"){const modal=new Modal(this.app);modal.setTitle("恢复完整 Agent 创建？");element(modal.contentEl,"p","将使用原参数和原幂等键继续创建；完整 Agent 可能直接修改本机文件，不经过笔记预览。");button(modal.contentEl,"取消",()=>modal.close());button(modal.contentEl,"确认恢复创建",async()=>{modal.close();await retry();});modal.open();}else await retry();
  }
  resolveCreation():void{
    const controller=this.controller;if(!controller?.state.creation)return;const key=controller.state.creation.key;const modal=new Modal(this.app);modal.setTitle("核对会话创建回执");
    element(modal.contentEl,"p","请先在原 Piora 核对是否已创建会话。清除只移除本地回执，不删除会话、不取消请求；再次新建可能产生另一会话。原请求应优先使用重试入口。");
    button(modal.contentEl,"取消",()=>modal.close());button(modal.contentEl,"已核对，清除创建回执",async()=>{if(controller.state.creation?.key!==key)throw new Error("创建回执已变化，请重新核对");await controller.clearCreation();modal.close();});modal.open();
  }
  async newSession():Promise<void>{
    if(!this.controller?.state.connected)await this.connect();
    const create=async()=>{const controller=this.controller!;const settings=this.settings;if(Boolean(settings.provider)!==Boolean(settings.modelId))throw new Error("模型提供商和模型 ID 必须同时填写");const id=await controller.create({cwd:settings.cwd||this.vaultPath(),policy:settings.policy,name:"Obsidian · "+this.app.vault.getName(),...(settings.provider?{provider:settings.provider,modelId:settings.modelId}:{}),...(settings.thinkingLevel?{thinkingLevel:settings.thinkingLevel}:{})});await this.finishCreation(id,controller);};
    if(this.settings.policy==="agent"){const modal=new Modal(this.app);modal.setTitle("启用完整 Agent？");element(modal.contentEl,"p","Agent 工具可能直接修改本机文件，不经过插件预览。只用于可信任务，并确保已有备份。");button(modal.contentEl,"取消",()=>modal.close());button(modal.contentEl,"确认创建",async()=>{modal.close();await create();});modal.open();}else await create();
  }
  async open():Promise<void>{let leaf=this.app.workspace.getLeavesOfType(VIEW)[0];if(!leaf){leaf=this.app.workspace.getRightLeaf(false)!;if(!leaf)throw new Error("无法打开侧栏");await leaf.setViewState({type:VIEW,active:true});}await this.app.workspace.revealLeaf(leaf);this.emit();}
  openSettings():void {const modal=new Modal(this.app);modal.setTitle("Piora 设置");const settings=new PioraSettingsTab(this);settings.containerEl=modal.contentEl;settings.display();modal.open();}
  openNoteSearch():void {const modal=new NoteSearchModal(this,()=>this.searchModals.delete(modal));this.searchModals.add(modal);modal.open();}
  async searchNotes(query:string,folder="",signal?:AbortSignal):Promise<SearchResult>{
    const root=this.vaultPath();const files=this.app.vault.getMarkdownFiles();const byPath=new Map(files.map(file=>[file.path,file]));
    const editors=new Map(this.app.workspace.getLeavesOfType("markdown").map(leaf=>leaf.view).filter((view):view is MarkdownView=>view instanceof MarkdownView&&Boolean(view.file)).map(view=>[view.file!.path,view.editor]));
    return searchLocalNotes({files:files.map(file=>({path:file.path,bytes:editors.has(file.path)?Buffer.byteLength(editors.get(file.path)!.getValue()):file.stat.size})),read:async path=>{
      assertVaultTarget(root,path);const file=byPath.get(path);if(!file||file.path!==path)throw new Error("笔记已变化");
      const editor=editors.get(path);const text=editor?editor.getValue():await this.app.vault.read(file);assertVaultTarget(root,path);return text;
    }},query,{folder,signal});
  }
  capture(editor:Editor,file:TFile,selection:boolean):void{
    assertVaultTarget(this.vaultPath(),file.path);const original=editor.getValue();const from=selection?editor.posToOffset(editor.getCursor("from")):0;const to=selection?editor.posToOffset(editor.getCursor("to")):original.length;
    if(selection&&from===to)throw new Error("请先选中文字");this.lastEditor={editor,file};const note={path:file.path,original,text:original.slice(from,to),from,to};this.notes=[...this.notes.filter(item=>item.path!==file.path),note];this.emit();
  }
  async addCurrent():Promise<void>{const view=this.app.workspace.getActiveViewOfType(MarkdownView);const current=view?.file?{editor:view.editor,file:view.file}:this.lastEditor;if(!current)throw new Error("请先打开笔记");this.capture(current.editor,current.file,false);}
  async addNote(file:TFile):Promise<void>{assertVaultTarget(this.vaultPath(),file.path);const open=this.app.workspace.getLeavesOfType("markdown").map(leaf=>leaf.view).find(view=>view instanceof MarkdownView&&view.file?.path===file.path);if(open instanceof MarkdownView){this.capture(open.editor,file,false);return;}const text=await this.app.vault.read(file);this.notes=[...this.notes.filter(note=>note.path!==file.path),{path:file.path,text,original:text}];this.emit();}
  async addAttachmentFiles(files:readonly File[]):Promise<void>{await this.importAttachments(files.map(file=>({name:file.name,size:file.size,read:()=>file.arrayBuffer()})));}
  async addVaultAttachment(file:TFile):Promise<void>{
    const root=this.vaultPath();const path=file.path;assertVaultAttachment(root,path);
    const editor=this.app.workspace.getLeavesOfType("markdown").map(leaf=>leaf.view).find(view=>view instanceof MarkdownView&&view.file?.path===path);
    await this.importAttachments([{name:path.split("/").at(-1)!,size:editor instanceof MarkdownView?Buffer.byteLength(editor.editor.getValue()):file.stat.size,read:async()=>{
      assertVaultAttachment(root,path);if(file.path!==path)throw new Error("附件已移动，请重新选择");
      const bytes=editor instanceof MarkdownView?new TextEncoder().encode(editor.editor.getValue()).buffer:await this.app.vault.readBinary(file);assertVaultAttachment(root,path);return bytes;
    }}]);
  }
  private async importAttachments(files:Array<{name:string;size:number;read:()=>Promise<ArrayBuffer>}>):Promise<void>{
    if(this.readingAttachments)throw new Error("请等待附件读取完成");if(this.attachments.length+files.length>8)throw new Error("每条消息最多 8 个附件");
    for(const file of files){validateAttachmentPath(file.name);if(!Number.isSafeInteger(file.size)||file.size<0||file.size>ATTACHMENT_LIMIT)throw new Error("单个附件超过 128 KiB，请先缩小图片或精简文本");}
    const epoch=this.attachmentEpoch;this.readingAttachments=true;this.emit();
    try{const prepared:Attachment[]=[];for(const file of files){const bytes=await file.read();if(epoch!==this.attachmentEpoch)throw new Error("插件已卸载，附件读取已取消");prepared.push(prepareAttachment(file.name,new Uint8Array(bytes)));}this.attachments=[...this.attachments,...prepared];}
    finally{this.readingAttachments=false;if(epoch===this.attachmentEpoch)this.emit();}
  }
  async send(queued=false):Promise<void>{await this.deliverComposer(queued?"enqueue":"send");}
  async steer():Promise<void>{await this.deliverComposer("steer");}
  private async deliverComposer(mode:"send"|"enqueue"|"steer"):Promise<void>{
    const controller=this.controller;if(!controller?.state.selectedId)throw new Error("请先连接并选择会话");if(this.readingAttachments)throw new Error("请等待附件读取完成");if(controller.state.sending||controller.state.uncertain)throw new Error("请先处理未确认投递");
    const draft=this.draft;const notes=[...this.notes];const attachments=[...this.attachments];const {content,images}=attachmentPayload(draft,notes,attachments);const binding=this.replyContexts.begin(controller.state.selectedId,content,notes,controller.state.history);
    try{const deliver=controller[mode].bind(controller);if(images?.length)await deliver(content,images);else await deliver(content);}catch(error){if(!controller.state.uncertain)this.replyContexts.cancel(binding);throw error;}
    if(this.draft===draft)this.draft="";this.notes=this.notes.filter(note=>!notes.includes(note));this.attachments=this.attachments.filter(attachment=>!attachments.includes(attachment));this.emit();
  }
  review(text:string,insert=false,key?:string):void{
    const current=this.lastEditor;if(!current)throw new Error("请先打开目标笔记");let note:NoteContext;
    if(insert){const original=current.editor.getValue();const from=current.editor.posToOffset(current.editor.getCursor());note={path:current.file.path,original,text:"",from,to:from};}
    else {const snapshot=key?this.replyContexts.get(key,current.file.path):undefined;if(!snapshot)throw new Error("此回复没有目标笔记的原始快照，请重新引用生成或使用插入功能");note=snapshot;}
    new ReviewModal(this,note,text).open();
  }
  async apply(note:NoteContext,replacement:string):Promise<void>{
    assertVaultTarget(this.vaultPath(),note.path);
    const file=this.app.vault.getAbstractFileByPath(validateNotePath(note.path));if(!(file instanceof TFile))throw new Error("目标笔记已移动或删除");
    const open=this.app.workspace.getLeavesOfType("markdown").map(leaf=>leaf.view).filter(view=>view instanceof MarkdownView&&view.file?.path===note.path) as MarkdownView[];
    if(open.length){for(const view of open)applyReplacement(view.editor.getValue(),note,replacement);const editor=open[0].editor;const from=note.from??0;const to=note.to??note.original.length;editor.replaceRange(replacement,editor.offsetToPos(from),editor.offsetToPos(to));}
    else await this.app.vault.process(file,current=>applyReplacement(current,note,replacement));
  }
  onunload():void{this.connectionEpoch++;this.attachmentEpoch++;this.attachments=[];for(const modal of this.searchModals)modal.close();for(const modal of this.discoveryModals)modal.close();this.controller?.disconnect();this.listeners.clear();this.credentials.clear();this.notes=[];this.replyContexts.clear();}
}
