import { describe, expect, it } from "vitest";
import { normalizeAddress, validateNotePath, buildPrompt, applyReplacement, checkRequest, SseParser, REQUEST_LIMIT } from "../src/core";
describe("local server address", () => {
  it("accepts a copied API prefix and pins localhost to loopback", () => {
    expect(normalizeAddress(" http://localhost:63966/api/remote/v1/ ")).toBe("http://127.0.0.1:63966/api/remote/v1");
    expect(normalizeAddress("http://[::1]:30141")).toBe("http://[::1]:30141/api/remote/v1");
  });
  it.each(["https://example.com", "http://user:secret@localhost:80", "file:///a", "http://127.0.0.1:80/api/files", "http://localhost?token=secret", "http://localhost/#x"]) ("rejects untrusted address %s", value => expect(() => normalizeAddress(value)).toThrow());
});
describe("note context and writes", () => {
  it.each(["../secret.md", "/secret.md", "C:\\secret.md", "folder/../../secret.md", "a//b.md", ".obsidian/data.md", "x/.git/config.md", "a.txt", "a"+String.fromCharCode(0)+".md"]) ("rejects invalid note path %s", value => expect(() => validateNotePath(value)).toThrow());
  it("accepts unicode markdown and includes only selected snapshots", () => {
    expect(validateNotePath("笔记/记录.md")).toBe("笔记/记录.md");
    const prompt = buildPrompt("总结", [{path:"笔记.md", text:"未保存内容", original:"private full buffer"}]);
    expect(prompt).toContain("未保存内容"); expect(prompt).not.toContain("private full buffer"); expect(prompt).toContain("不可信");
  });
  it("replaces exact selection and rejects concurrent edits", () => {
    const note = {path:"note.md",text:"two",original:"one two three",from:4,to:7};
    expect(applyReplacement(note.original,note,"TWO")).toBe("one TWO three");
    expect(() => applyReplacement("changed",note,"TWO")).toThrow(/变化|冲突/);
    expect(() => applyReplacement(note.original,{...note,to:100},"TWO")).toThrow();
  });
});
it("checks serialized UTF-8 size", () => {
  expect(checkRequest({content:"hello"})).toBe(JSON.stringify({content:"hello"}));
  expect(() => checkRequest({content:"中".repeat(REQUEST_LIMIT/2)})).toThrow(/256/);
});
describe("SSE parsing", () => {
  it("handles split CRLF, heartbeat, id and multiline data", () => {
    const events: Array<{id?:string; data:string}> = []; const parser=new SseParser(event=>events.push(event));
    parser.feed(":beat\r"); parser.feed("\n\r\nid: 2\r\ndata: {\r\ndata: }\r\n\r"); parser.feed("\n");
    expect(events).toEqual([{id:"2",data:"{\n}"}]);
  });
  it("rejects unbounded frames", () => expect(() => new SseParser(()=>{}).feed("x".repeat(1024*1024+1))).toThrow());
});
