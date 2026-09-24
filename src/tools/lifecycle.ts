import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pvesh, resolveGuest, waitForTask, asString } from "../proxmox.js";
import { nodeParam, vmidParam } from "../schemas.js";

function registerLifecycleAction(
  server: McpServer,
  name: string,
  title: string,
  description: string,
  action: string
) {
  server.registerTool(
    name,
    {
      title,
      description,
      inputSchema: {
        node: nodeParam,
        vmid: vmidParam,
      },
    },
    async ({ node, vmid }) => {
      const { node: guestNode, type } = await resolveGuest(node, vmid);
      const basePath = `/nodes/${guestNode}/${type}/${vmid}`;
      const result = await pvesh("create", `${basePath}/status/${action}`, {}, 120000);
      // Poll the *resolved* node, not the one the caller passed in (#3).
      await waitForTask(guestNode, asString(result));
      return {
        content: [
          {
            type: "text" as const,
            text: `OK: ${action} command sent for VMID ${vmid}. Use get_guest_status to verify the new state.`,
          },
        ],
      };
    }
  );
}

export function registerLifecycleTools(server: McpServer): void {
  registerLifecycleAction(
    server,
    "start_guest",
    "Start Guest",
    "Start a VM or LXC container (auto-detects type).",
    "start"
  );

  registerLifecycleAction(
    server,
    "stop_guest",
    "Stop Guest",
    "Force-stop a VM or LXC container (like pulling the power plug). Use shutdown_guest for a graceful stop.",
    "stop"
  );

  registerLifecycleAction(
    server,
    "shutdown_guest",
    "Shutdown Guest",
    "Gracefully shut down a VM or LXC container (sends ACPI poweroff / shutdown signal).",
    "shutdown"
  );

  registerLifecycleAction(
    server,
    "reboot_guest",
    "Reboot Guest",
    "Reboot a VM or LXC container (force restart).",
    "restart"
  );

  registerLifecycleAction(
    server,
    "suspend_guest",
    "Suspend Guest",
    "Suspend a running VM (freezes it in memory). Only works on QEMU VMs that are currently running.",
    "suspend"
  );

  registerLifecycleAction(
    server,
    "resume_guest",
    "Resume Guest",
    "Resume a suspended VM back to running state.",
    "resume"
  );
}