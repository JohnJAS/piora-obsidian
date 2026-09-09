import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, cp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { build } from "esbuild";

const source=resolve(process.argv[2] || "../Piora");
await mkdir(".local",{recursive:true});
const root=await mkdtemp(resolve(".local/http-"));
const agentDir=join(root,"agent");const vault=join(root,"vault");
const fixtureSource=join(root,"source");await mkdir(fixtureSource,{recursive:true});
for(const directory of ["app","lib","components","hooks","extensions"])await cp(join(source,directory),join(fixtureSource,directory),{recursive:true});
for(const file of ["package.json","tsconfig.json","next.config.ts","next-env.d.ts","proxy.ts","instrumentation.ts","instrumentation-node.ts","postcss.config.mjs"])await cp(join(source,file),join(fixtureSource,file)).catch(error=>{if(error.code!=="ENOENT")throw error;});
await symlink(join(source,"node_modules"),join(fixtureSource,"node_modules"),process.platform==="win32"?"junction":"dir");
await symlink(join(source,"public"),join(fixtureSource,"public"),process.platform==="win32"?"junction":"dir");
await mkdir(agentDir,{recursive:true});await mkdir(vault,{recursive:true});
const requests=[];
const modelServer=createServer(async(request,response)=>{
  let raw="";for await(const chunk of request)raw+=chunk;
  const body=JSON.parse(raw);requests.push(body);
  if(body.stream){
    response.writeHead(200,{"Content-Type":"text/event-stream"});
    for(const content of ["Piora ","fixture ","response."]){response.write("data: "+JSON.stringify({id:"fixture",object:"chat.completion.chunk",created:1,model:"fixture",choices:[{index:0,delta:{role:"assistant",content},finish_reason:null}]})+"\n\n");await new Promise(resolve=>setTimeout(resolve,350));}
    response.end("data: "+JSON.stringify({id:"fixture",object:"chat.completion.chunk",created:1,model:"fixture",choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})+"\n\ndata: [DONE]\n\n");
  } else {response.setHeader("Content-Type","application/json");response.end(JSON.stringify({id:"fixture",object:"chat.completion",created:1,model:"fixture",choices:[{index:0,message:{role:"assistant",content:"Piora fixture response."},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));}
});
await new Promise(resolve=>modelServer.listen(0,"127.0.0.1",resolve));
const modelPort=modelServer.address().port;
await writeFile(join(agentDir,"models.json"),JSON.stringify({providers:{"piora-fixture":{baseUrl:"http://127.0.0.1:"+modelPort+"/v1",api:"openai-completions",apiKey:"fixture-only",models:[{id:"fixture",name:"Fixture",reasoning:false,input:["text"],contextWindow:8192,maxTokens:512,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}}));
await writeFile(join(agentDir,"settings.json"),JSON.stringify({defaultProvider:"piora-fixture",defaultModel:"fixture"}));
const environment={...process.env,PI_CODING_AGENT_DIR:agentDir,PIORA_REMOTE_CONTROL_ROOT:join(root,"remote"),PIORA_RUNTIME_PROFILE:"normal",PI_DESKTOP_TOKEN:"",PI_WEB_PASSWORD:"",NEXT_TELEMETRY_DISABLED:"1"};
Object.assign(process.env,{PI_CODING_AGENT_DIR:agentDir,PIORA_REMOTE_CONTROL_ROOT:environment.PIORA_REMOTE_CONTROL_ROOT,PIORA_RUNTIME_PROFILE:"normal"});
const requirePiora=createRequire(join(source,"package.json"));const {createJiti}=requirePiora("jiti");
const store=await createJiti(import.meta.url).import(join(source,"lib/remote-control-store.ts"));
const {token,record}=await store.createRemoteCapabilityToken({name:"Isolated HTTP integration",scopes:["capabilities.read","session.create","session.state.read","session.history.read","session.tools.read","session.message.send","session.events.read","session.messages.read","session.abort"]});
await mkdir(".local",{recursive:true});
await build({entryPoints:["src/client.ts"],outfile:".local/integration-client.mjs",platform:"node",format:"esm",bundle:true});
const {RemoteClient}=await import(pathToFileURL(resolve(".local/integration-client.mjs")).href);
const port=30142;
const child=spawn(process.execPath,[requirePiora.resolve("next/dist/bin/next"),"dev","--webpack","-H","127.0.0.1","-p",String(port)],{cwd:fixtureSource,env:environment,windowsHide:true,stdio:["ignore","pipe","pipe"]});
let logs="";child.stdout.on("data",chunk=>{logs=(logs+chunk).slice(-12000);});child.stderr.on("data",chunk=>{logs=(logs+chunk).slice(-12000);});
const client=new RemoteClient("http://127.0.0.1:"+port,()=>token);const abort=new AbortController();
try {
  let capabilities;
  for(let attempt=0;attempt<90;attempt++){try{capabilities=await client.request("/capabilities");break;}catch{if(child.exitCode!==null)throw new Error("Dev server exited: "+logs);await new Promise(resolve=>setTimeout(resolve,1000));}}
  assert.equal(capabilities?.features?.contentStream,true,logs);
  const catalog=await client.request("/models");assert.ok(catalog.models.some(model=>model.provider==="piora-fixture"&&model.id==="fixture"),"Configured model missing from remote catalog");
  const created=await client.request("/sessions",{body:{cwd:vault,policy:"notes",provider:"piora-fixture",modelId:"fixture",name:"HTTP fixture"},key:"create-fixture"});
  const replay=await client.request("/sessions",{body:{cwd:vault,policy:"notes"},key:"create-fixture"});assert.equal(replay.sessionId,created.sessionId);
  const base="/sessions/"+created.sessionId;
  const tools=await client.request(base+"/tools");assert.deepEqual(tools.activeToolNames,[]);
  const snapshots=[];const streaming=client.stream(base+"/content-events",event=>snapshots.push(event),abort.signal);
  const receipt=await client.request(base+"/messages",{body:{content:"Summarize this synthetic fixture. Do not access files."},key:"message-fixture"});assert.ok(receipt.commandId);
  let history;
  for(let attempt=0;attempt<60;attempt++){history=await client.request(base+"/history");if(history.messages.some(message=>message.role==="assistant"&&JSON.stringify(message.content).includes("Piora fixture response.")))break;await new Promise(resolve=>setTimeout(resolve,1000));}
  assert.ok(history.messages.some(message=>message.role==="assistant"&&JSON.stringify(message.content).includes("Piora fixture response.")),"Missing assistant result; server tail: "+logs);
  assert.equal(history.remotePolicy,"notes");assert.equal(requests.length,1);assert.ok(requests.every(request=>!request.tools?.length));
  assert.ok(snapshots.some(event=>typeof event.text==="string"&&event.text.includes("Piora")),"No live content observed");
  await store.revokeRemoteCapabilityToken(record.id);
  await Promise.race([streaming,new Promise((_,reject)=>setTimeout(()=>reject(new Error("Revoked stream stayed open")),5000))]);
  assert.ok(snapshots.some(event=>event.code==="REMOTE_ACCESS_ENDED"));
  console.log("PASS: real Next API + plugin transport + synthetic model; notes policy, idempotency, live content, history and revocation. No personal notes or paid models used.");
} finally {
  abort.abort();modelServer.closeAllConnections();modelServer.close();
  if(child.pid){if(process.platform==="win32")spawnSync("taskkill",["/PID",String(child.pid),"/T","/F"],{windowsHide:true,stdio:"ignore"});else child.kill("SIGTERM");}
}
