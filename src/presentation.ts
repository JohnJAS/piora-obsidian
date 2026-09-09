import { createHash } from "node:crypto";
export function messageText(content: unknown): string {
  if(typeof content==="string")return content;
  if(!Array.isArray(content))return "";
  return content.filter(block=>block&&typeof block==="object"&&block.type==="text"&&typeof block.text==="string").map(block=>block.text as string).join("\n");
}
export function safeMarkdown(text: string): string {
  return text.replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/!\[/g,"[嵌入已禁用] [").replace(/\]\(\s*(?:javascript|data|file|obsidian):[^)]*\)/gi,"](#)");
}
export function credentialId(address:string,vault:string):string {return "piora-"+createHash("sha256").update(address+"\n"+vault).digest("hex").slice(0,32);}
