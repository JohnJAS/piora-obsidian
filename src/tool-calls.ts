import type {ChatMessage} from "./session";
import {messageText} from "./presentation";
export interface ToolCall {toolCallId:string;toolName:string;status:"running"|"succeeded"|"failed";output:string;truncated:boolean}
export interface ToolCard extends Omit<ToolCall,"status"> {status:ToolCall["status"]|"unavailable";messageIndex?:number}
export function historyToolCards(messages:ChatMessage[]):ToolCard[] {
  const cards=new Map<string,ToolCard>();
  for(const [messageIndex,message] of messages.entries()){
    if(message.role==="assistant"&&Array.isArray(message.content))for(const block of message.content){
      if(block?.type!=="toolCall")continue;
      const toolCallId=block.toolCallId??block.id;const toolName=block.toolName??block.name;
      if(typeof toolCallId!=="string"||!toolCallId||typeof toolName!=="string")continue;
      if(!cards.has(toolCallId))cards.set(toolCallId,{toolCallId,toolName:toolName.slice(0,100),status:"unavailable",output:"",truncated:false,messageIndex});
    }
    if(message.role!=="toolResult")continue;
    const toolCallId=message.toolCallId||"history-result-"+messageIndex;const previous=cards.get(toolCallId);const output=messageText(message.content);
    cards.set(toolCallId,{toolCallId,toolName:(message.toolName||previous?.toolName||"工具").slice(0,100),status:message.isError===true?"failed":message.isError===false?"succeeded":"unavailable",output:output.slice(0,2000),truncated:output.length>2000,messageIndex});
  }
  return [...cards.values()];
}
export function readToolCalls(value:unknown):ToolCall[] {
  if(!Array.isArray(value))return [];
  const calls:ToolCall[]=[];
  for(const candidate of value.slice(-20)){
    if(!candidate||typeof candidate!=="object")continue;
    const {toolCallId,toolName,status,output,truncated}=candidate;
    if(typeof toolCallId!=="string"||!toolCallId||toolCallId.length>200||typeof toolName!=="string"||!toolName||typeof output!=="string"||!["running","succeeded","failed"].includes(status)||calls.some(call=>call.toolCallId===toolCallId))continue;
    calls.push({toolCallId,toolName:toolName.slice(0,100),status,output:output.slice(0,2000),truncated:truncated===true||output.length>2000});
  }
  return calls;
}
