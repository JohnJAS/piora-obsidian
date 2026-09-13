import type {NoteContext} from "./core";
import type {History} from "./session";
import {messageText} from "./presentation";
export function replyKey(sessionId:string,history:History,index:number):string{return sessionId+"/"+(history.entryIds?.[index]??String(index));}
export class ReplyContexts {
  private pending:Array<{id:number;sessionId:string;prompt:string;notes:NoteContext[];before:Set<string>;matchedUserId?:string}>=[];
  private sequence=0;
  private replies=new Map<string,NoteContext[]>();
  begin(sessionId:string,prompt:string,notes:NoteContext[],history:History):number {const id=++this.sequence;this.pending.push({id,sessionId,prompt,notes:notes.map(note=>({...note})),before:new Set(history.messages.map((_,index)=>replyKey(sessionId,history,index)))});while(this.pending.length>100)this.pending.shift();return id;}
  cancel(id:number):void {this.pending=this.pending.filter(pending=>pending.id!==id);}
  observe(sessionId:string,history:History):void {
    const candidates=this.pending.filter(pending=>pending.sessionId===sessionId);if(!candidates.length)return;
    let matching:typeof candidates[number]|undefined;
    for(const [index,message] of history.messages.entries()){
      const key=replyKey(sessionId,history,index);
      if(message.role==="user"){
        matching=candidates.find(pending=>pending.matchedUserId===key)??candidates.find(pending=>!pending.matchedUserId&&!pending.before.has(key)&&messageText(message.content)===pending.prompt);
        if(matching)matching.matchedUserId=key;
      }
      if(matching&&message.role==="assistant"&&!this.replies.has(key))this.replies.set(key,matching.notes);
    }
    while(this.replies.size>100)this.replies.delete(this.replies.keys().next().value!);
  }
  get(key:string,path:string):NoteContext|undefined {const note=this.replies.get(key)?.find(note=>note.path===path);return note?{...note}:undefined;}
  clear():void {this.pending=[];this.replies.clear();}
}
