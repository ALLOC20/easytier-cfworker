import { type EasyTierTcpListener, type EasyTierTcpStream } from "./data-plane.js";
import { type EasyTierCoreEvent, type RuntimeWebSocket, type WebSocketHostHealth } from "./websocket-host.js";
export interface HostTunnelMetadata {
    version: 1;
    local_url: string;
    remote_url: string;
    resolved_remote_url?: string;
}
export interface CoreHealth extends WebSocketHostHealth {
    state: number;
    tunnelAbiVersion: number;
}
export declare class EasyTierRuntime {
    private readonly module;
    private readonly config;
    private readonly host;
    readonly ready: Promise<void>;
    private instanceHandle;
    private exports;
    private memory;
    private clock;
    private serial;
    private timer;
    private timerGeneration;
    private timerDueAt;
    private armRequest;
    private pumpQueued;
    private completionRequested;
    private lastError;
    private dataPlane;
    private stopping;
    private stopPromise;
    constructor(module: WebAssembly.Module, config: string, outboundWebSocketFactory?: (url: string) => RuntimeWebSocket, onEvent?: (event: EasyTierCoreEvent) => void);
    canAcceptWebSocket(): boolean;
    acceptWebSocket(socket: RuntimeWebSocket, metadata: HostTunnelMetadata): Promise<void>;
    attachTunnel(tunnelHandle: bigint, metadata: HostTunnelMetadata): Promise<void>;
    health(): Promise<CoreHealth>;
    connectTcp(ipv4: string, port: number, timeoutMilliseconds?: number): Promise<EasyTierTcpStream>;
    bindTcp(localPort: number, timeoutMilliseconds?: number): Promise<EasyTierTcpListener>;
    stop(): Promise<void>;
    private initialize;
    private stopInstance;
    private releaseRuntimeResources;
    private requestHostCompletion;
    private queuePump;
    private driveUntilIdle;
    private armNextDrive;
    private wrapExports;
    private cancelTimer;
    private copyIntoGuest;
    private instanceError;
    private call;
    private requireMemory;
    private requireRunning;
    private enqueue;
}
