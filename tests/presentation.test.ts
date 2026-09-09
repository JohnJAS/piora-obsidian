import {expect,it} from "vitest";
import {messageText,safeMarkdown,credentialId} from "../src/presentation";
it("shows only text blocks and never hidden thinking or base64",()=>{
 expect(messageText([{type:"text",text:"answer"},{type:"thinking",thinking:"private"},{type:"image",data:"secret"}])).toBe("answer");
 expect(messageText("hello")).toBe("hello");expect(messageText({token:"secret"})).toBe("");
});
it("does not render remote image tracking or executable links",()=>{
 expect(safeMarkdown('![pixel](https://example.com/x) <img src="https://example.com/y"> [run](javascript:alert)')).not.toContain("![");
 expect(safeMarkdown('<script>alert(1)</script>')).not.toContain("<script>");
 expect(safeMarkdown('![[private.md]]')).not.toContain("![[");
 expect(safeMarkdown('**bold**')).toBe('**bold**');
});
it("binds credentials to address and vault, without exposing either",()=>{
 const first=credentialId("http://127.0.0.1:1/api/remote/v1","private-vault");expect(first).toMatch(/^piora-[a-f0-9]+$/);
 expect(first).not.toBe(credentialId("http://127.0.0.1:2/api/remote/v1","private-vault"));expect(first).not.toContain("private");
});
