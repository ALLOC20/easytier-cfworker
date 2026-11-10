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
  // 内核实例显示名（可选，默认 CF-WORKER；preview 环境用不同名字便于区分）
  EASYTIER_INSTANCE_NAME?: string;
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
            "-" +
            p1.slice(0, 4) +
            "-" +
            p1.slice(4) +
            "-" +
            p2.slice(0, 4) +
            "-" +
            p2.slice(4) +
            "-" +
            p3.slice(0, 12);
          assign(entry.name, raw, entry.repeated);
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

// ---- 浏览器友好渲染（HTML 表格） ----
// curl/wget 等客户端默认 JSON；UA 含 Mozilla 且 Accept 含 text/html 的请求
// 渲染为 HTML 表格。?format=json / ?format=html 可强制指定。

// ---- Rust Debug 输出解析（dump-route 的 result 是 PeerRouteServiceImpl 的单行 Debug 串） ----
// 语法子集：结构体 Name { k: v, ... }、元组结构体 Name(v)、Some(v)/None、
// 列表 [...]、元组 (...)、映射 { k: v }（键可为裸标识/IP/CIDR/字符串）、
// 枚举变体（裸词）、带引号字符串（含转义）。解析失败由调用方回退为原始文本。

function parseRustDebug(text: string): unknown {
  const pos = { index: 0 };

  const ws = () => {
    while (pos.index < text.length && /\s/.test(text[pos.index]!)) pos.index += 1;
  };
  const fail = (why: string): never => {
    throw new Error(`rust-debug parse: ${why} at offset ${pos.index}`);
  };

  function parseString(): string {
    pos.index += 1; // opening quote
    let out = "";
    for (;;) {
      const ch = text[pos.index];
      if (ch === undefined) fail("unterminated string");
      if (ch === '"') {
        pos.index += 1;
        return out;
      }
      if (ch === "\\") {
        pos.index += 1;
        const esc = text[pos.index];
        pos.index += 1;
        if (esc === "n") out += "\n";
        else if (esc === "r") out += "\r";
        else if (esc === "t") out += "\t";
        else if (esc === "0") out += "\0";
        else if (esc === '"' || esc === "\\" || esc === "'") out += esc;
        else if (esc === "u") {
          if (text[pos.index] !== "{") fail("invalid \\u escape");
          pos.index += 1;
          const start = pos.index;
          while (text[pos.index] !== "}") pos.index += 1;
          out += String.fromCodePoint(parseInt(text.slice(start, pos.index), 16));
          pos.index += 1;
        } else fail(`unknown escape \\${esc ?? ""}`);
        continue;
      }
      out += ch;
      pos.index += 1;
    }
  }

  function parseValue(): unknown {
    ws();
    const ch = text[pos.index];
    if (ch === undefined) fail("unexpected end of input");
    if (ch === '"') return parseString();
    if (ch === "[") {
      pos.index += 1;
      const list: unknown[] = [];
      ws();
      if (text[pos.index] === "]") {
        pos.index += 1;
        return list;
      }
      for (;;) {
        list.push(parseValue());
        ws();
        if (text[pos.index] === ",") pos.index += 1;
        else if (text[pos.index] === "]") {
          pos.index += 1;
          return list;
        } else fail("expected , or ] in list");
      }
    }
    if (ch === "(") {
      pos.index += 1;
      return parseValueList(")");
    }
    if (ch === "{") {
      pos.index += 1;
      return parseFields();
    }
    let end = pos.index;
    while (end < text.length && !/[\s,()[\]{}:]/.test(text[end]!)) end += 1;
    if (end === pos.index) fail("expected a value");
    const token = text.slice(pos.index, end);
    pos.index = end;
    if (token === "None") return null;
    if (token === "true") return true;
    if (token === "false") return false;
    // 整数超过 Number 安全范围时保留字符串（如纳秒时间戳）
    if (/^-?\d+$/.test(token)) return token.length <= 15 ? Number(token) : token;
    if (/^-?\d+\.\d+$/.test(token)) return Number(token);
    ws();
    if (text[pos.index] === "(") {
      pos.index += 1;
      const inner = parseValueList(")");
      if (token === "Some") return inner;
      return { "#type": token, "#value": inner };
    }
    if (text[pos.index] === "{") {
      pos.index += 1;
      return { "#type": token, ...parseFields() };
    }
    return token; // 枚举变体等裸词
  }

  /** 解析括号内逗号分隔的值序列（含结尾闭括号）；单值时解包。 */
  function parseValueList(closing: string): unknown {
    const items: unknown[] = [];
    ws();
    if (text[pos.index] === closing) {
      pos.index += 1;
      return [];
    }
    for (;;) {
      items.push(parseValue());
      ws();
      if (text[pos.index] === ",") pos.index += 1;
      else if (text[pos.index] === closing) {
        pos.index += 1;
        return items.length === 1 ? items[0] : items;
      } else fail(`expected , or ${closing}`);
    }
  }

  function parseFields(): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    ws();
    if (text[pos.index] === "}") {
      pos.index += 1;
      return obj;
    }
    for (;;) {
      ws();
      let key: string;
      if (text[pos.index] === '"') {
        key = parseString();
      } else {
        let end = pos.index;
        while (end < text.length && text[end] !== ":" && !/[\s()[\]{}]/.test(text[end]!)) {
          end += 1;
        }
        if (end === pos.index) fail("expected field key");
        key = text.slice(pos.index, end);
        pos.index = end;
      }
      ws();
      if (text[pos.index] !== ":") fail(`expected : after key "${key}"`);
      pos.index += 1;
      obj[key] = parseValue();
      ws();
      if (text[pos.index] === ",") pos.index += 1;
      else if (text[pos.index] === "}") {
        pos.index += 1;
        return obj;
      } else fail("expected , or } in fields");
    }
  }

  const value = parseValue();
  ws();
  if (pos.index !== text.length) fail("trailing input after value");
  return value;
}

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordTable(items: Record<string, unknown>[]): string {
  const columns: string[] = [];
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  const head = columns.map((c) => `<th>${htmlEscape(c)}</th>`).join("");
  const rows = items
    .map((item) => `<tr>${columns.map((c) => cellHtml(item[c])).join("")}</tr>`)
    .join("");
  return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function detailsWrap(summary: string, inner: string): string {
  return `<details><summary>${htmlEscape(summary)}</summary>${inner}</details>`;
}

function cellHtml(value: unknown): string {
  if (value === null || value === undefined) return "<td></td>";
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every(isRecord)) {
      const table = recordTable(value);
      return `<td>${value.length > 4 ? detailsWrap(`${value.length} items`, table) : table}</td>`;
    }
    const text = value
      .map((v) => (isRecord(v) || Array.isArray(v) ? JSON.stringify(v) : String(v)))
      .join(", ");
    return `<td>${htmlEscape(text)}</td>`;
  }
  if (isRecord(value)) {
    const count = Object.keys(value).length;
    const table = kvTable(value);
    return `<td>${count > 4 ? detailsWrap(`${count} fields`, table) : table}</td>`;
  }
  return `<td>${htmlEscape(String(value))}</td>`;
}

