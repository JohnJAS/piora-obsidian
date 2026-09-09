import type {NoteContext} from "./core";
import type {History} from "./session";
import {messageText} from "./presentation";
export function replyKey(sessionId:string,history:History,index:number):string{return sessionId+"/"+(history.entryIds?.[index]??String(index));}
export class ReplyContexts {
  private pending?:{sessionId:string;prompt:string;notes:NoteContext[];before:Set<string>};
  private replies=new Map<string,NoteContext[]>();
  begin(sessionId:string,prompt:string,notes:NoteContext[],history:History):void {this.pending={sessionId,prompt,notes:notes.map(note=>({...note})),before:new Set(history.messages.map((_,index)=>replyKey(sessionId,history,index)))};}
  observe(sessionId:string,history:History):void {
    const pending=this.pending;if(!pending||pending.sessionId!==sessionId)return;
    let matching=false;
    for(const [index,message] of history.messages.entries()){
      const key=replyKey(sessionId,history,index);
      if(message.role==="user")matching=!pending.before.has(key)&&messageText(message.content)===pending.prompt;
      if(matching&&message.role==="assistant"&&!this.replies.has(key))this.replies.set(key,pending.notes);
    }
    while(this.replies.size>100)this.replies.delete(this.replies.keys().next().value!);
  }
  get(key:string,path:string):NoteContext|undefined {const note=this.replies.get(key)?.find(note=>note.path===path);return note?{...note}:undefined;}
  clear():void {this.pending=undefined;this.replies.clear();}
}
