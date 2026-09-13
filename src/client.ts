import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { checkRequest, isServerId, normalizeAddress, SseParser } from "./core";

const creationErrors:Record<string,{status:number;message:string}>={
  REMOTE_CREATION_CONFLICT:{status:409,message:"创建参数与已保存记录不一致，请恢复原请求；不要直接换新键创建"},
  REMOTE_CREATION_INVALID:{status:500,message:"服务端创建记录无法安全恢复，请先到 Piora 核对，不要重复新建"},
  REMOTE_CREATION_BUSY:{status:503,message:"服务端仍在处理创建，请稍后使用原请求重试"},
};

export class ApiError extends Error {
  constructor(public status: number, public code: string, public retryAfterMs = 0) {
    super(status === 401 ? "令牌无效或已过期，请重新连接" : status === 403 ? "令牌没有操作此会话的权限" : status === 429 ? "请求过于频繁，稍后重试" : "Piora 请求失败（" + status + " / " + code + "）");
    if(Object.hasOwn(creationErrors,code)&&creationErrors[code].status===status)this.message=creationErrors[code].message;
  }
}
export class RemoteClient {
  private serverId?:string;
  constructor(public readonly address: string, private token: () => string) { this.address = normalizeAddress(address); }
  pinServer(serverId:string):void {if(!isServerId(serverId))throw new Error("无效服务身份");if(this.serverId&&this.serverId!==serverId)throw new Error("不能更改已绑定的服务实例");this.serverId=serverId;}
  async identify(signal?:AbortSignal):Promise<string> {
    const text=await this.exchange("/identity",{anonymous:true,signal,maxResponseBytes:4096});
    let value;try{value=JSON.parse(text);}catch{throw new Error("服务未提供有效身份，请更新 Piora");}
    if(value?.protocol!=="piora.remote.v1"||!isServerId(value?.serverId))throw new Error("服务未提供有效身份，请更新 Piora");
    return value.serverId;
  }
  private async exchange(path: string, options: { body?: unknown; key?: string; capabilityId?:string; signal?: AbortSignal; onData?: (text: string) => void; anonymous?:boolean;maxResponseBytes?:number }): Promise<string> {
    if (!path.startsWith("/") || path.startsWith("//") || /[\\#]/.test(path)) throw new Error("无效 API 路径");
    const url = new URL(this.address + path);
    if (url.origin !== new URL(this.address).origin || !url.pathname.startsWith("/api/remote/v1/")) throw new Error("路径超出 Remote API 范围");
    if(!options.anonymous&&this.serverId&&await this.identify(options.signal)!==this.serverId){const error=new ApiError(403,"REMOTE_SERVER_CHANGED");error.message="Piora 服务实例已变化；未发送令牌，请核对并更换实例绑定";throw error;}
    const token = options.anonymous?"":this.token().trim();
    if (!options.anonymous&&(!token || /\s/.test(token))) throw new Error("请先填写有效令牌");
    const body = options.body === undefined ? undefined : checkRequest(options.body);
    return new Promise((resolve, reject) => {
      let done = false;
      let data = "";
      let received = 0;
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: body === undefined ? "GET" : "POST",
        agent: false,
        headers: { ...(options.anonymous?{}:{Authorization: "Bearer " + token,...(this.serverId?{"X-Piora-Server-Id":this.serverId}:{}),...(options.capabilityId?{"X-Piora-Capability-Id":options.capabilityId}:{})}), Accept: options.onData ? "text/event-stream" : "application/json", ...(body === undefined ? {} : {"Content-Type":"application/json", "Content-Length":Buffer.byteLength(body)}), ...(options.key ? {"Idempotency-Key":options.key} : {}) },
      });
      const finish = (error?: Error) => {
        if (done) return;
        done = true; clearTimeout(deadline); options.signal?.removeEventListener("abort", abort); request.destroy();
        if (error) reject(error); else resolve(data);
      };
      const abort = () => finish(options.onData ? undefined : new Error("请求已取消"));
      const deadline = setTimeout(() => finish(new Error("连接超时；若已发送消息，请使用重试而非重复发送")), options.onData ? 45000 : 90000);
      request.on("response", response => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          const retry = response.headers["retry-after"];
          const delay = typeof retry === "string" ? (/^\d+$/.test(retry) ? Number(retry)*1000 : Math.max(0, Date.parse(retry)-Date.now())) : 0;
          let errorBody="";let errorBytes=0;
          const fail=(code="HTTP_ERROR")=>finish(new ApiError(status,code,Number.isFinite(delay)?delay:0));
          response.setEncoding("utf8");
          response.on("data",(chunk:string)=>{if(done)return;errorBytes+=Buffer.byteLength(chunk);if(errorBytes>4096){fail();return;}errorBody+=chunk;});
          response.on("end",()=>{
            let code="HTTP_ERROR";
            try{const value:unknown=JSON.parse(errorBody);if(value&&typeof value==="object"&&"code" in value&&typeof value.code==="string"&&Object.hasOwn(creationErrors,value.code)&&creationErrors[value.code].status===status)code=value.code;}catch{}
            fail(code);
          });
          response.on("error",()=>fail());return;
        }
        if (options.onData && !String(response.headers["content-type"]).startsWith("text/event-stream")) { finish(new Error("服务端未返回事件流")); return; }
        if (options.onData) clearTimeout(deadline);
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (done) return;
          try {
            if (options.onData) options.onData(chunk);
            else { received += Buffer.byteLength(chunk); if (received > (options.maxResponseBytes??16*1024*1024)) throw new Error("响应超过大小限制"); data += chunk; }
          } catch (error) { finish(error instanceof Error ? error : new Error("无法处理响应")); }
        });
        response.on("end", () => finish());
        response.on("error", () => finish(new Error("连接中断，请重新同步")));
      });
      request.on("error", () => finish(new Error("无法连接 Piora，请检查后台服务和端口")));
      request.setTimeout(45000, () => finish(new Error("连接长时间无响应")));
      options.signal?.addEventListener("abort",abort,{once:true});
      if (options.signal?.aborted) { abort(); return; }
      request.end(body);
    });
  }
  async request<T>(path: string, options: { body?: unknown; key?: string; capabilityId?:string; signal?: AbortSignal } = {}): Promise<T> {
    const text = await this.exchange(path,options);
    let value;try { value=JSON.parse(text); } catch { throw new Error("Piora 返回无效 JSON"); }
    if(this.serverId&&path==="/capabilities"&&value?.serverId!==this.serverId)throw new Error("Piora 能力响应的服务身份不一致，拒绝连接");
    return value as T;
  }
  async stream(path: string, onEvent: (event: Record<string, unknown>) => void, signal: AbortSignal): Promise<void> {
    const parser = new SseParser(frame => { const event: unknown = JSON.parse(frame.data); if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("无效事件"); onEvent(event as Record<string,unknown>); });
    await this.exchange(path,{signal,onData:chunk=>parser.feed(chunk)});
  }
}
