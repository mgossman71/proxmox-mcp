import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pvesh, getGuestInfo, waitForTask } from "../proxmox.js";

const nodeParam = z.string().default("pve").describe("Proxmox node name");
const vmidParam = z.number().describe("VM or container ID");

async function resolveGuestBase(
  node: string,
  vmid: number
): Promise<string> {
  try {
    await pvesh("get", `/nodes/${node}/qemu/${vmid}/status/current`);
    return `/nodes/${node}/qemu/${vmid}`;
  } catch { /* not qemu */ }
  try {
    await pvesh("get", `/nodes/${node}/lxc/${vmid}/status/current`);
    return `/nodes/${node}/lxc/${vmid}`;
  } catch { /* not lxc */ }
  const info = await getGuestInfo(vmid);
  return `/nodes/${info.node}/${info.type}/${vmid}`;
}

export function registerSnapshotTools(server: McpServer): void {
  // list_snapshots
  server.registerTool(
    "list_snapshots",
    {
      title: "List Snapshots",
      description:
        "List all snapshots of a VM or container. Shows snapshot names, descriptions, digests, and whether the VM is running at that snapshot.",
      inputSchema: {
        node: nodeParam,
        vmid: vmidParam,
      },
    },
    async ({ node, vmid }) => {
      const base = await resolveGuestBase(node, vmid);
      const data = await pvesh("get", `${base}/snapshot`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // create_snapshot
  server.registerTool(
    "create_snapshot",
    {
      title: "Create Snapshot",
      description:
        "Create a snapshot of a VM or container. The VM should be running for a consistent snapshot (but it also works when stopped).",
      inputSchema: {
        node: nodeParam,
        vmid: vmidParam,
        name: z.string().describe("Snapshot name (e.g. 'before-upgrade')"),
        description: z.string().optional().describe("Optional description for the snapshot"),
      },
    },
    async ({ node, vmid, name, description }) => {
      const base = await resolveGuestBase(node, vmid);
      const params: Record<string, string | number | boolean> = {
        snapshotname: name,
      };
      if (description) params.description = description;

      const result = await pvesh("create", `${base}/snapshot`, params, 120000);
      await waitForTask(node, result);
      return {
        content: [
          {
            type: "text" as const,
            text: `OK: Snapshot '${name}' created for VMID ${vmid}.`,
          },
        ],
      };
    }
  );

}