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
  // 内核实例显示名（可选，默认 CF-WORKER；preview 环境用不同名字便于区分）
  EASYTIER_INSTANCE_NAME?: string;
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
    instanceName: env.EASYTIER_INSTANCE_NAME || "CF-WORKER",
    hostname: env.EASYTIER_INSTANCE_NAME || "CF-WORKER",
    encryption: env.EASYTIER_ENABLE_ENCRYPTION !== "false",
    // 严格私有模式：网络名/密码不匹配的外部连接在内核握手层直接拒绝
    privateMode: true,
    // 拒绝所有"外部网络"中继（即使密码相同但网络名不同也不放行）
    relayNetworkWhitelist: "",
  }),
});

export class EasyTierCoreObject extends easytier.DurableObject {}

// ---------------------------------------------------------------------------
// easytier-cli 命令透传：GET /<token>/<cmd>
// 令牌持有者可查询内核只读状态（对等节点 / 路由 / 连接器 / 本机信息），
// 写操作类命令不提供。实现：worker 编码 protobuf 请求 → DO 内核 RPC（guest
// management-rpc ABI）→ 解码响应为 JSON。
// ---------------------------------------------------------------------------

// ---- 最小 protobuf 编解码（仅需覆盖 api.instance 管理消息的字段） ----

interface FieldVisitorView {
  bytes: Uint8Array;
}

type FieldVisitor = (
  field: number,
  wire: number,
  view: FieldVisitorView,
) => void;

function forEachField(encoded: Uint8Array, visit: FieldVisitor): void {
  let offset = 0;
  while (offset < encoded.length) {
    const [key, afterKey] = readVarint(encoded, offset);
    const field = Math.floor(key / 8);
    const wire = key % 8;
    offset = afterKey;
    if (wire === 0) {
      const [, next] = readVarint(encoded, offset);
      offset = next;
      visit(field, wire, { bytes: new Uint8Array() });
    } else if (wire === 1) {
      offset += 8;
      visit(field, wire, { bytes: new Uint8Array() });
    } else if (wire === 2) {
      const [size, next] = readVarint(encoded, offset);
      offset = next;
      visit(field, wire, { bytes: encoded.subarray(offset, offset + size) });
      offset += size;
    } else if (wire === 5) {
      offset += 4;
      visit(field, wire, { bytes: new Uint8Array() });
    } else {
      throw new Error(`unsupported protobuf wire type ${wire}`);
    }
  }
}

function readVarint(buffer: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let position = offset;
  for (;;) {
    const byte = buffer[position];
    if (byte === undefined) {
      throw new Error("protobuf data ended inside a varint");
    }
    position += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return [value, position];
    }
    shift += 7;
    if (shift > 63) {
      throw new Error("protobuf varint is too long");
    }
  }
}

function appendVarint(target: number[], value: number): void {
  let current = value;
  while (current >= 0x80) {
    target.push((current & 0x7f) | 0x80);
    current = Math.floor(current / 128);
  }
  target.push(current);
}

function encodeLengthDelimited(field: number, payload: Uint8Array): number[] {
  const out: number[] = [];
  appendVarint(out, field * 8 + 2);
  appendVarint(out, payload.length);
  return out;
}

/** 编码 common.DirectRpcRequest：1 方法名(string)，2 请求(bytes)，3 超时(uint64) */
function encodeDirectRpcRequest(
  fullMethodName: string,
  request: Uint8Array,
  timeoutMs: number,
): Uint8Array {
  const name = new TextEncoder().encode(fullMethodName);
  const out: number[] = [];
  out.push(...encodeLengthDelimited(1, name), ...name);
  out.push(...encodeLengthDelimited(2, request));
  appendVarint(out, 3 * 8 + 0);
  appendVarint(out, timeoutMs);
  return new Uint8Array(out);
}

/** 解包 common.RpcResponse：1 响应(bytes)，2 错误(Error)，3 耗时(uint64) */
function decodeRpcEnvelope(encoded: Uint8Array): Uint8Array {
  let response: Uint8Array | undefined;
  let errorText: string | undefined;
  forEachField(encoded, (field, wire, view) => {
    if (field === 1 && wire === 2) {
      response = view.bytes;
    } else if (field === 2 && wire === 2) {
      errorText = firstErrorString(view.bytes) ?? errorText;
    }
  });
  if (errorText !== undefined) {
    throw new Error(`内核 RPC 错误: ${errorText}`);
  }
  if (response === undefined) {
    throw new Error("内核 RPC 响应缺少 payload");
  }
  return response;
}

