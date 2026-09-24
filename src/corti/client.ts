import { CortiClient, type CortiEnvironmentUrls } from "@corti/sdk";
import type { Config } from "../config.js";

/**
 * Creates the Corti client. Client-credentials tokens are fetched and refreshed by the SDK.
 * `environment` overrides the region's URLs (used to point tests at a fake server).
 */
export function createCortiClient(config: Config["corti"], environment?: CortiEnvironmentUrls): CortiClient {
  return new CortiClient({
    tenantName: config.tenant,
    environment: environment ?? config.region,
    auth: { clientId: config.clientId, clientSecret: config.clientSecret },
  });
}
