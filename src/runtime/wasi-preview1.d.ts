import { WasiClock } from "./wasi-clock.js";
export declare class WasiPreview1 {
    readonly imports: WebAssembly.ModuleImports;
    private memory;
    constructor(clock: WasiClock);
    bindMemory(memory: WebAssembly.Memory): void;
    private randomGet;
    private environSizesGet;
    private environGet;
    private fdWrite;
    private bytes;
    private view;
    private requireMemory;
}
