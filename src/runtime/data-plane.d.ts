export type DataPlaneValue = number | bigint;
export type DataPlaneExportName = "dataPlaneAbiVersion" | "dataPlaneCapabilities" | "dataPlaneTcpConnectSubmit" | "dataPlaneTcpBindSubmit" | "dataPlaneTcpAcceptSubmit" | "dataPlaneTcpReadSubmit" | "dataPlaneTcpWriteSubmit" | "dataPlaneTcpShutdownWriteSubmit" | "dataPlaneCompletionDrain" | "dataPlaneResultSize" | "dataPlaneTcpConnectResultTake" | "dataPlaneTcpBindResultTake" | "dataPlaneTcpAcceptResultTake" | "dataPlaneTcpReadResultTake" | "dataPlaneTcpWriteResultTake" | "dataPlaneTcpShutdownWriteResultTake" | "dataPlaneOperationFree" | "dataPlaneResourceClose";
export interface DataPlaneBindings {
    readonly instanceHandle: bigint;
    call(name: DataPlaneExportName, parameters: DataPlaneValue[]): Promise<DataPlaneValue>;
    allocate(length: number): Promise<number>;
    free(pointer: number): Promise<void>;
    copyIntoGuest(bytes: Uint8Array): Promise<number>;
    readGuest(pointer: number, length: number): Uint8Array;
    instanceError(context: string): Promise<string>;
    runExclusive<T>(operation: () => Promise<T>): Promise<T>;
    drive(): Promise<void>;
}
export interface TcpReadResult {
    data: Uint8Array;
    eof: boolean;
}
export interface EasyTierIpv4SocketAddress {
    ipv4: string;
    port: number;
}
export declare class EasyTierTcpStream {
    private readonly dataPlane;
    private readonly resource;
    readonly localAddress: EasyTierIpv4SocketAddress;
    readonly peerAddress: EasyTierIpv4SocketAddress;
    private closed;
    private writeShutdown;
    constructor(dataPlane: EasyTierDataPlane, resource: bigint, localAddress: EasyTierIpv4SocketAddress, peerAddress: EasyTierIpv4SocketAddress);
    read(maxLength?: number): Promise<TcpReadResult>;
    write(data: Uint8Array): Promise<number>;
    shutdownWrite(): Promise<void>;
    close(): Promise<void>;
    private requireOpen;
}
export declare class EasyTierTcpListener {
    private readonly dataPlane;
    private readonly resource;
    readonly localAddress: EasyTierIpv4SocketAddress;
    private closed;
    constructor(dataPlane: EasyTierDataPlane, resource: bigint, localAddress: EasyTierIpv4SocketAddress);
    accept(timeoutMilliseconds?: number): Promise<EasyTierTcpStream>;
    close(): Promise<void>;
    private requireOpen;
}
export declare class EasyTierDataPlane {
    private readonly bindings;
    private readonly pending;
    private stoppedError;
    constructor(bindings: DataPlaneBindings);
    initialize(): Promise<void>;
    connectTcp(ipv4: string, port: number, timeoutMilliseconds?: number): Promise<EasyTierTcpStream>;
    bindTcp(localPort: number, timeoutMilliseconds?: number): Promise<EasyTierTcpListener>;
    acceptTcp(listener: bigint, timeoutMilliseconds?: number): Promise<EasyTierTcpStream>;
    readTcp(resource: bigint, maxLength: number): Promise<TcpReadResult>;
    writeTcp(resource: bigint, data: Uint8Array): Promise<number>;
    shutdownTcpWrite(resource: bigint): Promise<void>;
    shutdown(error?: Error): void;
    closeResource(resource: bigint): Promise<void>;
    drainCompletions(): Promise<void>;
    private submit;
    private complete;
    private requireSuccess;
    private streamFromResult;
}
