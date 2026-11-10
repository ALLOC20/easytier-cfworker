# EasyTier Private Relay Node on Cloudflare Workers

[简体中文](README.md) | [English](README.en.md)

> Run the EasyTier WASM core on Cloudflare Workers to get a **private wss handshake/relay
> node of your own**. Fully built and deployed by GitHub Actions — no local toolchain needed.

---

## Motivation: Why This Project Exists

[EasyTier](https://github.com/EasyTier/EasyTier) is a decentralized mesh VPN where devices
prefer direct P2P connections. In reality, many devices sit behind NAT (home broadband,
cellular, corporate networks) and P2P hole punching fails — at that point traffic must flow
through a **public relay node**.

The existing options are all unsatisfying:

| Option | Problem |
|---|---|
| EasyTier official public servers | **Now discontinued**; community-maintained nodes are unstable, route traffic through third parties, offer no privacy and uncontrollable speed |
| Self-hosted VPS relay | Buy a server, maintain an OS, endure constant scanning, pay monthly |
| frp / port forwarding | Still requires a public machine somewhere |

**Cloudflare has hundreds of edge nodes worldwide, and its reachability from China is far
better than most overseas VPS providers.** This project runs the EasyTier core (compiled to
WASM) directly on Cloudflare Workers:

- **Zero servers**: no VPS at all — Worker + Durable Object are fully managed; light usage
  fits within the free tier
- **Globally reachable**: wss (WebSocket over TLS) on port 443 is indistinguishable from
  regular HTTPS traffic and tunnels through most firewalls and NATs
- **Private by design**: four protection layers (below) ensure strangers cannot ride on
  your node
- **Fully automated deploys**: push to deploy — GitHub Actions compiles Rust to WASM in the
  cloud

## How It Works

### Architecture

```
[Device A] --wss(+token)--> ┌──────────────────────────────┐
[Device B] --wss(+token)--> │ Cloudflare Worker            │
[Device C] --wss(+token)--> │  └─ Durable Object (single)  │
                            │      └─ EasyTier WASM core   │
                            └──────────────────────────────┘
     Devices still prefer P2P direct links; the Worker is the
     handshake hub and the relay of last resort.
```

Every accepted WebSocket connection is handed to the EasyTier core inside the Durable
Object. The core joins your EasyTier network using your `network name / secret`, so to
clients it is just another peer (displayed as `CF-WORKER`). Device-to-device traffic goes
P2P when hole punching succeeds and is relayed through the Worker otherwise.

### Four Protection Layers

Only connections that "reach the edge + carry a token + use correct credentials" ever join
the network (no geo or IP restrictions):

| Layer | Mechanism | Blocks |
|---|---|---|
| 1. Cloudflare WAF | Only `/health`, WebSocket upgrades and read-only CLI query paths pass | Scanners, crawlers, other paths |
| 2. Worker access token | URL must carry your secret Access Token | Everything tokenless — rejected **before** the EasyTier handshake |
| 3. Kernel private_mode | The EasyTier core rejects connections whose network name/secret mismatch | Anyone holding the URL but with wrong credentials |

> Layer 3 relies on a patch (`deploy/runtime-hostname.patch`) that forwards `private_mode`
> and `relay_network_whitelist` from the deployment config into the WASM kernel, so the
> kernel refuses devices with mismatched network name/secret at handshake time instead of
> treating them as "foreign networks" and relaying them.

### Deployment Pipeline

On every push to `main` (or a manual trigger), `.github/workflows/deploy.yml`:

1. Checks out [EasyTier/EasyTier](https://github.com/EasyTier/EasyTier) `main`
2. Applies `deploy/runtime-hostname.patch` (token passthrough + private_mode support)
3. Installs Rust 1.95 + wasm32-wasip1 + protoc + Node/pnpm, builds `@easytier/cloudflare`
   (including the WASM core)
4. Applies your `deploy/worker.ts` and `deploy/wrangler.jsonc`, runs `wrangler deploy`
5. Uploads the EasyTier secrets, health-checks, and maintains the WAF rule

## Deployment Guide (Beginner Friendly)

### Step 0: Prepare Three Things

| Need | Notes |
|---|---|
| GitHub account | To host this repo and run Actions |
| Cloudflare account | Free plan is enough ([sign up](https://dash.cloudflare.com/sign-up)) |
| A domain | Hosted on Cloudflare (strongly recommended; `workers.dev` is DNS-polluted in mainland China) |

> Hosting a domain on Cloudflare: dashboard → **Add a domain** → change the NS records at
> your registrar to the two Cloudflare nameservers → wait for status **Active**.

### Step 1: Create Your Own Repository

Put all files from this repository into your own GitHub repo (private recommended):

- Option A: **Fork** this repo (then follow step 4 to adjust config)
- Option B: `git clone` locally and push to a new empty repo

### Step 2: Create a Cloudflare API Token

1. Open <https://dash.cloudflare.com/profile/api-tokens> → **Create Token**
2. Use the template **Edit Cloudflare Workers**
3. **Append** these permissions:
   - `Account → Durable Objects → Edit`
   - `Zone → Zone WAF → Edit` (for automatic WAF maintenance)
   - `Zone → Zone → Read`
4. Zone Resources: select your domain → **Continue to summary** → **Create Token**
5. **Copy the token immediately** (shown only once)

Also copy the **Account ID** (32 hex chars) from the Cloudflare dashboard sidebar.

### Step 3: Configure GitHub Secrets

Repo → **Settings → Secrets and variables → Actions**.

**Repository secrets** (**New repository secret**, one at a time):

| Secret | Value | Notes |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | token from step 2 | Deployment credential |
| `CLOUDFLARE_ACCOUNT_ID` | your Account ID | Target account |
| `EASYTIER_NETWORK_NAME` | e.g. `my_net` | EasyTier network name |
| `EASYTIER_NETWORK_SECRET` | strong password | EasyTier network secret; clients must match |
| `EASYTIER_ACCESS_TOKEN` | random long string | The token embedded in access URLs (`openssl rand -hex 24`) |
| `WAF_ZONE_NAME` | your domain, e.g. `your-domain.com` | Zone targeted by WAF maintenance and custom-domain binding |
| `WORKER_CUSTOM_DOMAINS` | space-separated hostnames | Custom domains bound to the Worker (**keep in Secrets** — Variables on a public repo are readable by anyone) |
| `WAF_HOSTS` | space-separated hostnames | Hostnames covered by the WAF rule; keep in sync with the previous entry |
| `WORKER_HEALTH_URL` | any bound access hostname | Used by the post-deploy health check |

> Store **all** of the above as **Secrets** (not Variables): on public repos, Variable values
> are readable by everyone; Secrets are usable in Actions but cannot be read. Missing values
> make the corresponding steps skip themselves — deploys still succeed.

### Step 4: Deploy

All repo-specific configuration comes from the Secrets configured in step 3
(`deploy.yml` contains no hardcoded private values).

Once Secrets are in place, push to `main` to deploy automatically; or go to
**Actions → Deploy EasyTier Cloudflare Relay → Run workflow**.

The build takes about 5–15 minutes. The **"Show deployment"** step in the Actions log prints
the deployment result and health check — `{"ok":true,...}` means success.

### Step 5: Bind a Custom Domain

1. Cloudflare dashboard → **Workers & Pages** → **easytier-cfworker** → **Settings**
2. **Domains & Routes** → **Add** → **Custom domain**
3. Enter your hostname (e.g. `et.example.com`) → **Add domain**; the certificate is issued
   automatically and takes about a minute

(Repeat for every hostname listed in `WAF_HOSTS`.)

### Step 6: Connect Clients

Two equivalent access URL forms (`<access-token>` = the value of `EASYTIER_ACCESS_TOKEN`):

```text
wss://et.example.com/<access-token>
wss://et.example.com/?token=<access-token>
```

**Mobile / desktop GUI** (official EasyTier clients): fill in the network name/secret from
step 3, and add the `wss://` URL above as a peer. Once connected, **CF-WORKER** appears in
the peer list.

**Command line**:

```sh
easytier-core \
  --network-name <EASYTIER_NETWORK_NAME> \
  --network-secret <EASYTIER_NETWORK_SECRET> \
  -w "wss://et.example.com/<access-token>"
```

**TOML config file** (note the table name is singular `peer`):

```toml
[[peer]]
uri = "wss://et.example.com/<access-token>"
```

### Step 7: Verify

- Visit `https://et.example.com/health` in a browser; it should return
  `{"ok":true,"state":"running","connections":N}`
- `N` equals the number of devices currently connected to the Worker; seeing **CF-WORKER**
  in the GUI peer list means you have joined the network
- Test connectivity between devices (ping / file transfer): P2P traffic bypasses the
  Worker, relayed traffic goes through it

## Configuration Reference

| Location | Key | Purpose |
|---|---|---|
| GitHub Secrets | see step 3 | Credentials, EasyTier network identity, custom domains and WAF config (all in Secrets) |
| `deploy/wrangler.jsonc` | `name` | Worker name |
| `deploy/wrangler.jsonc` | `vars.EASYTIER_OBJECT_NAME` | Durable Object instance name (renaming forces a fresh instance) |
| `deploy/wrangler.jsonc` | `vars.EASYTIER_ENABLE_ENCRYPTION` | Kernel encryption on/off |
| `deploy/worker.ts` | `config()` | Network identity source, instance name, privateMode, etc. |

Any file change pushed to `main` redeploys automatically; **after changing GitHub
Secrets/Variables you must manually re-run the workflow** (Actions → latest run → Re-run
jobs).

## FAQ

**Q: Clients cannot connect to the workers.dev address.**
A: `workers.dev` is DNS-polluted in mainland China — this is widespread. Bind a custom
domain (step 5) and use that instead.

**Q: What happens to devices with wrong credentials?**
A: With private_mode enabled, devices whose network name/secret mismatch are rejected at
the handshake layer — they cannot join the network nor relay through it.

**Q: `/health` returns 503?**
A: The core is not ready, or the connection/memory limits of the Durable Object are hit.
The free plan has DO memory/duration limits; heavy usage requires Workers Paid ($5/mo).

**Q: How do I change the network password?**
A: Update the `EASYTIER_NETWORK_SECRET` secret and all clients, then re-run the workflow.
Consider renaming `EASYTIER_OBJECT_NAME` as well to force a fresh instance.

**Q: How do I view logs?**
A: Cloudflare dashboard → Workers & Pages → easytier-cfworker → **Logs** tab (enable
Workers Logs). Kernel events are emitted as JSON, e.g. `tunnel_admission_failed`.

## Limits and Notes

- The Worker is **inbound-only**: it accepts inbound wss connections, never dials out and
  does not punch holes
- Durable Object state is in-memory; concurrent connections / memory / request duration
  have platform limits — exceeding them returns 503
- Only `/health` is exposed publicly (status and connection count, no sensitive data)
- Private repos get 2,000 free Actions minutes per month; each build takes 5–15 minutes
- Use a strong network secret; treat the Access Token like a password (it appears in URLs)

## Acknowledgements

- [EasyTier](https://github.com/EasyTier/EasyTier) and
  [PR #2548](https://github.com/EasyTier/EasyTier/pull/2548), which made running the core
  on Cloudflare Workers / browsers possible
- [Cloudflare Workers](https://workers.cloudflare.com/) and Durable Objects

## License

Follows the upstream EasyTier [LICENSE](https://github.com/EasyTier/EasyTier/blob/main/LICENSE).