/**
 * 提取 error.Error 的文本：Error{1..8: 变体子消息}，变体子消息的字段 1/2
 * 携带错误字符串。子消息以 tag 字节开头（<0x20），据此区分文本与嵌套消息，
 * 最多下钻两层。
 */
function firstErrorString(error: Uint8Array): string | undefined {
  let text: string | undefined;
  forEachField(error, (field, wire, view) => {
    if (text !== undefined || wire !== 2 || (field !== 1 && field !== 2)) {
      return;
    }
    const decoded = new TextDecoder().decode(view.bytes);
    if (isPrintable(decoded)) {
      text = decoded;
      return;
    }
    // 变体子消息：再下钻一层取其字符串字段
    let nested: string | undefined;
    forEachField(view.bytes, (innerField, innerWire, innerView) => {
      if (
        nested !== undefined ||
        innerWire !== 2 ||
        (innerField !== 1 && innerField !== 2)
      ) {
        return;
      }
      const inner = new TextDecoder().decode(innerView.bytes);
      if (isPrintable(inner)) {
        nested = inner;
      }
    });
    text = nested;
  });
  return text;
}

function isPrintable(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

// ---- 声明式消息解码（显式字段号 → JSON 键） ----

interface FieldSpec {
  field: number;
  name: string;
  kind: "varint" | "bool" | "float" | "string" | "ipv4" | "ipv6" | "uuid" | "message";
  repeated?: boolean;
  spec?: FieldSpec[];
}

function decodeMessageAt(
  encoded: Uint8Array,
  spec: FieldSpec[],
  start: number,
  end: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const assign = (name: string, value: unknown, repeated?: boolean) => {
    if (repeated) {
      const list = result[name];
      if (Array.isArray(list)) {
        list.push(value);
      } else {
        result[name] = [value];
      }
    } else {
      result[name] = value;
    }
  };
  let offset = start;
  while (offset < end) {
    const [key, afterKey] = readVarint(encoded, offset);
    const field = Math.floor(key / 8);
    const wire = key % 8;
    offset = afterKey;
    const entry = spec.find((s) => s.field === field);
    if (entry === undefined) {
      // 跳过未知字段
      if (wire === 0) {
        offset = readVarint(encoded, offset)[1];
      } else if (wire === 1) {
        offset += 8;
      } else if (wire === 2) {
        const [size, next] = readVarint(encoded, offset);
        offset = next + size;
      } else if (wire === 5) {
        offset += 4;
      } else {
        throw new Error(`unsupported protobuf wire type ${wire}`);
      }
      continue;
    }
    switch (entry.kind) {
      case "varint": {
        const [value, next] = readVarint(encoded, offset);
        offset = next;
        assign(entry.name, value, entry.repeated);
        break;
      }
      case "bool": {
        const [value, next] = readVarint(encoded, offset);
        offset = next;
        assign(entry.name, value !== 0);
        break;
      }
      case "float": {
        // wire 5：fixed32 little-endian float
        const bytes = encoded.subarray(offset, offset + 4);
        const view = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        );
        offset += 4;
        assign(entry.name, view.getFloat32(0, true));
        break;
      }
      case "string": {
        const [size, next] = readVarint(encoded, offset);
        const text = new TextDecoder().decode(
          encoded.subarray(next, next + size),
        );
        offset = next + size;
        assign(entry.name, text, entry.repeated);
        break;
      }
      case "ipv4": {
        // Ipv4Inet{1: Ipv4Addr{1: uint32 addr}, 2: prefix}
        const [size, next] = readVarint(encoded, offset);
        const sub = encoded.subarray(next, next + size);
        offset = next + size;
        let addr = 0;
        let prefix = 0;
        let cursor = 0;
        while (cursor < sub.length) {
          const [k, kNext] = readVarint(sub, cursor);
          const f = Math.floor(k / 8);
          const w = k % 8;
          if (f === 1 && w === 2) {
            // Ipv4Addr 子消息{1: uint32 addr}
            const [msgSize, msgNext] = readVarint(sub, kNext);
            const msg = sub.subarray(msgNext, msgNext + msgSize);
            let inner = 0;
            while (inner < msg.length) {
              const [ik, ikNext] = readVarint(msg, inner);
              if (Math.floor(ik / 8) === 1 && ik % 8 === 0) {
                const [v, vNext] = readVarint(msg, ikNext);
                addr = v;
                inner = vNext;
              } else {
                inner = skipField(msg, inner, ik % 8);
              }
            }
            cursor = msgNext + msgSize;
          } else if (f === 2 && w === 0) {
            const [v, vNext] = readVarint(sub, kNext);
            prefix = v;
            cursor = vNext;
          } else {
            cursor = skipField(sub, cursor, w);
          }
        }
        assign(
          entry.name,
          `${(addr >>> 24) & 0xff}.${(addr >>> 16) & 0xff}.${(addr >>> 8) & 0xff}.${addr & 0xff}${prefix ? `/${prefix}` : ""}`,
        );
        break;
      }
      case "ipv6": {
        // Ipv6Inet{1: Ipv6Addr{1-4: uint32 part}, 2: prefix} —— 显示为 hex 压缩前缀
        const [size, next] = readVarint(encoded, offset);
        const sub = encoded.subarray(next, next + size);
        offset = next + size;
        const parts: number[] = [];
        let prefix = 0;
        let cursor = 0;
        while (cursor < sub.length) {
          const [k, kNext] = readVarint(sub, cursor);
          const f = Math.floor(k / 8);
          const w = k % 8;
          if (f === 1 && w === 2) {
            const [size2, next2] = readVarint(sub, kNext);
            const addr = sub.subarray(next2, next2 + size2);
            let inner = 0;
            while (inner < addr.length) {
              const [ik, ikNext] = readVarint(addr, inner);
              if (Math.floor(ik / 8) >= 1 && ik % 8 === 0) {
                const [v, vNext] = readVarint(addr, ikNext);
                parts.push(v >>> 0);
                inner = vNext;
              } else {
                inner = skipField(addr, inner, ik % 8);
              }
            }
            cursor = next2 + size2;
          } else if (f === 2 && w === 0) {
            const [v, vNext] = readVarint(sub, kNext);
            prefix = v;
            cursor = vNext;
          } else {
            cursor = skipField(sub, cursor, w);
          }
        }
        const text = parts.length
          ? parts
              .map((p) => p.toString(16))
              .join(":")
              .replace(/(^|:)(0(:0)+)(:|$)/, "::")
          : "";
        assign(entry.name, prefix ? `${text}/${prefix}` : text);
        break;
      }
      case "uuid": {
        // UUID{1-4: uint32 part}
        const [size, next] = readVarint(encoded, offset);
        const sub = encoded.subarray(next, next + size);
        offset = next + size;
        const parts: number[] = [];
        let cursor = 0;
        while (cursor < sub.length) {
          const [k, kNext] = readVarint(sub, cursor);
          if (k % 8 === 0) {
            const [v, vNext] = readVarint(sub, kNext);
            parts.push(v >>> 0);
            cursor = vNext;
          } else {
            cursor = skipField(sub, cursor, k % 8);
          }
        }
        if (parts.length === 4) {
          const hex = (v: number) => (v >>> 0).toString(16).padStart(8, "0");
          const p0 = hex(parts[0] ?? 0);
          const p1 = hex(parts[1] ?? 0);
          const p2 = hex(parts[2] ?? 0);
          const p3 = hex(parts[3] ?? 0);
          const raw =
            p0 +
            p1.slice(0, 4) +
            "-" +
            p1.slice(4) +
            "-" +
            p2.slice(0, 4) +
            "-" +
            p2.slice(4) +
            "-" +
            p3.slice(0, 12);
          assign(entry.name, raw);
        }
        break;
      }
      case "message": {
        const [size, next] = readVarint(encoded, offset);
        const sub = decodeMessageAt(
          encoded,
          entry.spec ?? [],
          next,
          next + size,
        );
        offset = next + size;
        assign(entry.name, sub, entry.repeated);
        break;
      }
    }
  }
  return result;
}

