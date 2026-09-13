import {expect,it} from "vitest";
import {LiveStateGate} from "../src/live-state";
it("accepts bounded tool lifecycle fields only after protocol negotiation",()=>{
  const gate=new LiveStateGate("session",true);const connection=gate.openStream();
  const toolCalls=[{toolCallId:"call",toolName:"read",status:"running",output:"x".repeat(3000),truncated:false,args:{secret:"private"}},{toolCallId:"bad",toolName:"bash",status:"unknown",output:"no"}];
  const accepted=gate.accept({...frame("run",1),toolCalls,omittedToolCalls:4},connection)!;
  expect(accepted.toolCalls).toEqual([{toolCallId:"call",toolName:"read",status:"running",output:"x".repeat(2000),truncated:true}]);expect(accepted.omittedToolCalls).toBe(4);
  expect(gate.accept({...frame(null,2),toolCalls},connection)?.toolCalls).toEqual([]);
  const legacy=new LiveStateGate("session");expect(legacy.accept({...frame("run",1),toolCalls},legacy.openStream())?.toolCalls).toEqual([]);
});

function frame(runId:string|null,sequence:number,streamId="wrapper-one"):Record<string,unknown> {
  return {type:"content.snapshot",sessionId:"session",streamId,runId,sequence,running:runId!==null,text:runId??"",tools:["read"]};
}
it("accepts ordered current frames and rejects duplicates, regressions and foreign sessions",()=>{
  const gate=new LiveStateGate("session");const connection=gate.openStream();expect(gate.accept(frame("first",4),connection)?.text).toBe("first");
  expect(gate.accept(frame("first",4),connection)).toBeUndefined();expect(gate.accept(frame("first",3),connection)).toBeUndefined();
  expect(gate.accept({...frame("first",5),sessionId:"other"},connection)).toBeUndefined();
});
it("retires completed runs so a late frame cannot resurrect their text",()=>{
  const gate=new LiveStateGate("session");const connection=gate.openStream();gate.accept(frame("old",1),connection);gate.accept(frame("new",2),connection);
  expect(gate.accept(frame("old",3),connection)).toBeUndefined();expect(gate.reconcile({runtime:"running",activeRunId:"old"})).toBe(false);
  gate.reconcile({runtime:"idle"});expect(gate.accept(frame("new",4),connection)).toBeUndefined();
});
it("allows a restarted wrapper only on a new connection, never from a retired callback",()=>{
  const gate=new LiveStateGate("session");const oldConnection=gate.openStream();gate.accept(frame("old",50),oldConnection);
  expect(gate.accept(frame("new",1,"wrapper-two"),oldConnection)).toBeUndefined();
  const connection=gate.openStream();expect(gate.accept(frame("new",1,"wrapper-two"),connection)?.runId).toBe("new");
  expect(gate.accept(frame("old",99),oldConnection)).toBeUndefined();
  const reconnect=gate.openStream();expect(gate.accept(frame("old",100),reconnect)).toBeUndefined();
});
it("clears tools and text on idle and rejects malformed identity",()=>{
  const gate=new LiveStateGate("session");const connection=gate.openStream();gate.accept(frame("run",1),connection);
  expect(gate.accept({...frame(null,2),text:"stale",tools:["old"]},connection)).toMatchObject({text:"",tools:[],running:false});
  expect(gate.accept({...frame("next",3),sequence:NaN},connection)).toBeUndefined();
  expect(gate.accept({...frame("next",3),running:false},connection)).toBeUndefined();
});
it("revisions expose frame changes so older HTTP responses can be fenced",()=>{
  const gate=new LiveStateGate("session");const connection=gate.openStream();const before=gate.revision;gate.accept(frame("run",1),connection);expect(gate.revision).toBeGreaterThan(before);
  const current=gate.revision;gate.accept(frame("run",1),connection);expect(gate.revision).toBe(current);
});
