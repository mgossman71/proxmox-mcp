import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

// Mock the proxmox module
vi.mock("../src/proxmox.js", () => {
  const pvesh = vi.fn();
  const getGuestInfo = vi.fn();

  class ProxmoxError extends Error {
    exitCode: number;
    stderr: string;
    constructor(message: string, exitCode = 1, stderr = "") {
      super(message);
      this.name = "ProxmoxError";
      this.exitCode = exitCode;
      this.stderr = stderr;
    }
  }

  async function resolveGuest(node: string, vmid: number) {
    try {
      await pvesh("get", `/nodes/${node}/qemu/${vmid}/status/current`);
      return { node, type: "qemu" as const };
    } catch { /* not qemu */ }
    try {
      await pvesh("get", `/nodes/${node}/lxc/${vmid}/status/current`);
      return { node, type: "lxc" as const };
    } catch { /* not lxc */ }
    const info = await getGuestInfo(vmid);
    return { node: info.node, type: info.type };
  }

  return {
    pvesh,
    getGuestInfo,
    resolveGuest,
    waitForTask: vi.fn(),
    getNextVmid: vi.fn(),
    generateMac: vi.fn(() => "BC:24:11:AA:BB:CC"),
    asString: (v: any) => (typeof v === "string" ? v : null),
    asObject: (v: any) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : null),
    ProxmoxError,
    ProxmoxParseError: class ProxmoxParseError extends ProxmoxError {
      constructor(message: string) { super(message); this.name = "ProxmoxParseError"; }
    },
  };
});

import { pvesh, getGuestInfo } from "../src/proxmox.js";
import { registerInspectionTools } from "../src/tools/inspection.js";

const mockPvesh = vi.mocked(pvesh);
const mockGetGuestInfo = vi.mocked(getGuestInfo);

// Mock McpServer to capture registered tools
function createMockServer() {
  const tools: Record<string, any> = {};
  return {
    tools,
    registerTool(name: string, meta: any, handler: any) {
      // Apply the tool's own inputSchema the way the MCP SDK does, so every
      // `.default()` is exercised and tests see the values production sees.
      const schema = meta?.inputSchema ? z.object(meta.inputSchema) : null;
      tools[name] = async (args: any = {}) =>
        handler(schema ? schema.parse(args) : args);
    },
  } as any;
}

beforeEach(() => {
  vi.resetAllMocks();
  mockGetGuestInfo.mockImplementation(async (vmid: number) => {
    const resources = await mockPvesh("get", "/cluster/resources");
    if (!Array.isArray(resources)) throw new Error("Unexpected (non-array) response from /cluster/resources");
    const match = (resources as any[]).find((r: any) => r.vmid === vmid && (r.type === "qemu" || r.type === "lxc"));
    if (!match) throw new Error(`VMID ${vmid} not found in cluster`);
    return { node: match.node, type: match.type, name: match.name };
  });
});