function skipField(
  buffer: Uint8Array,
  offset: number,
  wire: number,
): number {
  if (wire === 0) {
    return readVarint(buffer, offset)[1];
  }
  if (wire === 1) {
    return offset + 8;
  }
  if (wire === 2) {
    const [size, next] = readVarint(buffer, offset);
    return next + size;
  }
  if (wire === 5) {
    return offset + 4;
  }
  throw new Error(`unsupported protobuf wire type ${wire}`);
}

// ---- api.instance 消息结构（easytier-proto/proto/api_instance.proto） ----

const URL_SPEC: FieldSpec[] = [{ field: 1, kind: "string", name: "url" }];

const TUNNEL_INFO_SPEC: FieldSpec[] = [
  { field: 1, kind: "string", name: "tunnel_type" },
  { field: 2, kind: "message", name: "local_addr", spec: URL_SPEC },
  { field: 3, kind: "message", name: "remote_addr", spec: URL_SPEC },
  { field: 4, kind: "message", name: "resolved_remote_addr", spec: URL_SPEC },
];

const PEER_CONN_STATS_SPEC: FieldSpec[] = [
  { field: 1, kind: "varint", name: "rx_bytes" },
  { field: 2, kind: "varint", name: "tx_bytes" },
  { field: 3, kind: "varint", name: "rx_packets" },
  { field: 4, kind: "varint", name: "tx_packets" },
  { field: 5, kind: "varint", name: "latency_us" },
];