function kvTable(obj: Record<string, unknown>): string {
  const rows = Object.entries(obj)
    .map(([key, value]) => `<tr><th>${htmlEscape(key)}</th>${cellHtml(value)}</tr>`)
    .join("");
  return `<table class="kv"><tbody>${rows}</tbody></table>`;
}

function renderCliHtml(
  command: string,
  payload: Record<string, unknown>,
  basePath: string,
): string {
  const sections: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === "ok" || key === "command") continue;
    const title = `<h2>${htmlEscape(key)}${Array.isArray(value) ? ` (${value.length})` : ""}</h2>`;
    if (Array.isArray(value)) {
      sections.push(
        value.length > 0 && value.every(isRecord)
          ? `${title}${recordTable(value)}`
          : `${title}<p>${htmlEscape(value.length ? JSON.stringify(value) : "(empty)")}</p>`,
      );
    } else if (isRecord(value)) {
      // 顶层大对象按字段拆成多个小节（如 dump-route 的 route 结构）
      if (Object.keys(value).length > 6) {
        for (const [key2, value2] of Object.entries(value)) {
          const sub = `<h2>${htmlEscape(key2)}</h2>`;
          if (Array.isArray(value2) && value2.length > 0 && value2.every(isRecord)) {
            sections.push(`${sub}${recordTable(value2)}`);
          } else if (isRecord(value2)) {
            sections.push(`${sub}${kvTable(value2)}`);
          } else {
            sections.push(
              `${sub}<p>${htmlEscape(Array.isArray(value2) ? JSON.stringify(value2) : String(value2 ?? ""))}</p>`,
            );
          }
        }
      } else {
        sections.push(`${title}${kvTable(value)}`);
      }
    } else {
      sections.push(`${title}<p>${htmlEscape(String(value ?? ""))}</p>`);
    }
  }
  const nav = Object.keys(CLI_COMMANDS)
    .map((name) =>
      name === command
        ? `<span class="cur">${htmlEscape(name)}</span>`
        : `<a href="${htmlEscape(basePath)}/${htmlEscape(name)}">${htmlEscape(name)}</a>`,
    )
    .join('<span class="sep">·</span>');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>easytier-cli ${htmlEscape(command)}</title>
