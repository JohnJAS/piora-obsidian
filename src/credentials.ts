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
  clear():void {this.memory.clear();}
}
