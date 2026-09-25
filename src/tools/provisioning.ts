import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pvesh, getNextVmid, generateMac, getGuestInfo, ProxmoxError, waitForTask, asString } from "../proxmox.js";
import { assertMovable } from "./migration.js";
import { nodeParam, storageParam } from "../schemas.js";

export function registerProvisioningTools(server: McpServer): void {
  // create_vm
  server.registerTool(
    "create_vm",
    {
      title: "Create QEMU VM",
      description:
        "Create a new QEMU virtual machine from an ISO image. The VM will be created in a stopped state with the ISO attached for installation. Use list_isos to find available ISOs. After installation, remove the ISO with get_guest_config to see the current config.",
      inputSchema: {
        name: z.string().describe("VM name (e.g. 'my-webserver')"),
        node: nodeParam,
        vmid: z.number().optional().describe("VM ID (auto-assigned if not specified)"),
        cpus: z.number().default(2).describe("Number of CPU cores"),
        sockets: z.number().default(1).describe("Number of CPU sockets"),
        cores: z.number().optional().describe("Cores per socket (defaults to cpus/sockets)"),
        memory: z.number().default(4096).describe("Memory in MB"),
        disk: z.number().default(32).describe("Disk size in GB"),
        storage: storageParam.default("local-lvm").describe("Storage pool for the disk"),
        iso: z.string().describe("ISO volid to boot from (e.g. 'local:iso/ubuntu-24.04.4-live-server-amd64.iso'). Use list_isos to find available ISOs."),
        ostype: z.string().default("l26").describe("OS type: l26 (Linux 2.6+), l26-kvm, s26 (Solaris), w2k3 (Win XP/2003), w2k8 (Win 2008), wwin7 (Win 7/2008R2), wwin8 (Win 8/2012), wwin10 (Win 10/2016+), wwin11 (Win 11/2022+), netbsd, ofreebsd, ofreebsd10, openbsd"),
        bridge: z.string().default("vmbr0").describe("Network bridge to attach"),
        agent: z.boolean().default(true).describe("Enable QEMU guest agent (Linux)"),
        onboot: z.boolean().default(true).describe("Start VM automatically when the host boots"),
      },
    },
    async ({
      name, node, vmid, cpus, sockets, cores, memory, disk,
      storage, iso, ostype, bridge, agent, onboot,
    }) => {
      const id = vmid ?? await getNextVmid();
      const mac = generateMac();
      const coreCount = cores ?? Math.ceil(cpus / sockets);

      const params: Record<string, string | number | boolean> = {
        vmid: id,
        name,
        sockets,
        cores: coreCount,
        cpu: "x86-64-v2-AES",
        memory,
        scsi0: `${storage}:${disk}`,
        scsihw: "virtio-scsi-single",
        ide2: `${iso},media=cdrom`,
        net0: `virtio=${mac},bridge=${bridge},firewall=1`,
        boot: "order=scsi0;ide2",
        ostype,
        onboot,
        agent,
      };

      const result = await pvesh("create", `/nodes/${node}/qemu`, params, 120000);
      await waitForTask(node, asString(result));

      return {
        content: [
          {
            type: "text" as const,
            text: `OK: VM '${name}' (VMID ${id}) created on node '${node}'.\n` +
              `  CPUs: ${cpus} (${sockets} socket(s) x ${coreCount} core(s))\n` +
              `  Memory: ${memory} MB\n` +
              `  Disk: ${disk} GB on ${storage}\n` +
              `  Network: virtio (${mac}) on ${bridge}\n` +
              `  ISO: ${iso}\n\n` +
              `The VM is stopped. Start it with start_guest(vmid=${id}) to begin OS installation.`,
          },
        ],
      };
    }
  );

  // create_container
  server.registerTool(
    "create_container",
    {
      title: "Create LXC Container",
      description:
        "Create a new LXC container from a template. The container will be created in a stopped state. Use list_lxc_templates to find available templates.",
      inputSchema: {
        name: z.string().describe("Container hostname (e.g. 'my-app')"),
        node: nodeParam,
        vmid: z.number().optional().describe("Container ID (auto-assigned if not specified)"),
        template: z.string().describe("Template volid (e.g. 'local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst'). Use list_lxc_templates to find available templates."),
        cpus: z.number().default(2).describe("Number of CPU cores"),
        memory: z.number().default(1024).describe("Memory in MB (minimum 128)"),
        swap: z.number().default(512).describe("Swap in MB"),
        disk: z.number().default(8).describe("Root filesystem size in GB"),
        storage: storageParam.default("local-lvm").describe("Storage pool for the rootfs"),
        bridge: z.string().default("vmbr0").describe("Network bridge to attach"),
        unprivileged: z.boolean().default(true).describe("Run as unprivileged container (recommended for security)"),
        onboot: z.boolean().default(true).describe("Start container automatically when the host boots"),
        description: z.string().optional().describe("Optional description"),
      },
    },
    async ({
      name, node, vmid, template, cpus, memory, swap, disk,
      storage, bridge, unprivileged, onboot, description,
    }) => {
      const id = vmid ?? await getNextVmid();
      const mac = generateMac();

      const params: Record<string, string | number | boolean> = {
        vmid: id,
        ostemplate: template,
        hostname: name,
        cores: cpus,
        memory,
        swap,
        rootfs: `${storage}:${disk}`,
        net0: `name=eth0,bridge=${bridge},hwaddr=${mac},ip=dhcp,type=veth`,
        unprivileged,
        onboot,
      };
      if (description) params.description = description;

      const result = await pvesh("create", `/nodes/${node}/lxc`, params, 120000);
      await waitForTask(node, asString(result));

      return {
        content: [
          {
            type: "text" as const,
            text: `OK: Container '${name}' (VMID ${id}) created on node '${node}'.\n` +
              `  Template: ${template}\n` +
              `  CPUs: ${cpus}\n` +
              `  Memory: ${memory} MB\n` +
              `  Swap: ${swap} MB\n` +
              `  Disk: ${disk} GB on ${storage}\n` +
              `  Network: veth (${mac}) on ${bridge}, IP: DHCP\n` +
              `  Unprivileged: ${unprivileged ? "yes" : "no"}\n\n` +
              `The container is stopped. Start it with start_guest(vmid=${id}).`,
          },
        ],
      };
    }
  );

  // clone_guest
  server.registerTool(
    "clone_guest",
    {
      title: "Clone Guest",
      description:
        "Clone an existing VM or container. A full clone copies all data (independent). A linked clone (QEMU only) creates a thin copy that references the original disk. The clone is created in a stopped state.",
      inputSchema: {
        node: nodeParam,
        vmid: z.number().describe("Source VM or container ID"),
        new_name: z.string().describe("Name for the clone"),
        new_vmid: z.number().optional().describe("VM ID for the clone (auto-assigned if not specified)"),
        full: z.boolean().default(true).describe("Full clone (independent copy). Set to false for a linked clone (QEMU only, much faster and uses less space)."),
        target_node: z.string().optional().describe("Target node for the clone (defaults to same node)"),
      },
    },
    async ({ node, vmid, new_name, new_vmid, full, target_node }) => {
      const newId = new_vmid ?? await getNextVmid();
      const info = await getGuestInfo(vmid);
      const target = target_node ?? node;

      // Block cross-node clones of dont-move tagged guests
      if (target !== info.node) {
        await assertMovable(info.node, info.type, vmid, info.name);
      }

      // The clone endpoint lives on the node the source guest is actually on,
      // which is not necessarily the `node` argument, and it owns the resulting
      // task — so the UPID has to be polled there too, not on the target.
      const sourceNode = info.node;

      const params: Record<string, string | number | boolean> = {
        target,
        newid: newId,
      };

      if (info.type === "qemu") {
        params.name = new_name;
        if (!full) params.snapshot = "current";
        const result = await pvesh("create", `/nodes/${sourceNode}/qemu/${vmid}/clone`, params, 300000);
        await waitForTask(sourceNode, asString(result));
      } else {
        // LXC clone names the guest with `hostname`; `name` is the QEMU spelling
        params.hostname = new_name;
        if (!full) params.snapshot = "current";
        const result = await pvesh("create", `/nodes/${sourceNode}/lxc/${vmid}/clone`, params, 300000);
        await waitForTask(sourceNode, asString(result));
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `OK: Cloned ${info.type} VMID ${vmid} ('${info.name}') → VMID ${newId} ('${new_name}') on node '${target}'.\n` +
              `Clone type: ${full ? "full (independent)" : "linked (references original disk)"}\n` +
              `The clone is stopped. Start it with start_guest(vmid=${newId}).`,
          },
        ],
      };
    }
  );

  // set_guest_config
  server.registerTool(
    "set_guest_config",
    {
      title: "Modify Guest Configuration",
      description:
        "Modify the configuration of a running or stopped VM/container. Supports changing CPU count, memory, adding/changing network interfaces, and other settings. The guest should be stopped for hardware changes (CPU, memory).",
      inputSchema: {
        node: nodeParam,
        vmid: z.number().describe("VM or container ID"),
        cpus: z.number().optional().describe("New number of CPU cores"),
        memory: z.number().optional().describe("New memory in MB"),
        swap: z.number().optional().describe("New swap in MB (LXC only)"),
        name: z.string().optional().describe("Rename the guest"),
        onboot: z.boolean().optional().describe("Set auto-start on host boot"),
      },
    },
    async ({ node, vmid, cpus, memory, swap, name, onboot }) => {
      const info = await getGuestInfo(vmid);
      const basePath = `/nodes/${info.node}/${info.type}/${vmid}/config`;

      const params: Record<string, string | number | boolean> = {};

      if (cpus !== undefined) params.cores = cpus;
      if (memory !== undefined) params.memory = memory;
      if (swap !== undefined && info.type === "lxc") params.swap = swap;
      if (name !== undefined) {
        if (info.type === "lxc") params.hostname = name;
        else params.name = name;
      }
      if (onboot !== undefined) params.onboot = onboot;

      if (Object.keys(params).length === 0) {
        throw new ProxmoxError("No configuration changes specified");
      }

      const result = await pvesh("set", basePath, params, 120000);
      await waitForTask(info.node, asString(result));

      const changes = Object.entries(params)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `OK: Configuration updated for VMID ${vmid} ('${info.name}'):\n${changes}`,
          },
        ],
      };
    }
  );
}
