import type { CloudflareEasyTierOptions, EasyTierCloudflareApplication } from "./types.js";
export declare function createCloudflareApplication<Env>(module: WebAssembly.Module, options: CloudflareEasyTierOptions<Env>): EasyTierCloudflareApplication<Env>;