describe("inspection tools", () => {
  let server: any;
  beforeEach(() => {
    server = createMockServer();
    registerInspectionTools(server);
  });

  it("should register all 11 inspection tools", () => {
    expect(Object.keys(server.tools).sort()).toEqual([
      "get_guest_config",
      "get_guest_status",
      "list_containers",
      "list_isos",
      "list_lxc_templates",
      "list_nodes",
      "list_resources",
      "list_storage",
      "list_storage_content",
      "list_tasks",
      "list_vms",
    ]);
  });

  describe("list_nodes", () => {
    it("should return cluster status", async () => {
      const data = [{ node: "pve", status: "online" }];
      mockPvesh.mockResolvedValue(data);
      const result = await server.tools["list_nodes"]({});
      expect(mockPvesh).toHaveBeenCalledWith("get", "/cluster/status");
      expect(result.content[0].text).toContain('"node": "pve"');
    });

    it("should propagate errors", async () => {
      mockPvesh.mockRejectedValue(new Error("SSH failed"));
      await expect(server.tools["list_nodes"]({})).rejects.toThrow("SSH failed");
    });
  });

  describe("list_resources", () => {
    it("should return cluster resources", async () => {
      const data = [{ vmid: 100, type: "qemu" }];
      mockPvesh.mockResolvedValue(data);
      const result = await server.tools["list_resources"]({});
      expect(mockPvesh).toHaveBeenCalledWith("get", "/cluster/resources");
      expect(result.content[0].text).toContain('"vmid": 100');
    });

    it("should propagate errors", async () => {
      mockPvesh.mockRejectedValue(new Error("SSH failed"));
      await expect(server.tools["list_resources"]({})).rejects.toThrow("SSH failed");
    });
  });

  describe("list_vms", () => {
    it("should list QEMU VMs on the specified node", async () => {
      const data = [{ vmid: 100, name: "VM1" }];
      mockPvesh.mockResolvedValue(data);
      const result = await server.tools["list_vms"]({ node: "pve" });
      expect(mockPvesh).toHaveBeenCalledWith("get", "/nodes/pve/qemu");
      expect(result.content[0].text).toContain('"name": "VM1"');
    });

    it("should propagate errors", async () => {
      mockPvesh.mockRejectedValue(new Error("node not found"));
      await expect(server.tools["list_vms"]({ node: "bad" })).rejects.toThrow("node not found");
    });
  });

  describe("list_containers", () => {
    it("should list LXC containers on the specified node", async () => {
      const data = [{ vmid: 101, name: "CT1" }];
      mockPvesh.mockResolvedValue(data);
      const result = await server.tools["list_containers"]({ node: "pve" });
      expect(mockPvesh).toHaveBeenCalledWith("get", "/nodes/pve/lxc");
      expect(result.content[0].text).toContain('"name": "CT1"');
    });

    it("should propagate errors", async () => {
      mockPvesh.mockRejectedValue(new Error("node not found"));
      await expect(server.tools["list_containers"]({ node: "bad" })).rejects.toThrow("node not found");
    });
  });

  describe("get_guest_status", () => {
    it("should find QEMU VM on specified node", async () => {
      const data = { status: "running", pid: 1234 };
      mockPvesh.mockResolvedValue(data);
      const result = await server.tools["get_guest_status"]({ node: "pve", vmid: 100 });
      expect(mockPvesh).toHaveBeenCalledWith("get", "/nodes/pve/qemu/100/status/current");
      expect(result.content[0].text).toContain('"status": "running"');
    });

    it("should fall back to LXC when QEMU fails", async () => {
      const data = { status: "running" };
      mockPvesh.mockRejectedValueOnce(new Error("not found"));
      mockPvesh.mockResolvedValueOnce(data); // resolveGuest LXC check
      mockPvesh.mockResolvedValueOnce(data); // actual status fetch
      const result = await server.tools["get_guest_status"]({ node: "pve", vmid: 101 });
      expect(mockPvesh).toHaveBeenCalledWith("get", "/nodes/pve/qemu/101/status/current");
      expect(mockPvesh).toHaveBeenCalledWith("get", "/nodes/pve/lxc/101/status/current");
      expect(result.content[0].text).toContain('"status": "running"');
    });

    it("should fall back to cluster search when both node lookups fail", async () => {
      const statusData = { status: "running" };
      mockPvesh
        .mockRejectedValueOnce(new Error("not found"))
        .mockRejectedValueOnce(new Error("not found"))
        .mockResolvedValueOnce(statusData);
      mockGetGuestInfo.mockResolvedValue({ node: "pve2", type: "qemu", name: "VM" });

      const result = await server.tools["get_guest_status"]({ node: "pve", vmid: 200 });
      expect(mockGetGuestInfo).toHaveBeenCalledWith(200);
      expect(mockPvesh).toHaveBeenCalledWith("get", "/nodes/pve2/qemu/200/status/current");
      expect(result.content[0].text).toContain('"status": "running"');
    });

    it("should propagate errors when guest not found anywhere", async () => {
      mockPvesh.mockRejectedValue(new Error("not found"));
      mockGetGuestInfo.mockRejectedValue(new Error("VMID 999 not found in cluster"));
      await expect(server.tools["get_guest_status"]({ node: "pve", vmid: 999 })).rejects.toThrow();
    });
  });

  describe("get_guest_config", () => {
    it("should find QEMU VM config on specified node", async () => {
      const data = { name: "VM1", cores: 4 };
      mockPvesh.mockResolvedValue(data);
      const result = await server.tools["get_guest_config"]({ node: "pve", vmid: 100 });
      expect(mockPvesh).toHaveBeenCalledWith("get", "/nodes/pve/qemu/100/config");
      expect(result.content[0].text).toContain('"cores": 4');
    });

    it("should fall back to LXC when QEMU fails", async () => {
      const data = { hostname: "CT1" };
      mockPvesh.mockRejectedValueOnce(new Error("not found"));
      mockPvesh.mockResolvedValueOnce(data); // resolveGuest LXC check
      mockPvesh.mockResolvedValueOnce(data); // actual config fetch
      const result = await server.tools["get_guest_config"]({ node: "pve", vmid: 101 });
      expect(mockPvesh).toHaveBeenCalledWith("get", "/nodes/pve/lxc/101/config");
      expect(result.content[0].text).toContain('"hostname": "CT1"');
    });

    it("should fall back to cluster search", async () => {
      const data = { name: "VM" };
      mockPvesh
        .mockRejectedValueOnce(new Error("nf"))
        .mockRejectedValueOnce(new Error("nf"))
        .mockResolvedValueOnce(data);
      mockGetGuestInfo.mockResolvedValue({ node: "node2", type: "lxc", name: "CT" });
      const result = await server.tools["get_guest_config"]({ node: "pve", vmid: 200 });
      expect(mockGetGuestInfo).toHaveBeenCalledWith(200);
      expect(mockPvesh).toHaveBeenCalledWith("get", "/nodes/node2/lxc/200/config");
      expect(result.content[0].text).toContain('"name": "VM"');
    });

    it("should propagate errors when not found anywhere", async () => {
      mockPvesh.mockRejectedValue(new Error("nf"));
      mockGetGuestInfo.mockRejectedValue(new Error("not found"));
      await expect(server.tools["get_guest_config"]({ node: "pve", vmid: 999 })).rejects.toThrow();
    });
  });

  describe("list_storage", () => {
    it("should list storage pools", async () => {
      const data = [{ storage: "local", type: "dir" }];
      mockPvesh.mockResolvedValue(data);
      const result = await server.tools["list_storage"]({ node: "pve" });
      expect(mockPvesh).toHaveBeenCalledWith("get", "/nodes/pve/storage");
      expect(result.content[0].text).toContain('"storage": "local"');
    });

    it("should propagate errors", async () => {
      mockPvesh.mockRejectedValue(new Error("fail"));
      await expect(server.tools["list_storage"]({ node: "pve" })).rejects.toThrow("fail");
    });
  });

  describe("list_storage_content", () => {
    it("should list content in a storage pool", async () => {
      const data = [{ volid: "local:iso/test.iso", content: "iso" }];
      mockPvesh.mockResolvedValue(data);
      const result = await server.tools["list_storage_content"]({ node: "pve", storage: "local" });
      expect(mockPvesh).toHaveBeenCalledWith("get", "/nodes/pve/storage/local/content");
      expect(result.content[0].text).toContain("test.iso");
    });

    it("should propagate errors", async () => {
      mockPvesh.mockRejectedValue(new Error("storage not found"));
      await expect(server.tools["list_storage_content"]({ node: "pve", storage: "bad" })).rejects.toThrow("storage not found");
    });
  });

  describe("list_isos", () => {
    it("should aggregate ISOs from all storages", async () => {
      const storages = [{ storage: "local" }, { storage: "local-lvm" }];
      mockPvesh
        .mockResolvedValueOnce(storages)
        .mockResolvedValueOnce([{ volid: "local:iso/a.iso", content: "iso" }, { volid: "local:iso/b.img", content: "vztmpl" }])
        .mockRejectedValueOnce(new Error("no content listing"));

      const result = await server.tools["list_isos"]({ node: "pve" });
      expect(result.content[0].text).toContain("a.iso");
      expect(result.content[0].text).not.toContain("b.img");
    });

    it("should return empty array when no ISOs found", async () => {
      mockPvesh
        .mockResolvedValueOnce([{ storage: "local" }])
        .mockResolvedValueOnce([{ volid: "local:tpl/x.tar", content: "vztmpl" }]);

      const result = await server.tools["list_isos"]({ node: "pve" });
      expect(result.content[0].text).toBe("[]");
    });

    it("should propagate errors from storage listing", async () => {
      mockPvesh.mockRejectedValueOnce(new Error("fail"));
      await expect(server.tools["list_isos"]({ node: "pve" })).rejects.toThrow("fail");
    });

    it("should throw when storage listing returns non-array", async () => {
      mockPvesh.mockResolvedValueOnce({ message: "unexpected" });
      await expect(server.tools["list_isos"]({ node: "pve" })).rejects.toThrow(
        "Unexpected (non-array) response"
      );
    });

    it("should skip storages whose content listing returns non-array", async () => {
      const storages = [{ storage: "local" }, { storage: "bad" }];
      mockPvesh
        .mockResolvedValueOnce(storages)
        .mockResolvedValueOnce([{ volid: "local:iso/a.iso", content: "iso" }])
        .mockResolvedValueOnce({ message: "unsupported" }); // non-array content

      const result = await server.tools["list_isos"]({ node: "pve" });
      expect(result.content[0].text).toContain("a.iso");
      expect(result.content[0].text).not.toContain("unsupported");
    });
  });

  describe("list_lxc_templates", () => {
    it("should aggregate templates from all storages", async () => {
      const storages = [{ storage: "local" }];
      mockPvesh
        .mockResolvedValueOnce(storages)
        .mockResolvedValueOnce([
          { volid: "local:vztmpl/ubuntu-24.04.tar.zst", content: "vztmpl" },
          { volid: "local:iso/win.iso", content: "iso" },
        ]);

      const result = await server.tools["list_lxc_templates"]({ node: "pve" });
      expect(result.content[0].text).toContain("ubuntu-24.04");
      expect(result.content[0].text).not.toContain("win.iso");
    });

    it("should skip storages that fail", async () => {
      const storages = [{ storage: "local" }, { storage: "bad" }];
      mockPvesh
        .mockResolvedValueOnce(storages)
        .mockResolvedValueOnce([{ volid: "local:vztmpl/t.tar.zst", content: "vztmpl" }])
        .mockRejectedValueOnce(new Error("access denied"));

      const result = await server.tools["list_lxc_templates"]({ node: "pve" });
      expect(result.content[0].text).toContain("t.tar.zst");
    });

    it("should propagate errors from storage listing", async () => {
      mockPvesh.mockRejectedValueOnce(new Error("fail"));
      await expect(server.tools["list_lxc_templates"]({ node: "pve" })).rejects.toThrow("fail");
    });

    it("should throw when storage listing returns non-array", async () => {
      mockPvesh.mockResolvedValueOnce({ message: "unexpected" });
      await expect(server.tools["list_lxc_templates"]({ node: "pve" })).rejects.toThrow(
        "Unexpected (non-array) response"
      );
    });

    it("should skip storages whose content listing returns non-array", async () => {
      const storages = [{ storage: "local" }, { storage: "bad" }];
      mockPvesh
        .mockResolvedValueOnce(storages)
        .mockResolvedValueOnce([{ volid: "local:vztmpl/a.tar", content: "vztmpl" }])
        .mockResolvedValueOnce({ message: "unsupported" }); // non-array content

      const result = await server.tools["list_lxc_templates"]({ node: "pve" });
      expect(result.content[0].text).toContain("a.tar");
      expect(result.content[0].text).not.toContain("unsupported");
    });
  });

  describe("list_tasks", () => {
    it("should return tasks limited by count", async () => {
      const data = Array.from({ length: 30 }, (_, i) => ({ upid: `UPID:${i}` }));
      mockPvesh.mockResolvedValue(data);
      const result = await server.tools["list_tasks"]({ node: "pve", limit: 5 });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed).toHaveLength(5);
    });

    it("should handle non-array response", async () => {
      const data = { message: "no tasks" };
      mockPvesh.mockResolvedValue(data);
      const result = await server.tools["list_tasks"]({ node: "pve", limit: 20 });
      expect(result.content[0].text).toContain("no tasks");
    });

    it("should propagate errors", async () => {
      mockPvesh.mockRejectedValue(new Error("fail"));
      await expect(server.tools["list_tasks"]({ node: "pve", limit: 10 })).rejects.toThrow("fail");
    });
  });
});