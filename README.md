# EasyTier 私人 Cloudflare Worker 中继节点

[简体中文](README.md) | [English](README.en.md)

> 在 Cloudflare Workers 上运行 EasyTier WASM 内核，搭建一个**完全属于你的私人 wss 握手/中继节点**。
> 由 GitHub Actions 全自动构建部署，本地无需安装任何工具链。

---

## Motivation：为什么需要这个项目

[EasyTier](https://github.com/EasyTier/EasyTier) 是一款去中心化组网工具，设备之间优先 P2P 直连。但现实中大量设备没有公网 IP（家宽 NAT、移动网络、企业内网），P2P 打洞失败时必须依赖一个**公网中继节点**转发流量。

现有的选择都不理想：

| 方案 | 问题 |
|---|---|
| EasyTier 官方公共服务器 | **现已停止服务**；社区维护的节点不稳定，且流量经过第三方，隐私无保障、速度不可控 |
| 自建公网 VPS 中继 | 需要买服务器、维护系统、被扫描攻击，还要花钱 |
| frp/内网穿透 + 自建 | 同样需要一台公网机器 |

而 **Cloudflare 全球有几百个边缘节点，在中国大陆的可达性远好于大多数海外 VPS**。本项目把 EasyTier 内核（WASM 形态）跑在 Cloudflare Workers 上：

- **零服务器**：不需要任何 VPS，Worker + Durable Object 全托管，按需付费（少量使用基本落在免费额度内）
- **全球可达**：wss（WebSocket over TLS）走 443 端口，与普通 HTTPS 网页无异，穿越各类防火墙/NAT 的能力强
- **私人专属**：四层防护（见下文）确保只有你能用，陌生人无法蹭你的节点
- **全自动部署**：push 即部署，GitHub Actions 在云端完成 Rust→WASM 的全部编译

## 原理：它是怎么工作的

### 整体架构

```
[你的设备 A] --wss(带token)--> ┌─────────────────────────────┐
[你的设备 B] --wss(带token)--> │ Cloudflare Worker           │
[你的设备 C] --wss(带token)--> │  └─ Durable Object (单实例) │
                               │      └─ EasyTier WASM 内核  │
                               └─────────────────────────────┘
         设备之间仍优先 P2P 直连，Worker 只做握手汇聚与中继兜底
```

每个接入的 WebSocket 连接被交给 Durable Object 内的 EasyTier 内核处理。内核以你的 `网络名/密码` 加入 EasyTier 网络，对客户端来说它就是一个普通对端节点（显示名 `CF-WORKER`）。设备间的流量如果 P2P 打洞成功就直连，失败则经 Worker 中继。

### 三层安全防护

只有"连得上 + 有令牌 + 凭据正确"的连接才能入网（不限地域、不限 IP）：

| 层 | 机制 | 拦截对象 |
|---|---|---|
| 1. Cloudflare WAF | 仅放行 `/health`、WebSocket 升级与只读 CLI 查询路径 | 扫描器、爬虫、其他路径 |
| 2. Worker 访问令牌 | URL 必须携带只有你知道的 Access Token | 一切无令牌连接（在进入 EasyTier 握手**之前**拒绝） |
| 3. 内核 private_mode | EasyTier 内核拒绝网络名/密码不匹配的连接 | 拿到 URL 但凭据错误的连接 |

> 第 3 层依赖对 EasyTier 的一个补丁（`deploy/runtime-hostname.patch`）：把 `private_mode` 与
> `relay_network_whitelist` 从部署配置透传进 WASM 内核，使内核在握手层直接拒绝
> "网络名或密码不匹配"的设备，而非把它们当作"外部网络"放行中继。

### 部署流水线

`.github/workflows/deploy.yml` 在每次 push 到 `main`（或手动触发）时：

1. 检出 [EasyTier/EasyTier](https://github.com/EasyTier/EasyTier) main 分支源码
2. 应用 `deploy/runtime-hostname.patch`（token 透传 + private_mode 支持）
3. 安装 Rust 1.95 + wasm32-wasip1 + protoc + Node/pnpm，构建 `@easytier/cloudflare`（含 WASM 内核）
4. 应用你仓库里的 `deploy/worker.ts` 与 `deploy/wrangler.jsonc`，`wrangler deploy` 到 Cloudflare
5. 写入 EasyTier Secrets，健康检查，并自动维护 WAF 规则

## 部署教程（零基础版）

### 第 0 步：准备三样东西

| 需要 | 说明 |
|---|---|
| GitHub 账号 | 用于托管本仓库并跑 Actions |
| Cloudflare 账号 | 免费计划即可（[注册入口](https://dash.cloudflare.com/sign-up)） |
| 一个域名 | 已托管到 Cloudflare（国内网络环境强烈建议；workers.dev 域名在大陆普遍被污染） |

> 域名托管到 Cloudflare：Cloudflare 控制台 → **Add a domain** → 按提示在域名注册商处把
> NS 记录改成 Cloudflare 给你的两个地址，等待状态变为 **Active**。

### 第 1 步：创建你自己的仓库

把本仓库的全部文件放进你自己的 GitHub 仓库（建议**私有**）：

- 方式 A：直接 **Fork** 本仓库（Fork 后按第 4 步改配置）
- 方式 B：本地 `git clone` 后推送到你新建的空仓库

### 第 2 步：创建 Cloudflare API Token

1. 打开 <https://dash.cloudflare.com/profile/api-tokens> → **Create Token**
2. 选择模板 **Edit Cloudflare Workers**（编辑 Cloudflare Workers）
3. 在权限列表中**追加**以下权限：
   - `Account → Durable Objects → Edit`
   - `Zone → Zone WAF → Edit`（自动维护 WAF 规则用）
   - `Zone → Zone → Read`
4. Zone Resources 选择你的域名 → **Continue to summary** → **Create Token**
5. **立即复制保存** Token 值（只显示一次）

同时在 Cloudflare 控制台首页右侧栏复制 **Account ID**（32 位十六进制）。

### 第 3 步：在 GitHub 配置 Secrets

进入你的仓库 → **Settings → Secrets and variables → Actions**。

**Repository secrets**（点 **New repository secret** 逐个添加）：

| Secret 名称 | 值 | 说明 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | 第 2 步的 Token | 部署凭据 |
| `CLOUDFLARE_ACCOUNT_ID` | 你的 Account ID | 部署目标账号 |
| `EASYTIER_NETWORK_NAME` | 自定义，如 `my_net` | EasyTier 网络名 |
| `EASYTIER_NETWORK_SECRET` | 自定义强密码 | EasyTier 网络密码，客户端须一致 |
| `EASYTIER_ACCESS_TOKEN` | 自定义随机长字符串 | 接入 URL 里的访问令牌（可用 `openssl rand -hex 24` 生成） |
| `WAF_ZONE_NAME` | 你的域名，如 `your-domain.com` | WAF 规则维护与自定义域绑定使用的 zone |
| `WORKER_CUSTOM_DOMAINS` | 空格分隔的主机名列表 | 绑定给 Worker 的自定义域名（**请写在 Secrets 里**——public 仓库的 Variables 任何人可读） |
| `WAF_HOSTS` | 空格分隔的主机名列表 | WAF 规则覆盖的主机名，与上一项保持一致 |
| `WORKER_HEALTH_URL` | 任一接入域名 | 部署后健康检查用 |

> 以上全部用 **Secrets** 存放（不要用 Variables）：public 仓库中 Variables 的值对所有人可见，
> Secrets 仅在 Actions 中可用、不可读取。缺省时对应步骤自动跳过，不影响部署。

### 第 4 步：触发部署

仓库的个性化配置全部来自第 3 步的 Secrets（`deploy.yml` 中没有任何硬编码的私有信息）。

确认 Secrets 都已配好后，push 到 `main` 自动触发部署；或到
**Actions → Deploy EasyTier Cloudflare Relay → Run workflow** 手动触发。

构建约 5–15 分钟。**Actions 日志里 "Show deployment" 一步会打印部署结果与健康检查输出**，
出现 `{"ok":true,...}` 即部署成功。

### 第 5 步：绑定自定义域名

1. Cloudflare 控制台 → **Workers & Pages** → **easytier-cfworker** → **Settings**
2. **Domains & Routes** → **Add** → **Custom domain**
3. 输入你的主机名（如 `et.example.com`）→ **Add domain**，证书自动签发，约 1 分钟生效

（如果你在 `WAF_HOSTS` 里写了多个主机名，每个都按此绑定。）

### 第 6 步：客户端接入

接入地址有两种等价写法（`<访问令牌>` 即 `EASYTIER_ACCESS_TOKEN` 的值）：

```text
wss://et.example.com/<访问令牌>
wss://et.example.com/?token=<访问令牌>
```

**手机 / 桌面 GUI**（EasyTier 官方客户端）：网络名/密码填第 3 步的
`EASYTIER_NETWORK_NAME` / `EASYTIER_NETWORK_SECRET`，对等节点（peers）里添加上面的
`wss://` 地址。连接成功后对端列表会出现 **CF-WORKER**。

**命令行**：

```sh
easytier-core \
  --network-name <EASYTIER_NETWORK_NAME> \
  --network-secret <EASYTIER_NETWORK_SECRET> \
  -w "wss://et.example.com/<访问令牌>"
```

**TOML 配置文件**（注意表名是单数 `peer`）：

```toml
[[peer]]
uri = "wss://et.example.com/<访问令牌>"
```

### 第 7 步：验证

- 浏览器访问 `https://et.example.com/health`，应返回
  `{"ok":true,"state":"running","connections":N}`
- `N` 等于当前直接连到 Worker 的设备数；GUI 里能看到 CF-WORKER 即入网成功
- 设备之间互 ping / 传文件验证连通性（P2P 成功时流量不经 Worker，中继兜底时经 Worker）

## 配置参考

| 位置 | 键 | 作用 |
|---|---|---|
| GitHub Secret | 见第 3 步 | 凭据、EasyTier 网络身份、自定义域与 WAF 配置（全部在 Secrets 中） |
| `deploy/wrangler.jsonc` | `name` | Worker 名称 |
| `deploy/wrangler.jsonc` | `vars.EASYTIER_OBJECT_NAME` | Durable Object 实例名（改名字会强制重建实例） |
| `deploy/wrangler.jsonc` | `vars.EASYTIER_ENABLE_ENCRYPTION` | 是否开启内核加密 |
| `deploy/worker.ts` | `config()` | 网络名/密码来源、实例名、privateMode 等 |

改完任何文件 push 即自动重新部署；**改 GitHub Secrets/Variables 后必须手动重跑 workflow**
（Actions → 选择最近一次运行 → Re-run jobs）才会生效。

## 常见问题

**Q：为什么客户端连不上 workers.dev 地址？**
A：workers.dev 域名在中国大陆被 DNS 污染，属普遍现象。请绑定自定义域名后使用（第 5 步）。

**Q：错误凭据的设备会怎样？**
A：内核开启 private_mode 后，网络名/密码不匹配的设备在握手层被直接拒绝，无法入网也无法借道中继。

**Q：`/health` 返回 503？**
A：内核未就绪或连接数/内存达到 Durable Object 上限。Workers 免费计划的 DO 有内存与时长限制，
设备多或流量大时需付费计划（Workers Paid，$5/月起）。

**Q：怎么换网络密码？**
A：更新 GitHub Secret `EASYTIER_NETWORK_SECRET` 与所有客户端配置，然后重跑 workflow。
建议同时把 `EASYTIER_OBJECT_NAME` 换个名字强制重建实例。

**Q：如何查看运行日志？**
A：Cloudflare 控制台 → Workers & Pages → easytier-cfworker → **Logs** 标签页（需启用
Workers Logs）；内核事件会以 JSON 形式输出，如 `tunnel_admission_failed`。

## 限额与注意事项

- Worker 为 **inbound-only**：只接受入站 wss 连接，不主动外拨、不做打洞
- Durable Object 状态在内存中，并发连接数 / 内存 / 单次请求时长有平台上限，超限返回 503
- HTTP 仅公开 `/health`（返回状态与连接数，不含敏感信息）
- 私有仓库 Actions 有每月免费额度（2000 分钟），每次构建约 5–15 分钟
- 网络名/密码务必使用强密码；Access Token 请当作口令一样保管（它出现在 URL 中）

## 致谢

- [EasyTier](https://github.com/EasyTier/EasyTier) 及使其可运行于 Cloudflare Workers /
  浏览器的 [PR #2548](https://github.com/EasyTier/EasyTier/pull/2548)
- [Cloudflare Workers](https://workers.cloudflare.com/) 与 Durable Objects

## License

与上游 EasyTier 保持一致，遵循其 [LICENSE](https://github.com/EasyTier/EasyTier/blob/main/LICENSE) 条款。
