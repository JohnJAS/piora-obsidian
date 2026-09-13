import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type RequestListener } from "node:http";
import { RemoteClient } from "../src/client";
const servers: Server[]=[];
async function fixture(handler: RequestListener) {
  const server=createServer(handler); servers.push(server); await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const address=server.address(); if (!address || typeof address === "string") throw new Error("fixture");
  return new RemoteClient("http://127.0.0.1:"+address.port,()=>"fixture-only");
}
afterEach(async()=>{for(const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }});
describe("remote transport",()=>{
  it("recognizes bounded creation recovery codes without reflecting server messages",async()=>{
    let status=409;let body={code:"REMOTE_CREATION_CONFLICT",error:"fixture-only"};
    const client=await fixture((_,response)=>{response.writeHead(status);response.end(JSON.stringify(body));});
    await expect(client.request("/sessions")).rejects.toMatchObject({status:409,code:"REMOTE_CREATION_CONFLICT",message:expect.stringContaining("原请求")});
    status=500;body={code:"REMOTE_CREATION_INVALID",error:"fixture-only"};
    await expect(client.request("/sessions")).rejects.toMatchObject({code:"REMOTE_CREATION_INVALID",message:expect.stringContaining("核对")});
    status=503;body={code:"REMOTE_CREATION_BUSY",error:"fixture-only"};
    await expect(client.request("/sessions")).rejects.toMatchObject({code:"REMOTE_CREATION_BUSY",message:expect.stringContaining("重试")});
    body={code:"fixture-only",error:"fixture-only"};await expect(client.request("/sessions")).rejects.toMatchObject({code:"HTTP_ERROR"});
    body={code:"REMOTE_CREATION_BUSY",error:"x".repeat(5000)};await expect(client.request("/sessions")).rejects.toMatchObject({code:"HTTP_ERROR"});
  });
  it("bounds anonymous identity responses before considering any credential",async()=>{
    const client=await fixture((request,response)=>{expect(request.headers.authorization).toBeUndefined();response.end(JSON.stringify({protocol:"piora.remote.v1",serverId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",padding:"x".repeat(5000)}));});
    await expect(client.identify()).rejects.toThrow(/限制/);
  });
  it("probes identity without requesting or sending the credential",async()=>{
    const client=await fixture((request,response)=>{expect(request.url).toBe("/api/remote/v1/identity");expect(request.headers.authorization).toBeUndefined();response.end(JSON.stringify({protocol:"piora.remote.v1",serverId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}));});
    expect(await client.identify()).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });
  it("pins every authenticated operation and rejects a changed instance before sending a token",async()=>{
    const original="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";let identity=original;const authenticated:string[]=[];
    const client=await fixture((request,response)=>{
      if(request.url?.endsWith("/identity")){expect(request.headers.authorization).toBeUndefined();response.end(JSON.stringify({protocol:"piora.remote.v1",serverId:identity}));return;}
      authenticated.push(request.url!);expect(request.headers["x-piora-server-id"]).toBe(original);response.end(JSON.stringify({serverId:original}));
    });
    client.pinServer(original);await client.request("/capabilities");identity="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await expect(client.request("/sessions",{body:{cwd:"fixture",policy:"notes"},key:"fixture"})).rejects.toThrow("实例");expect(authenticated).toEqual(["/api/remote/v1/capabilities"]);
  });
  it("rejects identity-less or incompatible responses without falling back to authentication",async()=>{
    const client=await fixture((request,response)=>{expect(request.headers.authorization).toBeUndefined();response.end(JSON.stringify({protocol:"other",serverId:"not-an-id"}));});
    await expect(client.identify()).rejects.toThrow("身份");
  });
  it("rejects a capability response inconsistent with the pinned anonymous identity",async()=>{
    const identity="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";const client=await fixture((request,response)=>{response.end(JSON.stringify(request.url?.endsWith("/identity")?{protocol:"piora.remote.v1",serverId:identity}:{protocol:"piora.remote.v1",serverId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}));});
    client.pinServer(identity);await expect(client.request("/capabilities")).rejects.toThrow("身份");
  });
  it("sends auth and stable idempotency without browser Origin",async()=>{
    const client=await fixture((request,response)=>{
      expect(request.url).toBe("/api/remote/v1/sessions"); expect(request.headers.authorization).toBe("Bearer fixture-only"); expect(request.headers.origin).toBeUndefined(); expect(request.headers["idempotency-key"]).toBe("stable-key");
      response.setHeader("Content-Type","application/json");response.end(JSON.stringify({sessionId:"fixture"}));
    });
    expect(await client.request("/sessions",{body:{cwd:"fixture"},key:"stable-key"})).toEqual({sessionId:"fixture"});
  });
  it("does not follow redirects or leak reflected secrets",async()=>{
    const client=await fixture((_,response)=>{response.writeHead(302,{Location:"https://example.com"}); response.end("fixture-only");});
    await expect(client.request("/capabilities")).rejects.toMatchObject({status:302});
    await expect(client.request("/capabilities")).rejects.not.toThrow("fixture-only");
  });
  it("reports auth failure and rate-limit delay",async()=>{
    const client=await fixture((_,response)=>{response.writeHead(429,{"Retry-After":"12"});response.end('{}');});
    await expect(client.request("/capabilities")).rejects.toMatchObject({status:429,retryAfterMs:12000});
  });
  it("rejects paths escaping the API boundary",async()=>{
    const client=await fixture((_,response)=>response.end('{}'));
    await expect(client.request("/../tokens")).rejects.toThrow();
    await expect(client.request("//example.com")).rejects.toThrow();
  });
  it("receives split UTF-8 SSE and releases socket on cancellation",async()=>{
    const controller=new AbortController();const events: unknown[]=[];
    const client=await fixture((_,response)=>{response.writeHead(200,{"Content-Type":"text/event-stream"});const data=Buffer.from('data: {"type":"snapshot","text":"你好"}\n\n');response.write(data.subarray(0,data.length-5));response.write(data.subarray(data.length-5));});
    await client.stream("/sessions/fixture/events",event=>{events.push(event);controller.abort();},controller.signal);
    expect(events).toEqual([{type:"snapshot",text:"你好"}]);
  });
});
