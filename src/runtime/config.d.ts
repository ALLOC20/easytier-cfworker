export type RuntimeProfile = "browser" | "cloudflare";
export interface RuntimeInstanceConfig {
    profile: RuntimeProfile;
    instanceId: string;
    instanceName: string;
    hostname?: string;
    relayNetworkWhitelist?: string;
    privateMode?: boolean;
    networkName: string;
    networkSecret: string;
    encryption: boolean;
    ipv4?: string;
    peers?: readonly string[];
}
export declare function encodeRuntimeConfig(config: RuntimeInstanceConfig): string;
