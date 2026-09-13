import {expect,it} from "vitest";
import {prepareAttachment,attachmentPayload,snapshotImages} from "../src/attachments";
const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=","base64");
it("rejects unknown or absent MIME metadata rather than forwarding an unrecognized image",()=>{
 expect(()=>snapshotImages([{type:"image",data:"eA==",mimeType:undefined} as never])).toThrow();
});
it("snapshots PNG and UTF-8 text without putting base64 in prompt text",()=>{
 const image=prepareAttachment("fixture.png",png);const text=prepareAttachment("记录.txt",Buffer.from("synthetic text"));
 expect(image).toMatchObject({name:"fixture.png",kind:"image",bytes:png.length,image:{type:"image",mimeType:"image/png",data:png.toString("base64")}});
 const payload=attachmentPayload("分析",[{path:"note.md",text:"selected",original:"private buffer"}],[image,text]);expect(payload.content).toContain("synthetic text");expect(payload.content).toContain("fixture.png");expect(payload.content).toContain("不可信");expect(payload.content).not.toContain(png.toString("base64"));expect(payload.content).not.toContain("private buffer");expect(payload.images).toHaveLength(1);
});
it("rejects misleading image names, active formats, invalid UTF-8 and path-bearing file names",()=>{
 for(const name of ["bad.svg","bad.html","secret.exe","../private.txt","folder/name.txt",".hidden.txt"])expect(()=>prepareAttachment(name,png)).toThrow();
 expect(()=>prepareAttachment("fake.png",Buffer.from("not an image"))).toThrow();expect(()=>prepareAttachment("wrong.jpg",png)).toThrow();expect(()=>prepareAttachment("binary.txt",Buffer.from([0xff,0xfe,0x00]))).toThrow();
});
it("requires explicit size reduction rather than truncating or silently splitting attachments",()=>{
 expect(()=>prepareAttachment("huge.txt",Buffer.alloc(128*1024+1,65))).toThrow(/128/);
 const text=prepareAttachment("large.txt",Buffer.from('"'.repeat(128*1024)));expect(()=>attachmentPayload("read",[],[text])).toThrow(/256/);
 const attachments=Array.from({length:9},(_,index)=>prepareAttachment("file-"+index+".txt",Buffer.from("x")));expect(()=>attachmentPayload("read",[],attachments)).toThrow(/8/);
});
it("supports attachment-only prompts and returns detached immutable payload snapshots",()=>{
 const image=prepareAttachment("fixture.png",png);const payload=attachmentPayload("",[],[image]);expect(payload.content).toContain("附件");expect(payload.images).toHaveLength(1);
 if(image.kind==="image")image.image.data="changed";expect(payload.images![0].data).toBe(png.toString("base64"));expect(()=>attachmentPayload("",[],[])).toThrow(/消息/);
});
