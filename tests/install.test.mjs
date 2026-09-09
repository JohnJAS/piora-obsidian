import {expect,it} from "vitest";
import {mkdtemp,mkdir,writeFile,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {installPlugin} from "../scripts/install.mjs";
it("installs only plugin assets and preserves settings on explicit update",async()=>{
 const root=await mkdtemp(join(tmpdir(),"piora-install-"));const vault=join(root,"vault");const build=join(root,"dist");await mkdir(join(vault,".obsidian"),{recursive:true});await mkdir(build);
 await writeFile(join(build,"manifest.json"),JSON.stringify({id:"piora-obsidian",version:"0.1.0"}));await writeFile(join(build,"main.js"),"fixture");await writeFile(join(build,"styles.css"),"fixture");
 const target=await installPlugin(vault,build);expect(await readFile(join(target,"main.js"),"utf8")).toBe("fixture");
 await writeFile(join(target,"data.json"),'{}');await expect(installPlugin(vault,build)).rejects.toThrow(/replace/);
 await installPlugin(vault,build,true);expect(await readFile(join(target,"data.json"),"utf8")).toBe('{}');
});
it("refuses a folder that is not an Obsidian vault",async()=>{const root=await mkdtemp(join(tmpdir(),"piora-no-vault-"));await expect(installPlugin(root,root)).rejects.toThrow(/Vault/);});
