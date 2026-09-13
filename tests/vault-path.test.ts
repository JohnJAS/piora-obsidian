import {expect,it} from "vitest";
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assertVaultTarget,assertVaultAttachment} from "../src/vault-path";
it("permits supported Vault attachments but rejects hidden paths, unsupported formats and escaping junctions",()=>{
 const fixture=mkdtempSync(join(tmpdir(),"piora-attachment-boundary-"));const root=join(fixture,"vault");const outside=join(fixture,"outside");mkdirSync(root);mkdirSync(outside);writeFileSync(join(root,"image.png"),"synthetic");writeFileSync(join(outside,"image.png"),"synthetic");symlinkSync(outside,join(root,"linked"),process.platform==="win32"?"junction":"dir");
 expect(()=>assertVaultAttachment(root,"image.png")).not.toThrow();expect(()=>assertVaultAttachment(root,"linked/image.png")).toThrow(/Vault/);expect(()=>assertVaultAttachment(root,".obsidian/private.txt")).toThrow();expect(()=>assertVaultAttachment(root,"bad.svg")).toThrow();
});
it("allows normal notes but rejects symlinks escaping the physical Vault",()=>{
 const fixture=mkdtempSync(join(tmpdir(),"piora-vault-boundary-"));const root=join(fixture,"vault");const outside=join(fixture,"outside");mkdirSync(root);mkdirSync(outside);writeFileSync(join(root,"note.md"),"fixture");writeFileSync(join(outside,"note.md"),"outside fixture");symlinkSync(outside,join(root,"linked"),process.platform==="win32"?"junction":"dir");
 expect(()=>assertVaultTarget(root,"note.md")).not.toThrow();expect(()=>assertVaultTarget(root,"new.md",true)).not.toThrow();
 expect(()=>assertVaultTarget(root,"linked/note.md")).toThrow(/Vault/);expect(()=>assertVaultTarget(root,"linked/new.md",true)).toThrow(/Vault/);
});
