import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerInspectionTools } from "./tools/inspection.js";
import { registerLifecycleTools } from "./tools/lifecycle.js";
import { registerSnapshotTools } from "./tools/snapshots.js";
import { registerProvisioningTools } from "./tools/provisioning.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "proxmox-mcp",
    version: "1.0.0",
  });

  registerInspectionTools(server);
  registerLifecycleTools(server);
  registerSnapshotTools(server);
  registerProvisioningTools(server);

  return server;
}