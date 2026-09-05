import express from "express";
import type { Express, NextFunction, Request, Response } from "express";

// 独立站(ositplc)后台代理：浏览器→CRM(4188)→独立站(默认:3188)，绕开 CORS，
// 地址只由 INDEPENDENT_SITE_BASE_URL 一处决定（改地址=改 env 重启）。
// ponytail: 通用透传而非逐端点转发——独立站 admin 路径稳定为 /api/admin/*，
// 新增端点(如 media/reviews)无需改这里。上限：依赖独立站 /api/admin 前缀不变。

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

function asyncRoute(handler: Handler) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch(next);
  };
}

const baseUrl = () =>
  (process.env.INDEPENDENT_SITE_BASE_URL || "http://localhost:3188").replace(/\/+$/, "");
const adminEmail = () => process.env.INDEPENDENT_SITE_ADMIN_EMAIL || "admin@ositplc.com";
const adminPassword = () => process.env.INDEPENDENT_SITE_ADMIN_PASSWORD || "admin123";

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAdminToken(force = false): Promise<string> {
  if (!force && cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  const res = await fetch(`${baseUrl()}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: adminEmail(), password: adminPassword() }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`独立站登录失败 HTTP ${res.status}`);
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("独立站登录未返回 token");
  cachedToken = data.token;
  // 独立站 JWT 有效期 8h，缓存 6h 留余量
  tokenExpiresAt = Date.now() + 6 * 3600 * 1000;
  return cachedToken;
}

async function forward(req: Request, res: Response, token: string, raw = false) {
  const [pathPart, queryPart] = req.url.split("?");
  const rest = (pathPart || "").replace(/^\//, "");
  const target = `${baseUrl()}/api/admin/${rest}${queryPart ? `?${queryPart}` : ""}`;
  const doFetch = (auth: string) =>
    fetch(target, {
      method: req.method,
      headers: {
        "Content-Type": raw ? String(req.headers["content-type"] || "application/octet-stream") : "application/json",
        Authorization: `Bearer ${auth}`,
        // 媒体上传文件名透传(独立站 upload 端点靠 X-File-Name)
        ...(raw && req.headers["x-file-name"] ? { "X-File-Name": String(req.headers["x-file-name"]) } : {})
      },
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : raw
            ? new Uint8Array(req.body as Buffer)
            : JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(raw ? 60000 : 15000)
    });
  let upstream = await doFetch(token);
  if (upstream.status === 401) {
    // token 过期：清缓存重登一次
    const fresh = await getAdminToken(true);
    upstream = await doFetch(fresh);
  }
  const text = await upstream.text();
  res.status(upstream.status);
  if (text) res.send(text);
  else res.end();
}

export function registerIndependentSiteRoutes(app: Express) {
  // 媒体上传:raw 字节透传(需放在通用 JSON 代理之前)
  app.post(
    "/api/independent-site/media/upload",
    express.raw({ type: "*/*", limit: "50mb" }),
    asyncRoute(async (req, res) => {
      const token = await getAdminToken();
      req.url = "/media/upload"; // forward 按相对路径拼接 /api/admin/*
      await forward(req, res, token, true);
    })
  );
  app.get("/api/independent-site/status", asyncRoute(async (_req, res) => {
    try {
      const r = await fetch(`${baseUrl()}/api/health`, { signal: AbortSignal.timeout(4000) });
      const data = (await r.json()) as Record<string, unknown>;
      res.json({ online: true, base: baseUrl(), ...data });
    } catch (error) {
      res.json({ online: false, base: baseUrl(), error: String(error) });
    }
  }));

  app.use("/api/independent-site", asyncRoute(async (req, res, next) => {
    const rest = (req.url.split("?")[0] || "").replace(/^\//, "");
    if (!rest) return next(); // 命中 /api/independent-site 本身，交给 404
    const token = await getAdminToken();
    await forward(req, res, token);
  }));
}
