import {readToolCalls,type ToolCall} from "./tool-calls";
export interface LiveFrame {text:string;tools:string[];toolCalls:ToolCall[];omittedToolCalls:number;runId:string|null;running:boolean}
export class LiveStateGate {
  revision=0;
  private connection=0;
  private connectionStream?:string;
  private streamId?:string;
  private sequence=-1;
  private runId:string|null=null;
  private retiredRuns=new Set<string>();
  private retiredStreams=new Set<string>();
  constructor(private sessionId:string,private toolLifecycle=false) {}
  openStream():number {this.connectionStream=undefined;this.revision++;return ++this.connection;}
  private retire(values:Set<string>,value:string,limit:number):void {values.add(value);while(values.size>limit)values.delete(values.values().next().value!);}
  private changeRun(runId:string|null):void {
    if(runId===this.runId)return;
    if(this.runId)this.retire(this.retiredRuns,this.runId,512);
    this.runId=runId;this.revision++;
  }
  accept(frame:Record<string,unknown>,connection:number):LiveFrame|undefined {
    if(connection!==this.connection||frame.sessionId!==this.sessionId||frame.type!=="content.snapshot")return;
    if(typeof frame.streamId!=="string"||!frame.streamId||typeof frame.sequence!=="number"||!Number.isSafeInteger(frame.sequence)||frame.sequence<0)return;
    if(frame.runId!==null&&(typeof frame.runId!=="string"||!frame.runId))return;
    if(typeof frame.running!=="boolean"||frame.running!==(frame.runId!==null)||typeof frame.text!=="string"||!Array.isArray(frame.tools))return;
    if(this.connectionStream&&this.connectionStream!==frame.streamId)return;
    if(this.retiredStreams.has(frame.streamId)||typeof frame.runId==="string"&&this.retiredRuns.has(frame.runId))return;
    if(frame.streamId===this.streamId&&frame.sequence<=this.sequence)return;
    if(frame.streamId!==this.streamId){if(this.streamId)this.retire(this.retiredStreams,this.streamId,32);this.streamId=frame.streamId;this.sequence=-1;}
    this.connectionStream=frame.streamId;this.sequence=frame.sequence;this.changeRun(frame.runId);this.revision++;
    return {runId:frame.runId,running:frame.running,text:frame.running?frame.text.slice(-100000):"",tools:frame.running?frame.tools.filter((name):name is string=>typeof name==="string").slice(-20).map(name=>name.slice(0,100)):[],toolCalls:frame.running&&this.toolLifecycle?readToolCalls(frame.toolCalls):[],omittedToolCalls:frame.running&&this.toolLifecycle&&typeof frame.omittedToolCalls==="number"&&Number.isSafeInteger(frame.omittedToolCalls)&&frame.omittedToolCalls>0?frame.omittedToolCalls:0};
  }
  reconcile(control:{runtime:string;activeRunId?:string}):boolean {
    if(control.activeRunId){if(this.retiredRuns.has(control.activeRunId))return false;this.changeRun(control.activeRunId);}
    else if(control.runtime==="idle")this.changeRun(null);
    return true;
  }
}
