import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pvesh, ProxmoxError, waitForTask } from "../proxmox.js";

const nodeParam = z.string().default("pve").describe("Proxmox node name");
const vmidParam = z.number().describe("VM or container ID");

/**
 * Resolve the guest type (qemu/lxc) for a vmid on a given node.
 * Falls back to cluster-wide search if not found on the specified node.
 */
async function resolveGuestPath(
  node: string,
  vmid: number
): Promise<string> {
  // Try QEMU first, then LXC
  try {
    await pvesh("get", `/nodes/${node}/qemu/${vmid}/status/current`);
    return `/nodes/${node}/qemu/${vmid}`;
  } catch { /* not a QEMU VM on this node */ }

  try {
    await pvesh("get", `/nodes/${node}/lxc/${vmid}/status/current`);
    return `/nodes/${node}/lxc/${vmid}`;
  } catch { /* not an LXC container on this node */ }

  // Fall back to cluster-wide search
  const resources = await pvesh("get", "/cluster/resources");
  const match = resources.find(
    (r: any) => r.vmid === vmid && (r.type === "qemu" || r.type === "lxc")
  );
  if (!match) {
    throw new ProxmoxError(`Guest with VMID ${vmid} not found in cluster`);
  }
  return `/nodes/${match.node}/${match.type}/${vmid}`;
}

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
      const basePath = await resolveGuestPath(node, vmid);
      const result = await pvesh("create", `${basePath}/status/${action}`, {}, 120000);
      await waitForTask(node, result);
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