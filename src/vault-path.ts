import {realpathSync} from "node:fs";
import {dirname,isAbsolute,join,relative} from "node:path";
import {validateNotePath} from "./core";
export function assertVaultTarget(root:string,path:string,creating=false):void {
  validateNotePath(path);const realRoot=realpathSync(root);const target=join(realRoot,path);
  const physical=realpathSync(creating?dirname(target):target);const offset=relative(realRoot,physical);
  if(isAbsolute(offset)||offset===".."||offset.startsWith("..\\")||offset.startsWith("../"))throw new Error("目标通过链接越出了 Vault");
}
