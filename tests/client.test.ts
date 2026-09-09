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
