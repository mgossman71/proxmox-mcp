import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pvesh, resolveGuest, ProxmoxError } from "../proxmox.js";
import { nodeParam, storageParam, vmidParam } from "../schemas.js";

export function registerInspectionTools(server: McpServer): void {
  // list_nodes
  server.registerTool(
    "list_nodes",
    {
      title: "List Nodes",
      description:
        "List all cluster nodes with status, CPU, memory, and version info.",
      inputSchema: {},
    },
    async () => {
      const data = await pvesh("get", "/cluster/status");
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // list_resources
  server.registerTool(
    "list_resources",
    {
      title: "List All Resources",
      description:
        "List all cluster resources: VMs, containers, nodes, storage pools, and SDN zones. Shows status, usage, and capacity.",
      inputSchema: {},
    },
    async () => {
      const data = await pvesh("get", "/cluster/resources");
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // list_vms
  server.registerTool(
    "list_vms",
    {
      title: "List QEMU VMs",
      description: "List all QEMU virtual machines on a node with CPU, memory, disk, and status.",
      inputSchema: { node: nodeParam },
    },
    async ({ node }) => {
      const data = await pvesh("get", `/nodes/${node}/qemu`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // list_containers
  server.registerTool(
    "list_containers",
    {
      title: "List LXC Containers",
      description: "List all LXC containers on a node with CPU, memory, disk, and status.",
      inputSchema: { node: nodeParam },
    },
    async ({ node }) => {
      const data = await pvesh("get", `/nodes/${node}/lxc`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // get_guest_status
  server.registerTool(
    "get_guest_status",
    {
      title: "Get Guest Status",
      description:
        "Get the live status of a VM or container (auto-detects type). Returns CPU, memory, disk, network, uptime, and power state.",
      inputSchema: {
        node: nodeParam,
        vmid: vmidParam,
      },
    },
    async ({ node, vmid }) => {
      const { node: guestNode, type } = await resolveGuest(node, vmid);
      const data = await pvesh("get", `/nodes/${guestNode}/${type}/${vmid}/status/current`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // get_guest_config
  server.registerTool(
    "get_guest_config",
    {
      title: "Get Guest Configuration",
      description:
        "Get the full configuration of a VM or container (auto-detects type). Returns disks, network, CPU, memory, boot order, and all settings.",
      inputSchema: {
        node: nodeParam,
        vmid: vmidParam,
      },
    },
    async ({ node, vmid }) => {
      const { node: guestNode, type } = await resolveGuest(node, vmid);
      const data = await pvesh("get", `/nodes/${guestNode}/${type}/${vmid}/config`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // list_storage
  server.registerTool(
    "list_storage",
    {
      title: "List Storage Pools",
      description: "List all storage pools on a node with type, capacity, used space, and available content types.",
      inputSchema: { node: nodeParam },
    },
    async ({ node }) => {
      const data = await pvesh("get", `/nodes/${node}/storage`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // list_storage_content
  server.registerTool(
    "list_storage_content",
    {
      title: "List Storage Content",
      description:
        "List files and images in a storage pool (ISOs, disk images, LXC templates, backups).",
      inputSchema: {
        node: nodeParam,
        storage: storageParam,
      },
    },
    async ({ node, storage }) => {
      const data = await pvesh("get", `/nodes/${node}/storage/${storage}/content`);
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    }
  );

  // list_isos
  server.registerTool(
    "list_isos",
    {
      title: "List Available ISOs",
      description:
        "List all available ISO files across all storage pools. Use the volid to install an OS when creating a VM.",
      inputSchema: { node: nodeParam },
    },
    async ({ node }) => {
      const storages = await pvesh("get", `/nodes/${node}/storage`);
      if (!Array.isArray(storages)) {
        throw new ProxmoxError("Unexpected (non-array) response from /nodes/{node}/storage");
      }
      const isos: any[] = [];
      for (const s of storages) {
        try {
          const content = await pvesh("get", `/nodes/${node}/storage/${s.storage}/content`);
          if (Array.isArray(content)) {
            const isoFiles = content.filter((c: any) => c.content === "iso");
            isos.push(...isoFiles);
          }
        } catch {
          // storage may not support content listing
        }
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(isos, null, 2) }] };
    }
  );

  // list_lxc_templates
  server.registerTool(
    "list_lxc_templates",
    {
      title: "List LXC Templates",
      description:
        "List all available LXC container templates. Use the volid when creating a new container.",
      inputSchema: { node: nodeParam },
    },
    async ({ node }) => {
      const storages = await pvesh("get", `/nodes/${node}/storage`);
      if (!Array.isArray(storages)) {
        throw new ProxmoxError("Unexpected (non-array) response from /nodes/{node}/storage");
      }
      const templates: any[] = [];
      for (const s of storages) {
        try {
          const content = await pvesh("get", `/nodes/${node}/storage/${s.storage}/content`);
          if (Array.isArray(content)) {
            const tmplFiles = content.filter((c: any) => c.content === "vztmpl");
            templates.push(...tmplFiles);
          }
        } catch {
          // skip
        }
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(templates, null, 2) }] };
    }
  );

  // list_tasks
  server.registerTool(
    "list_tasks",
    {
      title: "List Recent Tasks",
      description:
        "List recent tasks on a node (VM start/stop, snapshots, backups, updates, etc.).",
      inputSchema: {
        node: nodeParam,
        limit: z.number().default(20).describe("Maximum number of tasks to return"),
      },
    },
    async ({ node, limit }) => {
      const data = await pvesh("get", `/nodes/${node}/tasks`);
      const tasks = Array.isArray(data) ? data.slice(0, limit) : data;
      return { content: [{ type: "text" as const, text: JSON.stringify(tasks, null, 2) }] };
    }
  );
}