import { vi } from "vitest";

export class Component { load() {} unload() {} }
export class ItemView { contentEl = document.createElement("div"); }
export class WorkspaceLeaf {}
export class FileSystemAdapter { getBasePath() { return "fixture-vault"; } }
export class TFile { constructor(public path: string) {} }
export class MarkdownView {
  constructor(public file: TFile, public editor: unknown) {}
}
export class Plugin {
  app: any;
  commands: any[] = [];
  loadData = vi.fn(async () => null);
  saveData = vi.fn(async (_data: unknown) => {});
  registerView = vi.fn();
  addSettingTab = vi.fn();
  addRibbonIcon = vi.fn();
  addCommand(command: unknown) { this.commands.push(command); }
  registerEvent = vi.fn();
}
export class PluginSettingTab {
  containerEl = document.createElement("div");
  constructor(public app: unknown, public plugin: unknown) {}
}
export class Notice {
  static messages: string[] = [];
  constructor(message: string) { Notice.messages.push(message); }
}
export class Modal {
  static opened: Modal[] = [];
  contentEl = document.createElement("div");
  title = "";
  constructor(public app: any) {}
  setTitle(title: string) { this.title = title; }
  onOpen() {}
  onClose() {}
  open() { Modal.opened.push(this); this.onOpen(); }
  close() { Modal.opened = Modal.opened.filter(modal => modal !== this);this.onClose(); }
}
export class FuzzySuggestModal extends Modal { setPlaceholder() {} }
export class Setting {
  private element = document.createElement("div");
  constructor(parent: HTMLElement) { parent.append(this.element); }
  setName(name: string) { this.element.append(name); return this; }
  setDesc(description: string) { this.element.append(description); return this; }
  addText(callback: (control: any) => void) {
    const inputEl = document.createElement("input"); this.element.append(inputEl);
    const control = { inputEl, setValue(value: string) { inputEl.value = value; return control; }, setPlaceholder(value: string) { inputEl.placeholder = value; return control; }, onChange: () => control };
    callback(control); return this;
  }
  addToggle(callback: (control: any) => void) {
    const input=document.createElement("input");input.type="checkbox";this.element.append(input);
    const control = { setValue(value:boolean) {input.checked=value;return control;}, onChange(action:(value:boolean)=>void) {input.onchange=()=>action(input.checked);return control;} }; callback(control); return this;
  }
  addDropdown(callback: (control: any) => void) {
    const control = { addOption: () => control, setValue: () => control, onChange: () => control }; callback(control); return this;
  }
  addButton(callback: (control: any) => void) {
    const button = document.createElement("button"); this.element.append(button);
    const control = { setButtonText(value: string) { button.textContent = value; return control; }, onClick(action: () => void) { button.onclick = action; return control; } };
    callback(control); return this;
  }
}
export const MarkdownRenderer = { render: vi.fn(async (_app: unknown, text: string, element: HTMLElement) => { element.textContent = text; }) };
