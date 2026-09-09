// @vitest-environment happy-dom
import {expect,it,vi} from "vitest";
vi.mock("obsidian",()=>({ItemView:class {contentEl=document.createElement("div");},Plugin:class {},WorkspaceLeaf:class {},PluginSettingTab:class {},Modal:class {},FuzzySuggestModal:class {},Notice:class {},Setting:class {},TFile:class {},MarkdownView:class {},FileSystemAdapter:class {},MarkdownRenderer:{render:vi.fn()},Component:class {load(){}unload(){}}}));
import {ChatView} from "../src/main";
it("opens a connection-first pane with no enabled send button",async()=>{
 const plugin={controller:undefined,settings:{address:"",policy:"notes"},notes:[],listeners:new Set(),draft:"",connect:vi.fn(),openSettings:vi.fn()};
 const view=new ChatView({} as never,plugin as never);await view.onOpen();
 expect(view.contentEl.textContent).toContain("Piora");
 expect(view.contentEl.querySelector<HTMLButtonElement>('[data-action="send"]')?.disabled).toBe(true);
 expect(view.contentEl.textContent).toContain("连接");
});
