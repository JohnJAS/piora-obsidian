import {realpathSync} from "node:fs";
import {dirname,isAbsolute,join,relative} from "node:path";
import {validateNotePath} from "./core";
import {validateAttachmentPath} from "./attachments";
export function assertVaultTarget(root:string,path:string,creating=false):void {
  validateNotePath(path);assertPhysicalTarget(root,path,creating);
}
export function assertVaultAttachment(root:string,path:string):void {validateAttachmentPath(path);assertPhysicalTarget(root,path,false);}
function assertPhysicalTarget(root:string,path:string,creating:boolean):void {
  const realRoot=realpathSync(root);const target=join(realRoot,path);
  const physical=realpathSync(creating?dirname(target):target);const offset=relative(realRoot,physical);
  if(isAbsolute(offset)||offset===".."||offset.startsWith("..\\")||offset.startsWith("../"))throw new Error("目标通过链接越出了 Vault");
}