const PEER_CONN_INFO_SPEC: FieldSpec[] = [
  { field: 1, kind: "string", name: "conn_id" },
  { field: 2, kind: "varint", name: "my_peer_id" },
  { field: 3, kind: "varint", name: "peer_id" },
  { field: 4, kind: "string", name: "features", repeated: true },
  { field: 5, kind: "message", name: "tunnel", spec: TUNNEL_INFO_SPEC },
  { field: 6, kind: "message", name: "stats", spec: PEER_CONN_STATS_SPEC },
  { field: 7, kind: "float", name: "loss_rate" },
  { field: 8, kind: "bool", name: "is_client" },
  { field: 9, kind: "string", name: "network_name" },
  { field: 10, kind: "bool", name: "is_closed" },
];

const PEER_INFO_SPEC: FieldSpec[] = [
  { field: 1, kind: "varint", name: "peer_id" },
  { field: 2, kind: "message", name: "conns", spec: PEER_CONN_INFO_SPEC, repeated: true },
  { field: 3, kind: "uuid", name: "default_conn_id" },
  { field: 4, kind: "uuid", name: "directly_connected_conns", repeated: true },
];

const STUN_INFO_SPEC: FieldSpec[] = [
  { field: 1, kind: "varint", name: "udp_nat_type" },
  { field: 2, kind: "varint", name: "tcp_nat_type" },
  { field: 3, kind: "varint", name: "last_update_time" },
  { field: 4, kind: "string", name: "public_ip", repeated: true },
  { field: 5, kind: "varint", name: "min_port" },
  { field: 6, kind: "varint", name: "max_port" },
];

const NODE_INFO_SPEC: FieldSpec[] = [
  { field: 1, kind: "varint", name: "peer_id" },
  { field: 2, kind: "string", name: "ipv4_addr" },
  { field: 3, kind: "string", name: "proxy_cidrs", repeated: true },
  { field: 4, kind: "string", name: "hostname" },
  { field: 5, kind: "message", name: "stun_info", spec: STUN_INFO_SPEC },
  { field: 6, kind: "string", name: "inst_id" },
  { field: 7, kind: "string", name: "listeners", repeated: true },
  { field: 9, kind: "string", name: "version" },
  { field: 12, kind: "ipv6", name: "public_ipv6_addr" },
];

const ROUTE_SPEC: FieldSpec[] = [
  { field: 1, kind: "varint", name: "peer_id" },
  { field: 2, kind: "ipv4", name: "ipv4_addr" },
  { field: 3, kind: "varint", name: "next_hop_peer_id" },
  { field: 4, kind: "varint", name: "cost" },
  { field: 5, kind: "string", name: "proxy_cidrs", repeated: true },
  { field: 6, kind: "string", name: "hostname" },
  { field: 7, kind: "message", name: "stun_info", spec: STUN_INFO_SPEC },
  { field: 9, kind: "string", name: "version" },
  { field: 11, kind: "varint", name: "path_latency" },
  { field: 15, kind: "ipv6", name: "ipv6_addr" },
];

const CONNECTOR_SPEC: FieldSpec[] = [
  { field: 1, kind: "message", name: "url", spec: URL_SPEC },
  { field: 2, kind: "varint", name: "status" },
];

// ---- CLI 命令表（只读；写操作类命令默认不提供） ----

const EMPTY_REQUEST = new Uint8Array(0);

const CLI_COMMANDS: Record<
  string,
  { method: string; decode: (bytes: Uint8Array) => unknown }
