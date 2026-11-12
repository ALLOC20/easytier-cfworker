import type { EasyTierEvent, EasyTierInstance } from "./index.js";
import { type RuntimeInstanceConfig } from "./config.js";
import { type HostTunnelMetadata } from "./runtime.js";
import type { RuntimeWebSocket } from "./websocket-host.js";
export type { HostTunnelMetadata, RuntimeInstanceConfig, RuntimeWebSocket, };
export interface RuntimeAdapter extends EasyTierInstance {
    canAcceptWebSocket(): boolean;
    acceptWebSocket(socket: RuntimeWebSocket, metadata: HostTunnelMetadata): Promise<void>;
}
export interface CreateRuntimeOptions {
    module: WebAssembly.Module | (() => Promise<WebAssembly.Module>);
    config: RuntimeInstanceConfig;
    connectWebSocket?: (url: string) => RuntimeWebSocket;
    onEvent?: (event: EasyTierEvent) => void;
}
export declare function createEasyTierRuntime(options: CreateRuntimeOptions): Promise<RuntimeAdapter>;
