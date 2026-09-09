import {expect,it} from "vitest";
import {ReplyContexts,replyKey} from "../src/reply-contexts";
it("binds suggested changes to the exact reply, never the newest note snapshot",()=>{
 const contexts=new ReplyContexts();const note={path:"note.md",text:"original",original:"original"};
 const before={messages:[],entryIds:[]};contexts.begin("session","question",[note],before);
 const first={messages:[{role:"user",content:"question"},{role:"assistant",content:"answer"}],entryIds:["u1","a1"]};contexts.observe("session",first);
 contexts.begin("session","another",[{...note,text:"changed",original:"changed"}],first);
 expect(contexts.get(replyKey("session",first,1),"note.md")?.original).toBe("original");
 expect(contexts.get(replyKey("other",first,1),"note.md")).toBeUndefined();
});
it("does not attach context to other clients' prompts or preexisting history",()=>{
 const contexts=new ReplyContexts();const history={messages:[{role:"user",content:"question"},{role:"assistant",content:"old"}],entryIds:["u1","a1"]};
 contexts.begin("session","question",[{path:"note.md",text:"x",original:"x"}],history);contexts.observe("session",history);
 expect(contexts.get(replyKey("session",history,1),"note.md")).toBeUndefined();
 const external={messages:[...history.messages,{role:"user",content:"unrelated"},{role:"assistant",content:"external"}],entryIds:["u1","a1","u2","a2"]};contexts.observe("session",external);
 expect(contexts.get(replyKey("session",external,3),"note.md")).toBeUndefined();
});
