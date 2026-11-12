export interface RuntimeWebSocketEvent {
    data?: string | ArrayBuffer;
}
export interface RuntimeWebSocket {
    binaryType: string;
    readonly bufferedAmount?: number;
    send(message: Uint8Array): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: "open" | "message" | "close" | "error", listener: (event: RuntimeWebSocketEvent) => void): void;
    accept?(): void;
}
export interface WebSocketHostHealth {
    connections: number;
    queuedBytes: number;
    pendingOperations: number;
}
export interface EasyTierCoreEvent {
    kind: string;
    message: string;
}
export declare class WebSocketHost {
    private readonly outboundFactory?;
    private readonly onEvent;
    private readonly sockets;
    private readonly tcpPortLeases;
    private readonly operations;
    private nextHandle;
    private nextTcpPort;
    private totalQueuedBytes;
    private wakeGuest;
    private wasmMemory;
    constructor(outboundFactory?: ((url: string) => RuntimeWebSocket) | undefined, onEvent?: (event: EasyTierCoreEvent) => void);
    readonly imports: WebAssembly.Imports["easytier_host"];
    bindMemory(memory: WebAssembly.Memory): void;
    setWakeGuest(wakeGuest: () => void): void;
    canAccept(): boolean;
    register(socket: RuntimeWebSocket): bigint;
    transferToGuest(handle: bigint): void;
    reject(handle: bigint): void;
    abort(handle: bigint, reason: string): void;
    receive(handle: bigint, data: string | ArrayBuffer): void;
    remoteClose(handle: bigint): void;
    remoteError(handle: bigint): void;
    health(): WebSocketHostHealth;
    shutdown(reason?: string): void;
    private emitEvent;
    private startConnect;
    private takeConnect;
    private completeConnect;
    private failConnect;
    private startReceive;
    private takeReceive;
    private startSend;
    private takeSend;
    private cancelOperation;
    private closeHandle;
    private enqueue;
    private completeReceive;
    private terminateWithError;
    private releaseSocket;
    private removeQueuedBytes;
    private removeQueuedBytesForHandle;
    private canQueueBytes;
    private addQueuedBytes;
    private allocateHandle;
    private startTcpBind;
    private takeTcpBind;
    private allocateTcpPort;
    private requireSocket;
    private memoryBytes;
}
