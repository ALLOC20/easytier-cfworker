const DATA_PLANE_ABI_VERSION = 4;
const DATA_PLANE_TCP_CAPABILITY = 1n << 1n;
const COMPLETION_RECORD_LENGTH = 12;
const COMPLETION_BATCH_SIZE = 64;
const SOCKET_ADDRESS_LENGTH = 27;
const STREAM_RESULT_LENGTH = 8 + SOCKET_ADDRESS_LENGTH * 2;
const LISTENER_RESULT_LENGTH = 8 + SOCKET_ADDRESS_LENGTH;
const TCP_READ_METADATA_LENGTH = 1;
const INFINITE_TIMEOUT = 0xffffffffffffffffn;
export class EasyTierTcpStream {
    dataPlane;
    resource;
    localAddress;
    peerAddress;
    closed = false;
    writeShutdown;
    constructor(dataPlane, resource, localAddress, peerAddress) {
        this.dataPlane = dataPlane;
        this.resource = resource;
        this.localAddress = localAddress;
        this.peerAddress = peerAddress;
    }
    read(maxLength = 64 * 1024) {
        if (!Number.isInteger(maxLength) || maxLength <= 0) {
            return Promise.reject(new Error("TCP read length must be a positive integer"));
        }
        this.requireOpen();
        return this.dataPlane.readTcp(this.resource, maxLength);
    }
    write(data) {
        this.requireOpen();
        if (this.writeShutdown !== undefined) {
            return Promise.reject(new Error("TCP stream write side is shut down"));
        }
        return this.dataPlane.writeTcp(this.resource, data);
    }
    shutdownWrite() {
        this.requireOpen();
        if (this.writeShutdown !== undefined) {
            return this.writeShutdown;
        }
        const shutdown = this.dataPlane
            .shutdownTcpWrite(this.resource)
            .catch((error) => {
            this.writeShutdown = undefined;
            throw error;
        });
        this.writeShutdown = shutdown;
        return shutdown;
    }
    async close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        await this.dataPlane.closeResource(this.resource);
    }
    requireOpen() {
        if (this.closed) {
            throw new Error("TCP stream is closed");
        }
    }
}
export class EasyTierTcpListener {
    dataPlane;
    resource;
    localAddress;
    closed = false;
    constructor(dataPlane, resource, localAddress) {
        this.dataPlane = dataPlane;
        this.resource = resource;
        this.localAddress = localAddress;
    }
    accept(timeoutMilliseconds) {
        this.requireOpen();
        return this.dataPlane.acceptTcp(this.resource, timeoutMilliseconds);
    }
    async close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        await this.dataPlane.closeResource(this.resource);
    }
    requireOpen() {
        if (this.closed) {
            throw new Error("TCP listener is closed");
        }
    }
}
export class EasyTierDataPlane {
    bindings;
    pending = new Map();
    stoppedError;
    constructor(bindings) {
        this.bindings = bindings;
    }
    async initialize() {
        const version = Number(await this.bindings.call("dataPlaneAbiVersion", []));
        if (version !== DATA_PLANE_ABI_VERSION) {
            throw new Error(`data-plane ABI ${version} is unsupported; expected ${DATA_PLANE_ABI_VERSION}`);
        }
        const capabilities = BigInt(await this.bindings.call("dataPlaneCapabilities", []));
        if ((capabilities & DATA_PLANE_TCP_CAPABILITY) === 0n) {
            throw new Error("EasyTier guest does not provide the TCP data plane");
        }
    }
    connectTcp(ipv4, port, timeoutMilliseconds) {
        const address = encodeIpv4SocketAddress(ipv4, port);
        return this.submit(1, async (operationPointer) => {
            const addressPointer = await this.bindings.copyIntoGuest(address);
            try {
                return Number(await this.bindings.call("dataPlaneTcpConnectSubmit", [
                    this.bindings.instanceHandle,
                    addressPointer,
                    timeoutValue(timeoutMilliseconds),
                    operationPointer,
                ]));
            }
            finally {
                await this.bindings.free(addressPointer);
            }
        }, async (operation) => {
            const pointer = await this.bindings.allocate(STREAM_RESULT_LENGTH);
            try {
                await this.requireSuccess(Number(await this.bindings.call("dataPlaneTcpConnectResultTake", [
                    this.bindings.instanceHandle,
                    operation,
                    pointer,
                ])), "TCP connect result");
                return this.streamFromResult(this.bindings.readGuest(pointer, STREAM_RESULT_LENGTH));
            }
            finally {
                await this.bindings.free(pointer);
            }
        });
    }
    bindTcp(localPort, timeoutMilliseconds) {
        if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65_535) {
            throw new Error("TCP local port must be between 0 and 65535");
        }
        return this.submit(2, async (operationPointer) => Number(await this.bindings.call("dataPlaneTcpBindSubmit", [
            this.bindings.instanceHandle,
            localPort,
            timeoutValue(timeoutMilliseconds),
            operationPointer,
        ])), async (operation) => {
            const pointer = await this.bindings.allocate(LISTENER_RESULT_LENGTH);
            try {
                await this.requireSuccess(Number(await this.bindings.call("dataPlaneTcpBindResultTake", [
                    this.bindings.instanceHandle,
                    operation,
                    pointer,
                ])), "TCP bind result");
                const result = this.bindings.readGuest(pointer, LISTENER_RESULT_LENGTH);
                return new EasyTierTcpListener(this, readU64(result, 0), decodeIpv4SocketAddress(result, 8));
            }
            finally {
                await this.bindings.free(pointer);
            }
        });
    }
    acceptTcp(listener, timeoutMilliseconds) {
        return this.submit(3, async (operationPointer) => Number(await this.bindings.call("dataPlaneTcpAcceptSubmit", [
            this.bindings.instanceHandle,
            listener,
            timeoutValue(timeoutMilliseconds),
            operationPointer,
        ])), async (operation) => {
            const pointer = await this.bindings.allocate(STREAM_RESULT_LENGTH);
            try {
                await this.requireSuccess(Number(await this.bindings.call("dataPlaneTcpAcceptResultTake", [
                    this.bindings.instanceHandle,
                    operation,
                    pointer,
                ])), "TCP accept result");
                return this.streamFromResult(this.bindings.readGuest(pointer, STREAM_RESULT_LENGTH));
            }
            finally {
                await this.bindings.free(pointer);
            }
        });
    }
    readTcp(resource, maxLength) {
        return this.submit(4, async (operationPointer) => Number(await this.bindings.call("dataPlaneTcpReadSubmit", [
            this.bindings.instanceHandle,
            resource,
            maxLength,
            operationPointer,
        ])), async (operation) => {
            const resultLength = Number(await this.bindings.call("dataPlaneResultSize", [
                this.bindings.instanceHandle,
                operation,
            ]));
            await this.requireSuccess(resultLength, "TCP read result size");
            const dataPointer = resultLength === 0 ? 0 : await this.bindings.allocate(resultLength);
            const metadataPointer = await this.bindings.allocate(TCP_READ_METADATA_LENGTH);
            try {
                const readLength = Number(await this.bindings.call("dataPlaneTcpReadResultTake", [
                    this.bindings.instanceHandle,
                    operation,
                    dataPointer,
                    resultLength,
                    metadataPointer,
                ]));
                await this.requireSuccess(readLength, "TCP read result");
                return {
                    data: readLength === 0
                        ? new Uint8Array()
                        : this.bindings.readGuest(dataPointer, readLength),
                    eof: this.bindings.readGuest(metadataPointer, 1)[0] === 1,
                };
            }
            finally {
                if (dataPointer !== 0) {
                    await this.bindings.free(dataPointer);
                }
                await this.bindings.free(metadataPointer);
            }
        });
    }
    writeTcp(resource, data) {
        return this.submit(5, async (operationPointer) => {
            const dataPointer = data.byteLength === 0 ? 0 : await this.bindings.copyIntoGuest(data);
            try {
                return Number(await this.bindings.call("dataPlaneTcpWriteSubmit", [
                    this.bindings.instanceHandle,
                    resource,
                    dataPointer,
                    data.byteLength,
                    operationPointer,
                ]));
            }
            finally {
                if (dataPointer !== 0) {
                    await this.bindings.free(dataPointer);
                }
            }
        }, async (operation) => {
            const written = Number(await this.bindings.call("dataPlaneTcpWriteResultTake", [
                this.bindings.instanceHandle,
                operation,
            ]));
            await this.requireSuccess(written, "TCP write result");
            return written;
        });
    }
    shutdownTcpWrite(resource) {
        return this.submit(9, async (operationPointer) => Number(await this.bindings.call("dataPlaneTcpShutdownWriteSubmit", [
            this.bindings.instanceHandle,
            resource,
            operationPointer,
        ])), async (operation) => {
            await this.requireSuccess(Number(await this.bindings.call("dataPlaneTcpShutdownWriteResultTake", [
                this.bindings.instanceHandle,
                operation,
            ])), "TCP write shutdown result");
        });
    }
    shutdown(error = new Error("EasyTier runtime is stopped")) {
        if (this.stoppedError !== undefined) {
            return;
        }
        this.stoppedError = error;
        for (const operation of this.pending.values()) {
            operation.reject(error);
        }
        this.pending.clear();
    }
    closeResource(resource) {
        if (this.stoppedError !== undefined) {
            return Promise.reject(this.stoppedError);
        }
        return this.bindings.runExclusive(async () => {
            const status = Number(await this.bindings.call("dataPlaneResourceClose", [
                this.bindings.instanceHandle,
                resource,
            ]));
            await this.requireSuccess(status, "TCP close");
        });
    }
    async drainCompletions() {
        if (this.stoppedError !== undefined) {
            return;
        }
        if (this.pending.size === 0) {
            return;
        }
        const length = COMPLETION_BATCH_SIZE * COMPLETION_RECORD_LENGTH;
        const pointer = await this.bindings.allocate(length);
        try {
            for (;;) {
                const count = Number(await this.bindings.call("dataPlaneCompletionDrain", [
                    this.bindings.instanceHandle,
                    pointer,
                    COMPLETION_BATCH_SIZE,
                ]));
                await this.requireSuccess(count, "data-plane completion drain");
                const records = this.bindings.readGuest(pointer, count * COMPLETION_RECORD_LENGTH);
                for (let index = 0; index < count; index += 1) {
                    const offset = index * COMPLETION_RECORD_LENGTH;
                    const operation = readU64(records, offset);
                    const kind = readU16(records, offset + 8);
                    const status = readU16(records, offset + 10);
                    await this.complete(operation, kind, status);
                }
                if (count < COMPLETION_BATCH_SIZE) {
                    return;
                }
            }
        }
        finally {
            await this.bindings.free(pointer);
        }
    }
    async submit(kind, submit, take) {
        if (this.stoppedError !== undefined) {
            throw this.stoppedError;
        }
        let resolve;
        let reject;
        const completion = new Promise((resolveValue, rejectValue) => {
            resolve = resolveValue;
            reject = rejectValue;
        });
        // A synchronously completed operation may reject while submission still
        // owns the runtime lock. Mark it handled until this method returns it.
        void completion.catch(() => { });
        await this.bindings.runExclusive(async () => {
            const operationPointer = await this.bindings.allocate(8);
            try {
                const status = await submit(operationPointer);
                await this.requireSuccess(status, "data-plane operation submission");
                const operation = readU64(this.bindings.readGuest(operationPointer, 8), 0);
                this.pending.set(operation, {
                    kind,
                    resolve: resolve,
                    reject,
                    take,
                });
            }
            finally {
                await this.bindings.free(operationPointer);
            }
            await this.bindings.drive();
        });
        return completion;
    }
    async complete(operation, kind, completionStatus) {
        const pending = this.pending.get(operation);
        if (pending === undefined) {
            await this.bindings.call("dataPlaneOperationFree", [
                this.bindings.instanceHandle,
                operation,
            ]);
            return;
        }
        this.pending.delete(operation);
        try {
            if (kind !== pending.kind) {
                throw new Error(`data-plane operation ${operation} completed as kind ${kind}; expected ${pending.kind}`);
            }
            const result = await pending.take(operation);
            if (completionStatus !== 0) {
                throw new Error(`data-plane operation ${operation} failed with status ${completionStatus}`);
            }
            pending.resolve(result);
        }
        catch (error) {
            pending.reject(error);
        }
    }
    async requireSuccess(status, context) {
        if (status < 0) {
            throw new Error(await this.bindings.instanceError(`${context} (${status})`));
        }
    }
    streamFromResult(result) {
        return new EasyTierTcpStream(this, readU64(result, 0), decodeIpv4SocketAddress(result, 8), decodeIpv4SocketAddress(result, 8 + SOCKET_ADDRESS_LENGTH));
    }
}
function timeoutValue(milliseconds) {
    if (milliseconds === undefined) {
        return INFINITE_TIMEOUT;
    }
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
        throw new Error("TCP timeout must be a non-negative safe integer");
    }
    return BigInt(milliseconds);
}
function encodeIpv4SocketAddress(ipv4, port) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("TCP port must be between 1 and 65535");
    }
    const octets = ipv4.split(".").map(Number);
    if (octets.length !== 4 ||
        octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
        throw new Error(`invalid IPv4 address: ${ipv4}`);
    }
    const encoded = new Uint8Array(SOCKET_ADDRESS_LENGTH);
    encoded[0] = 4;
    encoded.set(octets, 1);
    new DataView(encoded.buffer).setUint16(17, port, false);
    return encoded;
}
function decodeIpv4SocketAddress(bytes, offset) {
    if (bytes[offset] !== 4) {
        throw new Error(`guest returned a non-IPv4 socket address`);
    }
    const octets = bytes.subarray(offset + 1, offset + 5);
    return {
        ipv4: Array.from(octets).join("."),
        port: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset + 17, false),
    };
}
function readU16(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, false);
}
function readU64(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, false);
}
