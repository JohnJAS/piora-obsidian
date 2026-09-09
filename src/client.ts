import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { checkRequest, normalizeAddress, SseParser } from "./core";

export class ApiError extends Error {
  constructor(public status: number, public code: string, public retryAfterMs = 0) {
    super(status === 401 ? "令牌无效或已过期，请重新连接" : status === 403 ? "令牌没有操作此会话的权限" : status === 429 ? "请求过于频繁，稍后重试" : "Piora 请求失败（" + status + " / " + code + "）");
  }
}
export class RemoteClient {
  constructor(public address: string, private token: () => string) { this.address = normalizeAddress(address); }
  private async exchange(path: string, options: { body?: unknown; key?: string; signal?: AbortSignal; onData?: (text: string) => void }): Promise<string> {
    if (!path.startsWith("/") || path.startsWith("//") || /[\\#]/.test(path)) throw new Error("无效 API 路径");
    const url = new URL(this.address + path);
    if (url.origin !== new URL(this.address).origin || !url.pathname.startsWith("/api/remote/v1/")) throw new Error("路径超出 Remote API 范围");
    const token = this.token().trim();
    if (!token || /\s/.test(token)) throw new Error("请先填写有效令牌");
    const body = options.body === undefined ? undefined : checkRequest(options.body);
    return new Promise((resolve, reject) => {
      let done = false;
      let data = "";
      let received = 0;
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: body === undefined ? "GET" : "POST",
        agent: false,
        headers: { Authorization: "Bearer " + token, Accept: options.onData ? "text/event-stream" : "application/json", ...(body === undefined ? {} : {"Content-Type":"application/json", "Content-Length":Buffer.byteLength(body)}), ...(options.key ? {"Idempotency-Key":options.key} : {}) },
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
          response.resume(); finish(new ApiError(status,"HTTP_ERROR",Number.isFinite(delay)?delay:0)); return;
        }
        if (options.onData && !String(response.headers["content-type"]).startsWith("text/event-stream")) { finish(new Error("服务端未返回事件流")); return; }
        if (options.onData) clearTimeout(deadline);
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          if (done) return;
          try {
            if (options.onData) options.onData(chunk);
            else { received += Buffer.byteLength(chunk); if (received > 16*1024*1024) throw new Error("响应超过 16 MiB 限制"); data += chunk; }
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
  async request<T>(path: string, options: { body?: unknown; key?: string; signal?: AbortSignal } = {}): Promise<T> {
    const text = await this.exchange(path,options);
    try { return JSON.parse(text) as T; } catch { throw new Error("Piora 返回无效 JSON"); }
  }
  async stream(path: string, onEvent: (event: Record<string, unknown>) => void, signal: AbortSignal): Promise<void> {
    const parser = new SseParser(frame => { const event: unknown = JSON.parse(frame.data); if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("无效事件"); onEvent(event as Record<string,unknown>); });
    await this.exchange(path,{signal,onData:chunk=>parser.feed(chunk)});
  }
}
