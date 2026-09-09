import { Component, FileSystemAdapter, FuzzySuggestModal, ItemView, MarkdownRenderer, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, WorkspaceLeaf, type Editor } from "obsidian";
import { diffLines } from "diff";
import { RemoteClient } from "./client";
import { SessionController, type TaskReceipt } from "./session";
import { applyReplacement, buildPrompt, normalizeAddress, validateNotePath, type NoteContext } from "./core";
import { messageText, safeMarkdown } from "./presentation";
import { Credentials } from "./credentials";
import { ReplyContexts, replyKey } from "./reply-contexts";
import { assertVaultTarget } from "./vault-path";

const VIEW = "piora-chat";
interface Settings {address:string;policy:"notes"|"agent";cwd:string;lastSession:string;provider:string;modelId:string;thinkingLevel:string;rememberToken:boolean}
const defaults:Settings={address:"http://127.0.0.1:30141/api/remote/v1",policy:"notes",cwd:"",lastSession:"",provider:"",modelId:"",thinkingLevel:"",rememberToken:true};
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
    this.messages=element(this.contentEl,"div",undefined,"piora-messages");this.messages.setAttribute("aria-label","聊天历史");
    this.references=element(this.contentEl,"div",undefined,"piora-references");
    this.input=element(this.contentEl,"textarea");this.input.placeholder="输入消息；Ctrl/Cmd + Enter 发送";this.input.setAttribute("aria-label","消息");this.input.value=this.plugin.draft;this.input.oninput=()=>{this.plugin.draft=this.input.value;};
    this.input.onkeydown=event=>{if(event.key==="Enter"&&(event.ctrlKey||event.metaKey)&&!event.isComposing){event.preventDefault();if(!this.sendButton.disabled)this.sendButton.click();}};
    const actions=element(this.contentEl,"div",undefined,"piora-toolbar");button(actions,"当前笔记",()=>this.plugin.addCurrent());button(actions,"选择笔记",()=>new NotePicker(this.plugin).open());
    this.retryButton=button(actions,"重试未确认消息",()=>this.plugin.controller?.retry());
    this.resolveButton=button(actions,"核对后解除锁定",()=>this.plugin.resolveTask());
    this.stopButton=button(actions,"停止",()=>this.plugin.controller?.stop());
    this.sendButton=button(actions,"发送",async()=>{await this.plugin.send();this.input.value=this.plugin.draft;});this.sendButton.dataset.action="send";
    button(actions,"引导",async()=>{await this.plugin.controller?.steer(this.input.value);this.plugin.draft="";this.input.value="";});
    this.plugin.listeners.add(this.update);this.renderer.load();this.refresh();
  }
  private refresh():void {
    const state=this.plugin.controller?.state;
    this.status.textContent=state?.error||(!state?.connected?"未连接：请配置本机 Piora 地址和能力令牌。":(state.control.runtime==="idle"?"已连接 · 就绪":"已连接 · "+state.control.runtime)+(state.control.pendingApproval?" · 请在 Piora 处理待确认输入":""));
    if(state?.connected&&state.selectedId)this.status.textContent+=(state.history.remotePolicy==="notes"?" · 笔记助手（工具禁用）":" · 完整 Agent：可能直接修改文件");
    this.picker.replaceChildren();element(this.picker,"option","选择会话").value="";
    for(const session of state?.sessions??[])element(this.picker,"option",session.name||session.id).value=session.id;
    this.picker.value=state?.selectedId??"";this.picker.disabled=!state?.connected||Boolean(state?.sending||state?.uncertain);
    this.sendButton.disabled=!state?.connected||!state.selectedId||state.sending||state.uncertain||state.control.runtime!=="idle"||!this.plugin.controller?.has("session.message.send");
    this.stopButton.disabled=!state?.selectedId||!this.plugin.controller?.has("session.abort");
    this.retryButton.hidden=!state?.uncertain;this.retryButton.disabled=Boolean(state?.sending);
    this.resolveButton.hidden=!state?.uncertain;
    this.references.replaceChildren();
    for(const note of this.plugin.notes)button(this.references,note.path+" · "+Buffer.byteLength(note.text)+" B ×",()=>{this.plugin.notes=this.plugin.notes.filter(candidate=>candidate!==note);this.plugin.emit();});
    const signature=JSON.stringify([state?.selectedId,state?.history,state?.live,state?.tools]);
    if(signature===this.signature)return;this.signature=signature;
    this.renderer.unload();this.renderer=new Component();this.renderer.load();const generation=++this.renderGeneration;
    const nearBottom=this.messages.scrollHeight-this.messages.scrollTop-this.messages.clientHeight<100;
    this.messages.replaceChildren();
    if(!state?.selectedId)element(this.messages,"p","连接后新建或选择会话。笔记助手需要服务端支持受限策略；完整 Agent 可能直接修改文件。","piora-muted");
    for(const [index,message] of (state?.history.messages??[]).entries()){
      const text=messageText(message.content);if(!text)continue;
      const card=element(this.messages,"article",undefined,"piora-message piora-"+message.role.replace(/[^a-z]/gi,""));
      element(card,"strong",message.role==="user"?"你":message.role==="assistant"?"Piora":"工具结果");
      const body=element(card,"div",undefined,"piora-message-body");
      if(message.role==="toolResult"){const details=element(body,"details");element(details,"summary","展开工具输出");element(details,"pre",text.slice(0,20000));}
      else void MarkdownRenderer.render(this.plugin.app,safeMarkdown(text),body,"",this.renderer).then(()=>{if(generation===this.renderGeneration&&nearBottom)this.messages.scrollTop=this.messages.scrollHeight;}).catch(()=>{body.textContent=text;});
      if(message.role==="assistant"){
        const key=replyKey(state!.selectedId!,state!.history,index);
        const actions=element(card,"div",undefined,"piora-toolbar");button(actions,"复制",()=>navigator.clipboard.writeText(text));button(actions,"新建笔记",()=>new CreateNoteModal(this.plugin,text).open());button(actions,"预览替换",()=>this.plugin.review(text,false,key));button(actions,"插入光标处",()=>this.plugin.review(text,true));
      }
    }
    if(state?.live){const live=element(this.messages,"article",undefined,"piora-message");element(live,"strong","Piora · 正在生成");element(live,"pre",state.live);}
    if(state?.tools.length)element(this.messages,"p","工具："+state.tools.join(" → "),"piora-muted");
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
class PioraSettingsTab extends PluginSettingTab {
  constructor(private plugin:PioraPlugin){super(plugin.app,plugin);}
  display():void {
    this.containerEl.replaceChildren();element(this.containerEl,"h2","Piora 连接");
    new Setting(this.containerEl).setName("本机服务地址").setDesc("从 Piora → 设置 → 远程控制复制；地址变化后需重新提供令牌。").addText(text=>text.setValue(this.plugin.settings.address).onChange(value=>{this.plugin.settings.address=value;this.plugin.controller?.disconnect();void this.plugin.persist();}));
    new Setting(this.containerEl).setName("能力令牌").setDesc("不显示已保存令牌，不写入插件普通配置。").addText(text=>{text.inputEl.type="password";text.setPlaceholder("输入或更新令牌").onChange(value=>this.plugin.setToken(value));});
    new Setting(this.containerEl).setName("使用宿主秘密存储").setDesc("关闭则令牌仅存内存；不支持秘密存储时也仅存内存。").addToggle(toggle=>toggle.setValue(this.plugin.settings.rememberToken).onChange(async value=>{this.plugin.settings.rememberToken=value;await this.plugin.persist();}));
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
  private task?:TaskReceipt&{address:string};private clientAddress="";
  async onload():Promise<void>{
    const saved:unknown=await this.loadData();if(saved&&typeof saved==="object")for(const key of Object.keys(defaults) as Array<keyof Settings>){const value=(saved as Record<string,unknown>)[key];if(typeof value===typeof defaults[key])Object.assign(this.settings,{[key]:value});}
    if(!["notes","agent"].includes(this.settings.policy))this.settings.policy="notes";
    const task=(saved as {task?:unknown}|null)?.task;
    if(task&&typeof task==="object"&&"sessionId" in task&&"key" in task&&"address" in task&&typeof task.sessionId==="string"&&typeof task.key==="string"&&typeof task.address==="string")this.task={sessionId:task.sessionId,key:task.key,address:task.address,...("commandId" in task&&typeof task.commandId==="string"?{commandId:task.commandId}:{})};
    this.registerView(VIEW,leaf=>new ChatView(leaf,this));this.addSettingTab(new PioraSettingsTab(this));
    this.addRibbonIcon("bot","打开 Piora",()=>{void this.open();});this.addCommand({id:"open-chat",name:"打开聊天侧栏",callback:()=>{void this.open();}});
    this.addCommand({id:"reference-note",name:"引用当前笔记",editorCallback:(editor,view)=>{if(view.file){this.capture(editor,view.file,false);void this.open();}}});
    this.addCommand({id:"reference-selection",name:"引用选中文字",editorCallback:(editor,view)=>{if(view.file){this.capture(editor,view.file,true);void this.open();}}});
    this.registerEvent(this.app.workspace.on("editor-menu",(menu,editor,view)=>{if(!view.file)return;const file=view.file;for(const [label,prompt] of [["解释选区","解释选中的内容"],["总结选区","总结选中的内容"],["改写选区","改写选中的内容，仅返回建议正文"]])menu.addItem(item=>item.setTitle("Piora："+label).setIcon("bot").onClick(()=>{this.capture(editor,file,true);this.draft=prompt;void this.open();}));}));
    this.registerEvent(this.app.workspace.on("active-leaf-change",()=>{const view=this.app.workspace.getActiveViewOfType(MarkdownView);if(view?.file)this.lastEditor={editor:view.editor,file:view.file};}));
  }
  vaultPath():string{const adapter=this.app.vault.adapter;if(!(adapter instanceof FileSystemAdapter))throw new Error("仅支持桌面文件 Vault");return adapter.getBasePath();}
  setToken(value:string):void{try{this.credentials.set(this.settings.address,this.vaultPath(),value,this.settings.rememberToken);}catch{new Notice("请先填写有效的本机地址");}}
  private token():string{return this.credentials.get(this.settings.address,this.vaultPath(),this.settings.rememberToken);}
  persist():Promise<void>{const snapshot={...this.settings,...(this.task?{task:{...this.task}}:{})};this.saveQueue=this.saveQueue.catch(()=>{}).then(()=>this.saveData(snapshot));return this.saveQueue;}
  emit():void{const state=this.controller?.state;if(state?.selectedId)this.replyContexts.observe(state.selectedId,state.history);for(const listener of this.listeners)listener();}
  async connect():Promise<void>{
    const address=normalizeAddress(this.settings.address);
    if(this.controller?.state.uncertain&&this.clientAddress!==address)throw new Error("请先在原服务核对未确认任务，再切换地址");
    this.controller?.disconnect();this.settings.address=address;
    if(!this.controller||this.clientAddress!==address){const client=new RemoteClient(address,()=>this.token());this.controller=new SessionController(client,()=>this.emit(),async task=>{this.task=task?{...task,address}:undefined;await this.persist();});this.clientAddress=address;}
    try{await this.controller.connect();const target=this.task?.address===address?this.task.sessionId:this.settings.lastSession;if(target&&!this.controller.state.uncertain&&this.controller.state.sessions.some(session=>session.id===target)){await this.controller.select(target);if(this.task?.address===address)this.controller.restoreTask(this.task);}await this.persist();}
    catch(error){this.controller.state.error=error instanceof Error?error.message:"连接失败";this.emit();throw error;}
  }
  resolveTask():void {const modal=new Modal(this.app);modal.setTitle("确认已核对任务？");element(modal.contentEl,"p","解除锁定不会停止已经执行的任务。请先在 Piora 核对，避免重复执行；重启前的消息正文不会自动重发。");button(modal.contentEl,"取消",()=>modal.close());button(modal.contentEl,"已核对，解除锁定",async()=>{await this.controller?.forgetTask();modal.close();});modal.open();}
  async select(id:string):Promise<void>{if(!this.controller||!id)return;await this.controller.select(id);this.settings.lastSession=id;await this.persist();}
  async newSession():Promise<void>{
    if(!this.controller?.state.connected)await this.connect();
    const create=async()=>{const settings=this.settings;if(Boolean(settings.provider)!==Boolean(settings.modelId))throw new Error("模型提供商和模型 ID 必须同时填写");const id=await this.controller!.create({cwd:settings.cwd||this.vaultPath(),policy:settings.policy,name:"Obsidian · "+this.app.vault.getName(),...(settings.provider?{provider:settings.provider,modelId:settings.modelId}:{}),...(settings.thinkingLevel?{thinkingLevel:settings.thinkingLevel}:{})});this.settings.lastSession=id;await this.persist();};
    if(this.settings.policy==="agent"){const modal=new Modal(this.app);modal.setTitle("启用完整 Agent？");element(modal.contentEl,"p","Agent 工具可能直接修改本机文件，不经过插件预览。只用于可信任务，并确保已有备份。");button(modal.contentEl,"取消",()=>modal.close());button(modal.contentEl,"确认创建",async()=>{modal.close();await create();});modal.open();}else await create();
  }
  async open():Promise<void>{let leaf=this.app.workspace.getLeavesOfType(VIEW)[0];if(!leaf){leaf=this.app.workspace.getRightLeaf(false)!;if(!leaf)throw new Error("无法打开侧栏");await leaf.setViewState({type:VIEW,active:true});}await this.app.workspace.revealLeaf(leaf);this.emit();}
  openSettings():void {new Notice("打开 Obsidian 设置 → 第三方插件 → Piora，配置地址和令牌。");}
  capture(editor:Editor,file:TFile,selection:boolean):void{
    assertVaultTarget(this.vaultPath(),file.path);const original=editor.getValue();const from=selection?editor.posToOffset(editor.getCursor("from")):0;const to=selection?editor.posToOffset(editor.getCursor("to")):original.length;
    if(selection&&from===to)throw new Error("请先选中文字");this.lastEditor={editor,file};const note={path:file.path,original,text:original.slice(from,to),from,to};this.notes=[...this.notes.filter(item=>item.path!==file.path),note];this.emit();
  }
  async addCurrent():Promise<void>{const view=this.app.workspace.getActiveViewOfType(MarkdownView);const current=view?.file?{editor:view.editor,file:view.file}:this.lastEditor;if(!current)throw new Error("请先打开笔记");this.capture(current.editor,current.file,false);}
  async addNote(file:TFile):Promise<void>{assertVaultTarget(this.vaultPath(),file.path);const open=this.app.workspace.getLeavesOfType("markdown").map(leaf=>leaf.view).find(view=>view instanceof MarkdownView&&view.file?.path===file.path);if(open instanceof MarkdownView){this.capture(open.editor,file,false);return;}const text=await this.app.vault.read(file);this.notes=[...this.notes.filter(note=>note.path!==file.path),{path:file.path,text,original:text}];this.emit();}
  async send():Promise<void>{if(!this.controller?.state.selectedId)throw new Error("请先连接并选择会话");const content=buildPrompt(this.draft,this.notes);this.replyContexts.begin(this.controller.state.selectedId,content,this.notes,this.controller.state.history);await this.controller.send(content);this.draft="";this.notes=[];this.emit();}
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
  onunload():void{this.controller?.disconnect();this.listeners.clear();this.credentials.clear();this.notes=[];this.replyContexts.clear();}
}
