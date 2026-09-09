import {resolve,join,relative,isAbsolute} from "node:path";
import {fileURLToPath} from "node:url";
import {stat,lstat,realpath,mkdir,readFile,copyFile,writeFile,rename} from "node:fs/promises";
import {randomUUID} from "node:crypto";
export async function installPlugin(vault,buildDirectory,replace=false) {
  const root=await realpath(vault);const configuration=join(root,".obsidian");
  if(!await stat(configuration).then(info=>info.isDirectory()).catch(()=>false))throw new Error("目标不是带 .obsidian 配置的 Vault");
  const within=async target=>{const offset=relative(root,await realpath(target));if(isAbsolute(offset)||offset===".."||offset.startsWith("..\\")||offset.startsWith("../"))throw new Error("插件路径越出了 Vault");};
  await within(configuration);
  const files=["manifest.json","main.js","styles.css"];const contents=await Promise.all(files.map(file=>readFile(join(buildDirectory,file))));
  if(JSON.parse(contents[0].toString("utf8")).id!=="piora-obsidian")throw new Error("插件 manifest ID 无效");
  const plugins=join(configuration,"plugins");await mkdir(plugins,{recursive:true});await within(plugins);
  const destination=join(plugins,"piora-obsidian");const exists=await lstat(destination).then(()=>true).catch(()=>false);
  if(exists&&!replace)throw new Error("插件已存在；明确更新时使用 --replace");
  if(!exists)await mkdir(destination);await within(destination);
  const backup=join(destination,".backup-"+Date.now());if(exists)await mkdir(backup);
  for(const [index,file] of files.entries()) {
    const target=join(destination,file);const info=await lstat(target).catch(()=>undefined);
    if(info?.isSymbolicLink())throw new Error("拒绝覆盖符号链接插件文件");
    if(exists&&info)await copyFile(target,join(backup,file));
    const temporary=join(destination,"."+file+"."+randomUUID()+".tmp");await writeFile(temporary,contents[index],{flag:"wx"});await rename(temporary,target);
  }
  return destination;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(!process.argv[2])throw new Error("Usage: node scripts/install.mjs <vault-path> [--replace]");
  const destination=await installPlugin(process.argv[2],resolve("dist"),process.argv.includes("--replace"));console.log("Installed plugin files: "+destination+". Enable Piora in Obsidian settings; notes and plugin preferences are unchanged.");
}