> = {
  peer: {
    method: "api.instance.PeerManageRpc.ListPeer",
    decode: (bytes) => {
      const decoded = decodeMessageAt(bytes, [
        { field: 1, kind: "message", name: "peers", spec: PEER_INFO_SPEC, repeated: true },
        { field: 2, kind: "message", name: "my_info", spec: NODE_INFO_SPEC },
      ], 0, bytes.length);
      return { peers: decoded.peers ?? [], my_info: decoded.my_info ?? null };
    },
  },
  route: {
    method: "api.instance.PeerManageRpc.ListRoute",
    decode: (bytes) => {
      const decoded = decodeMessageAt(bytes, [
        { field: 1, kind: "message", name: "routes", spec: ROUTE_SPEC, repeated: true },
      ], 0, bytes.length);
      return { routes: decoded.routes ?? [] };
    },
  },
  connector: {
    method: "api.instance.ConnectorManageRpc.ListConnector",
    decode: (bytes) => {
      const decoded = decodeMessageAt(bytes, [
        { field: 1, kind: "message", name: "connectors", spec: CONNECTOR_SPEC, repeated: true },
      ], 0, bytes.length);
      return {
        connectors: ((decoded.connectors as Array<Record<string, unknown>>) ?? []).map((c) => {
          const connector = c as Record<string, unknown>;
          const statusName = ["CONNECTED", "DISCONNECTED", "CONNECTING"][
            Number(connector.status ?? 0)
          ];
          return { ...connector, status: statusName ?? connector.status };
        }),
      };
    },
  },
  node: {
    method: "api.instance.PeerManageRpc.ShowNodeInfo",
    decode: (bytes) => {
      const decoded = decodeMessageAt(bytes, [
        { field: 1, kind: "message", name: "node_info", spec: NODE_INFO_SPEC },
      ], 0, bytes.length);
      return { node_info: decoded.node_info ?? null };
    },
  },
};

const CLI_RPC_TIMEOUT_MS = 10_000;

async function handleCliRequest(
  request: Request,
  env: Env,
  command: string,
): Promise<Response> {
  const definition = CLI_COMMANDS[command];
  if (definition === undefined) {
    return Response.json(
      {
        ok: false,
        error: `unknown command: ${command}`,
        available: Object.keys(CLI_COMMANDS),
      },
      { status: 404 },
    );
  }

  // 请求经内部 header 转发进 DO，由内核 management-rpc ABI 执行
  const body = encodeDirectRpcRequest(
    definition.method,
    EMPTY_REQUEST,
    CLI_RPC_TIMEOUT_MS,
  );
  const forwarded = new Request(request.url, {
    method: "POST",
    headers: {
      "x-easytier-rpc": definition.method,
      "content-type": "application/octet-stream",
    },
    body: body as unknown as BodyInit,
  });
  const objectName =
    env.EASYTIER_OBJECT_NAME || new URL(request.url).hostname;
  const response = await env.EASYTIER_CORE.getByName(objectName).fetch(forwarded);

  if (!response.ok) {
    const detail = await response.text();
    return Response.json(
      { ok: false, error: `内核 RPC 调用失败 (${response.status}): ${detail}` },
      { status: 502 },
    );
  }

  const encoded = new Uint8Array(await response.arrayBuffer());
  let payload: Record<string, unknown>;
  try {
    payload = definition.decode(decodeRpcEnvelope(encoded)) as Record<string, unknown>;
  } catch (error) {
    const hex = Array.from(encoded)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return Response.json(
      { ok: false, error: String(error), raw_hex: hex.slice(0, 2048) },
      { status: 502 },
    );
  }
  return Response.json(
    { ok: true, command, ...payload },
    { headers: { "cache-control": "no-store" } },
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const isWs = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    const segments = url.pathname.split("/").filter(Boolean);

    if (!isWs && segments.length >= 2) {
      // easytier-cli 命令透传：第一段是访问令牌，第二段是子命令
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405 });
      }
      const expected = env.EASYTIER_ACCESS_TOKEN;
      if (expected && segments[0] !== expected) {
        return new Response("Forbidden", { status: 403 });
      }
      if (!isAllowedGeo(request, env)) {
        return new Response("Forbidden", { status: 403 });
      }
      return handleCliRequest(request, env, segments[1] ?? "");
    }

    if (isWs) {
      // 私人模式第一层：访问令牌校验（不匹配直接拒绝，不进入 EasyTier 握手）
      // 支持两种携带方式（兼容各类客户端）：
      //   1. 路径式：wss://host/<token>
      //   2. 查询式：wss://host/?token=<token>
      const expected = env.EASYTIER_ACCESS_TOKEN;
      if (expected) {
        const pathToken = segments[0] ?? "";
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
