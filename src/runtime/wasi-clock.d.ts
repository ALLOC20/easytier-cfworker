export declare class WasiClock {
    private readonly memory;
    private nowNanos;
    private interruptPoll;
    constructor(memory: () => WebAssembly.Memory);
    readonly clockTimeGet: (clockId: number, _precision: bigint, resultPointer: number) => number;
    readonly pollOneoff: (subscriptionsPointer: number, eventsPointer: number, subscriptionCount: number, resultCountPointer: number) => Promise<number>;
    interrupt(): void;
    advanceMillis(milliseconds: number): void;
    syncWallTime(): void;
    private readClockSubscriptions;
    private writeClockEvent;
    private syncWallClock;
    private view;
}
