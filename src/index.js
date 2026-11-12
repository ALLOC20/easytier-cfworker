import coreModule from "./generated/easytier_core.wasm";
import { createCloudflareApplication } from "./app.js";
export function createEasyTierCloudflare(options) {
    return createCloudflareApplication(coreModule, options);
}
