import type {TaskReceipt} from "./session";
import {isServerId,normalizeAddress} from "./core";
export interface StoredTaskReceipt extends TaskReceipt {address:string;serverId?:string}
function readReceipt(value:unknown):StoredTaskReceipt {
  if(!value||typeof value!=="object")throw new Error("任务回执数据无效，请先备份配置并核对任务");
  const record=value as Record<string,unknown>;
  if(record.serverId!==undefined&&!isServerId(record.serverId))throw new Error("任务回执服务身份无效");
  if([record.address,record.sessionId,record.key].some(field=>typeof field!=="string"||!field||field.length>2048))throw new Error("任务回执缺少有效地址、会话或幂等键");
  if(record.commandId!==undefined&&(typeof record.commandId!=="string"||!record.commandId||record.commandId.length>2048))throw new Error("任务回执命令 ID 无效");
  let address:string;try{address=normalizeAddress(record.address as string);}catch{throw new Error("任务回执服务地址无效，请核对原服务");}
  return {address,...(isServerId(record.serverId)?{serverId:record.serverId}:{}),sessionId:record.sessionId as string,key:record.key as string,...(typeof record.commandId==="string"?{commandId:record.commandId}:{}),...(record.delivery==="next_turn"||record.delivery==="steer"?{delivery:record.delivery}:{}),...(typeof record.status==="string"&&/^(accepted|queued|dispatching|running|delivered|completed|failed|cancelled|expired|interrupted)$/.test(record.status)?{status:record.status}:{}),...(typeof record.queuePosition==="number"&&Number.isInteger(record.queuePosition)&&record.queuePosition>=0?{queuePosition:record.queuePosition}:{})};
}
export function readStoredTasks(saved:unknown):StoredTaskReceipt[] {
  if(!saved||typeof saved!=="object")return [];
  const record=saved as {tasks?:unknown;task?:unknown};const values=record.tasks??(record.task?[record.task]:[]);
  if(!Array.isArray(values))throw new Error("任务回执列表无效，请先备份配置并核对任务");
  const tasks=values.map(readReceipt);const keys=new Set<string>();
  for(const task of tasks){const key=task.address+"\n"+(task.serverId??"")+"\n"+task.key;if(keys.has(key))throw new Error("任务回执存在重复幂等键，请核对任务");keys.add(key);}
  return tasks;
}
export function updateStoredTasks(tasks:StoredTaskReceipt[],address:string,task:TaskReceipt|null,key?:string,serverId?:string):StoredTaskReceipt[] {
  const normalized=normalizeAddress(address);const targetKey=task?.key??key;if(!targetKey)throw new Error("删除任务回执必须指定幂等键");
  const next=tasks.filter(record=>record.address!==normalized||record.serverId!==serverId||record.key!==targetKey);
  return task?[...next,readReceipt({...task,address:normalized,serverId})]:next;
}
