import {isServerId,normalizeAddress} from "./core";
import {readCreationReceipt,type CreationReceipt} from "./session";

export interface StoredCreationReceipt extends CreationReceipt {address:string;serverId:string}
function readStoredCreation(value:unknown):StoredCreationReceipt {
  const receipt=readCreationReceipt(value);const record=value as Record<string,unknown>;
  if(typeof record.address!=="string"||!isServerId(record.serverId))throw new Error("会话创建回执缺少有效服务身份");
  let address:string;try{address=normalizeAddress(record.address);}catch{throw new Error("会话创建回执服务地址无效");}
  return {...receipt,address,serverId:record.serverId};
}
export function readStoredCreations(saved:unknown):StoredCreationReceipt[] {
  const values=(saved as {creations?:unknown}|null)?.creations;if(values===undefined)return [];
  if(!Array.isArray(values)||values.length>100)throw new Error("会话创建回执列表无效或超过 100 条，请备份并核对");
  const seen=new Set<string>();return values.map(value=>{const receipt=readStoredCreation(value);const key=receipt.address+"\n"+receipt.serverId;if(seen.has(key))throw new Error("同一实例存在重复会话创建回执，请核对");seen.add(key);return receipt;});
}
export function updateStoredCreations(records:StoredCreationReceipt[],address:string,serverId:string,receipt:CreationReceipt|null):StoredCreationReceipt[] {
  const normalized=normalizeAddress(address);if(!isServerId(serverId))throw new Error("无效创建回执服务身份");
  const next=records.filter(record=>record.address!==normalized||record.serverId!==serverId);
  return readStoredCreations({creations:receipt?[...next,{...receipt,address:normalized,serverId}]:next});
}