<style>
:root{--bg:#14141c;--fg:#d8d8e0;--dim:#9a9ab0;--accent:#7db4e8;--bd:#3a3a4a;--thead:#23233a;--kvhead:#1d1d30}
html[data-theme="light"]{--bg:#f5f6f8;--fg:#24242c;--dim:#5c5c70;--accent:#1c6bd0;--bd:#c8c8d4;--thead:#e4e7ee;--kvhead:#eceef4}
@media (prefers-color-scheme: light){
  html:not([data-theme="dark"]){--bg:#f5f6f8;--fg:#24242c;--dim:#5c5c70;--accent:#1c6bd0;--bd:#c8c8d4;--thead:#e4e7ee;--kvhead:#eceef4}
}
body{font-family:ui-monospace,Menlo,Consolas,monospace;margin:1rem;background:var(--bg);color:var(--fg)}
nav{margin-bottom:.4rem;font-size:.85rem}
nav a{color:var(--accent);text-decoration:none;padding:.1rem .15rem}
nav a:hover{text-decoration:underline}
nav .cur{color:var(--fg);font-weight:bold;border-bottom:1px solid var(--accent)}
nav .sep{color:var(--dim);margin:0 .35rem}
#theme{float:right;font:inherit;font-size:.8rem;padding:.1rem .55rem;background:none;color:var(--accent);border:1px solid var(--bd);border-radius:.4rem;cursor:pointer}
h1{font-size:1.05rem}h2{font-size:.95rem;margin:1.2rem 0 .35rem;color:var(--accent)}
table{border-collapse:collapse;margin:.3rem 0;font-size:.82rem}
th,td{border:1px solid var(--bd);padding:.22rem .5rem;text-align:left;vertical-align:top}
thead th{background:var(--thead)}
table.kv th{background:var(--kvhead);width:11rem}
td table{margin:0}
details summary{cursor:pointer;color:var(--dim);user-select:none}
</style></head><body>
<button id="theme" onclick="toggleTheme()">☾ / ☀</button>
<nav>${nav}</nav>
<h1>easytier-cli ${htmlEscape(command)} — ok</h1>
${sections.join("\n")}
<script>
(function(){
  var root=document.documentElement;
  var saved=null;try{saved=localStorage.getItem("et-theme")}catch(e){}
  if(saved)root.dataset.theme=saved;
  window.toggleTheme=function(){
    var t=root.dataset.theme==="light"?"dark":"light";
    root.dataset.theme=t;
    try{localStorage.setItem("et-theme",t)}catch(e){}
  };
})();
</script>
</body></html>`;
}

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
  "dump-route": {
    method: "api.instance.PeerManageRpc.DumpRoute",
    decode: (bytes) => {
      const decoded = decodeMessageAt(bytes, [
        { field: 1, kind: "string", name: "result" },
      ], 0, bytes.length);
      const raw = decoded.result ?? "";
      // result 是 PeerRouteServiceImpl 的 Rust Debug 单行串，解析为结构化
      // 对象展示；解析失败时回退为原始文本
      try {
        return { route: parseRustDebug(raw) };
      } catch {
        return { result: raw };
      }
    },
  },
  "foreign-network": {
    method: "api.instance.PeerManageRpc.ListForeignNetwork",
    decode: (bytes) => {
      const decoded = decodeMessageAt(bytes, [
        { field: 1, kind: "message", name: "foreign_networks", spec: [], repeated: true },
      ], 0, bytes.length);
      return { foreign_networks: decoded.foreign_networks ?? [] };
    },
  },
  "public-ipv6": {
    method: "api.instance.PeerManageRpc.ListPublicIpv6Info",
    decode: (bytes) => {
      const decoded = decodeMessageAt(bytes, [
        { field: 1, kind: "message", name: "provider_prefix", spec: [] },
        { field: 2, kind: "message", name: "provider_leases", spec: [], repeated: true },
      ], 0, bytes.length);
      return { ...decoded };
    },
  },
};

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

  // 请求经内部 header 转发进 DO，由内核 management-rpc ABI 执行。
  // 注意：DirectRpcRequest 信封由 runtime.rpc() 负责编码，这里只发命令的
  // 原始 protobuf 请求体（当前四个命令的请求消息都是空消息）
  const forwarded = new Request(request.url, {
    method: "POST",
    headers: {
      "x-easytier-rpc": definition.method,
      "content-type": "application/octet-stream",
    },
    body: EMPTY_REQUEST as unknown as BodyInit,
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

  // runtime.rpc() 已解包 RpcResponse 信封（错误已转为异常），这里直接拿到
  // 响应消息的 protobuf 字节
  const encoded = new Uint8Array(await response.arrayBuffer());
  let payload: Record<string, unknown>;
  try {
    payload = definition.decode(encoded) as Record<string, unknown>;
  } catch (error) {
    return Response.json(
      { ok: false, error: String(error) },
      { status: 502 },
    );
  }
  // 浏览器请求渲染为 HTML 表格，curl/wget 等返回 JSON；?format= 可强制指定
  const parsedUrl = new URL(request.url);
  const format = parsedUrl.searchParams.get("format")?.toLowerCase();
  const wantsHtml =
    format === "html" ||
    (format !== "json" &&
      /mozilla\//i.test(request.headers.get("user-agent") ?? "") &&
      request.headers.get("accept")?.includes("text/html"));
  if (wantsHtml) {
    // 顶部命令导航复用访问令牌路径（/<token>/<cmd>）
    const basePath = `/${encodeURIComponent(parsedUrl.pathname.split("/").filter(Boolean)[0] ?? "")}`;
    return new Response(renderCliHtml(command, payload, basePath), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
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
      // 第二层：EasyTier 内核握手校验 network_name + network_secret，不匹配即断开
    }

    return easytier.fetch(request, env, ctx);
  },
};
