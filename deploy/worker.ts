// 私人 EasyTier wss 中继/握手节点
// CI 中此文件会被复制到 EasyTier/easytier-js/cloudflare/ 包根目录，
// 因此用相对路径引用包内源码。
import { createEasyTierCloudflare } from "./src/index";

interface Env {
  EASYTIER_CORE: DurableObjectNamespace;
  EASYTIER_OBJECT_NAME: string;
  EASYTIER_NETWORK_NAME: string;
  EASYTIER_NETWORK_SECRET: string;
  EASYTIER_ENABLE_ENCRYPTION: string;
  // 私人模式访问令牌（Secret）：WebSocket 升级必须携带 ?token=<值>，否则 403
  EASYTIER_ACCESS_TOKEN: string;
  // IP 白名单（逗号分隔，由 GitHub 仓库变量 WAF_IP_WHITELIST 注入）：非 CN 来源仅允许名单内 IP
  EASYTIER_IP_WHITELIST: string;
}

// 允许接入的地区（ISO 3166-1 alpha-2）
const ALLOWED_COUNTRY = "CN";

function ipWhitelist(env: Env): string[] {
  return (env.EASYTIER_IP_WHITELIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowedGeo(request: Request, env: Env): boolean {
  const ip = request.headers.get("CF-Connecting-IP") ?? "";
  if (ipWhitelist(env).includes(ip)) return true;
  const country = (request as unknown as { cf?: { country?: string } }).cf?.country;
  return country === ALLOWED_COUNTRY;
}

const easytier = createEasyTierCloudflare<Env>({
  namespace: (env) => env.EASYTIER_CORE,
  // 单网络固定用 "primary"；如需多个网络，可按域名路由不同 Durable Object：
  // objectName: (request, env) => env.EASYTIER_OBJECT_NAME ?? new URL(request.url).hostname,
  objectName: (request, env) =>
    env.EASYTIER_OBJECT_NAME ?? new URL(request.url).hostname,
  config: (env) => ({
    networkName: env.EASYTIER_NETWORK_NAME,
    networkSecret: env.EASYTIER_NETWORK_SECRET,
    // instance_name 是实例管理名；hostname 才是客户端"对等节点"里显示的主机名
    instanceName: "CF-WORKER",
    hostname: "CF-WORKER",
    encryption: env.EASYTIER_ENABLE_ENCRYPTION !== "false",
    // 严格私有模式：网络名/密码不匹配的外部连接在内核握手层直接拒绝
    privateMode: true,
    // 拒绝所有"外部网络"中继（即使密码相同但网络名不同也不放行）
    relayNetworkWhitelist: "",
  }),
});

export class EasyTierCoreObject extends easytier.DurableObject {}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isWs = request.headers.get("Upgrade")?.toLowerCase() === "websocket";

    if (isWs) {
      // 私人模式第一层：访问令牌校验（不匹配直接拒绝，不进入 EasyTier 握手）
      // 支持两种携带方式（兼容各类客户端）：
      //   1. 路径式：wss://host/<token>
      //   2. 查询式：wss://host/?token=<token>
      const expected = env.EASYTIER_ACCESS_TOKEN;
      if (expected) {
        const pathToken = url.pathname.split("/").filter(Boolean)[0] ?? "";
        const provided = url.searchParams.get("token") ?? pathToken;
        if (provided !== expected) {
          return new Response("Forbidden", { status: 403 });
        }
      }
      // 私人模式第二层：仅允许 CN 来源或白名单 IP 建立隧道
      if (!isAllowedGeo(request, env)) {
        return new Response("Forbidden", { status: 403 });
      }
      // 第三层：EasyTier 内核握手校验 network_name + network_secret，不匹配即断开
    }

    return easytier.fetch(request, env, ctx);
  },
};
