import { encodeRuntimeConfig } from "./config.js";
import { EasyTierRuntime, } from "./runtime.js";
export async function createEasyTierRuntime(options) {
    const config = encodeRuntimeConfig(options.config);
    const module = typeof options.module === "function"
        ? await options.module()
        : options.module;
    const runtime = new EasyTierRuntime(module, config, options.connectWebSocket, options.onEvent);
    try {
        await runtime.ready;
    }
    catch (error) {
        await runtime.stop().catch(() => { });
        throw new Error("failed to start EasyTier", { cause: error });
    }
    return {
        connectTcp: (address, operation) => {
            const target = parseTcpAddress(address);
            return runtime.connectTcp(target.ipv4, target.port, operation?.timeout);
        },
        listenTcp: (port, operation) => runtime.bindTcp(port, operation?.timeout).then((listener) => ({
            localAddress: listener.localAddress,
            accept: (acceptOptions) => listener.accept(acceptOptions?.timeout),
            close: () => listener.close(),
        })),
        status: async () => {
            const health = await runtime.health();
            return {
                state: stateName(health.state),
                connections: health.connections,
            };
        },
        close: () => runtime.stop(),
        canAcceptWebSocket: () => runtime.canAcceptWebSocket(),
        acceptWebSocket: (socket, metadata) => runtime.acceptWebSocket(socket, metadata),
    };
}
function parseTcpAddress(address) {
    const separator = address.lastIndexOf(":");
    if (separator <= 0) {
        throw new Error(`invalid IPv4 TCP address: ${address}`);
    }
    const ipv4 = address.slice(0, separator);
    const port = Number(address.slice(separator + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error(`invalid TCP port in address: ${address}`);
    }
    return { ipv4, port };
}
function stateName(state) {
    switch (state) {
        case 0:
            return "created";
        case 1:
            return "starting";
        case 2:
            return "running";
        case 3:
            return "stopping";
        case 4:
            return "stopped";
        default:
            throw new Error(`guest returned unknown instance state ${state}`);
    }
}
