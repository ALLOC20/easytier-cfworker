export function encodeRuntimeConfig(config) {
    requireText(config.instanceId, "instanceId");
    requireText(config.instanceName, "instanceName");
    requireText(config.networkName, "networkName");
    requireString(config.networkSecret, "networkSecret");
    const lines = [
        `instance_id = ${quote(config.instanceId)}`,
        `instance_name = ${quote(config.instanceName)}`,
    ];
    if (config.hostname) {
        lines.push(`hostname = ${quote(config.hostname)}`);
    }
    if (config.profile === "browser") {
        const ipv4 = config.ipv4;
        if (ipv4 === undefined || !isIpv4Prefix(ipv4)) {
            throw new Error("ipv4 must be an IPv4 address with a network prefix");
        }
        const peers = config.peers ?? [];
        if (peers.length === 0) {
            throw new Error("peers must contain at least one WebSocket URL");
        }
        lines.push(`ipv4 = ${quote(ipv4)}`);
        lines.push("listeners = []");
        lines.push("");
        lines.push("[network_identity]");
        lines.push(`network_name = ${quote(config.networkName)}`);
        lines.push(`network_secret = ${quote(config.networkSecret)}`);
        for (const peer of peers) {
            lines.push("");
            lines.push("[[peer]]");
            lines.push(`uri = ${quoteWebSocketUrl(peer)}`);
        }
        lines.push("");
        lines.push("[flags]");
        lines.push("no_tun = true");
        lines.push("use_smoltcp = true");
    }
    else {
        if (config.ipv4 !== undefined || (config.peers?.length ?? 0) !== 0) {
            throw new Error("Cloudflare relay configuration cannot dial peers");
        }
        lines.push("listeners = []");
        lines.push("");
        lines.push("[network_identity]");
        lines.push(`network_name = ${quote(config.networkName)}`);
        lines.push(`network_secret = ${quote(config.networkSecret)}`);
        lines.push("");
        lines.push("[flags]");
        lines.push("no_tun = false");
        lines.push("proxy_forward_by_system = true");
    }
    lines.push("disable_p2p = true");
    lines.push(`enable_encryption = ${config.encryption}`);
    lines.push("bind_device = false");
    if (config.relayNetworkWhitelist !== undefined) {
        lines.push(`relay_network_whitelist = ${quote(config.relayNetworkWhitelist)}`);
    }
    if (config.privateMode !== undefined) {
        lines.push(`private_mode = ${config.privateMode}`);
    }
    lines.push("");
    return lines.join("\n");
}
function requireText(value, field) {
    requireString(value, field);
    if (value.trim() === "") {
        throw new Error(`${field} must not be empty`);
    }
}
function requireString(value, field) {
    if (typeof value !== "string") {
        throw new Error(`${field} must be a string`);
    }
}
function quote(value) {
    return JSON.stringify(value);
}
function quoteWebSocketUrl(value) {
    requireText(value, "peer");
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error(`invalid WebSocket peer URL: ${value}`);
    }
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
        throw new Error(`WebSocket peer must use ws:// or wss://: ${value}`);
    }
    return quote(url.toString());
}
function isIpv4Prefix(value) {
    const separator = value.lastIndexOf("/");
    if (separator <= 0) {
        return false;
    }
    const prefix = Number(value.slice(separator + 1));
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        return false;
    }
    const octets = value.slice(0, separator).split(".").map(Number);
    return (octets.length === 4 &&
        octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255));
}
