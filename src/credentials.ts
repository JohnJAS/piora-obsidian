import {normalizeAddress} from "./core";
import {credentialId} from "./presentation";
export interface SecretStore { getSecret(id:string):string|null; setSecret(id:string,value:string):void }
export class Credentials {
  private memory=new Map<string,string>();
  constructor(private store:()=>SecretStore|undefined) {}
  set(address:string,vault:string,token:string,remember:boolean):void {
    const id=credentialId(normalizeAddress(address),vault);this.memory.set(id,token.trim());
    if(remember){try{this.store()?.setSecret(id,token.trim());}catch{}}
  }
  get(address:string,vault:string,remember:boolean):string {
    const id=credentialId(normalizeAddress(address),vault);if(this.memory.has(id))return this.memory.get(id)!;
    if(remember){try{return this.store()?.getSecret(id)??"";}catch{}}
    return "";
  }
  setRemembered(address:string,vault:string,remember:boolean):boolean {
    const id=credentialId(normalizeAddress(address),vault);
    try {
      const store=this.store();if(!store)return false;
      const token=this.memory.has(id)?this.memory.get(id)!:store.getSecret(id)??"";
      store.setSecret(id,remember?token:"");this.memory.set(id,token);return true;
    }catch{throw new Error("无法更新秘密存储，请重试或在宿主中手动处理保存值");}
  }
  forget(address:string,vault:string):boolean {
    const id=credentialId(normalizeAddress(address),vault);
    try{const store=this.store();store?.setSecret(id,"");this.memory.set(id,"");return Boolean(store);}
    catch{throw new Error("无法清空秘密存储，令牌尚未确认被忘记，请重试");}
  }
  clear():void {this.memory.clear();}
}
