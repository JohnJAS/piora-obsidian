import {expect,it,vi} from "vitest";
import {searchNotes} from "../src/note-search";
function source(notes:Record<string,string>){return {files:Object.entries(notes).map(([path,text])=>({path,bytes:Buffer.byteLength(text)})),read:vi.fn(async(path:string)=>notes[path])};}
it("matches all literal query terms in names and content with title-weighted ranking",async()=>{
 const fixture=source({"项目/预算.md":"团队安排", "项目/计划.md":"团队预算进度", "别处.md":"预算", "literal.md":"a+b [x]"});
 const result=await searchNotes(fixture,"预算 团队");expect(result.hits.map(hit=>hit.path)).toEqual(["项目/预算.md","项目/计划.md"]);expect(result.hits[1].snippet).toContain("团队预算");
 expect((await searchNotes(fixture,"a+b [x]")).hits.map(hit=>hit.path)).toEqual(["literal.md"]);
});
it("limits folders on segment boundaries and never reads hidden, traversing or non-note paths",async()=>{
 const fixture=source({"work/one.md":"match","work-two/no.md":"match",".obsidian/no.md":"match","work/../no.md":"match","work/.hidden/no.md":"match","work/image.png":"match"});
 const result=await searchNotes(fixture,"match",{folder:"work"});expect(result.hits.map(hit=>hit.path)).toEqual(["work/one.md"]);expect(fixture.read.mock.calls).toEqual([["work/one.md"]]);
 await expect(searchNotes(fixture,"match",{folder:"../outside"})).rejects.toThrow();
 await expect(searchNotes(fixture," ")).rejects.toThrow();
});
it("bounds reads and results and reports files too large or unavailable",async()=>{
 const fixture=source(Object.fromEntries(Array.from({length:510},(_,index)=>["note-"+index+".md","match"])));
 const result=await searchNotes(fixture,"match");expect(result.hits).toHaveLength(20);expect(fixture.read.mock.calls.length).toBeLessThanOrEqual(500);expect(result.limited).toBe(true);
 const damaged={files:[{path:"large.md",bytes:300000},{path:"missing.md",bytes:4},{path:"ok.md",bytes:5}],read:vi.fn(async(path:string)=>{if(path==="missing.md")throw new Error("deleted");return "match";})};
 const partial=await searchNotes(damaged,"match");expect(partial.hits).toHaveLength(1);expect(partial.skipped).toBe(2);expect(damaged.read).not.toHaveBeenCalledWith("large.md");
});
it("cancels pending search without reading the next note",async()=>{
 const abort=new AbortController();const fixture=source({"one.md":"match","two.md":"match"});fixture.read.mockImplementation(async()=>{abort.abort();return "match";});
 await expect(searchNotes(fixture,"match",{signal:abort.signal})).rejects.toThrow();expect(fixture.read).toHaveBeenCalledTimes(1);
});
it("stops at the aggregate byte budget even when every file is individually allowed",async()=>{
 const text="match"+"x".repeat(256*1024-5);const fixture={files:Array.from({length:50},(_,index)=>({path:"file-"+index+".md",bytes:Buffer.byteLength(text)})),read:vi.fn(async()=>text)};
 const result=await searchNotes(fixture,"match");expect(result.scanned).toBe(32);expect(fixture.read).toHaveBeenCalledTimes(32);expect(result.limited).toBe(true);
});
