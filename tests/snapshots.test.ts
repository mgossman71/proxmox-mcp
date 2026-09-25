import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

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

import { pvesh, getGuestInfo, waitForTask } from "../src/proxmox.js";
import { registerSnapshotTools } from "../src/tools/snapshots.js";

const mockPvesh = vi.mocked(pvesh);
const mockGetGuestInfo = vi.mocked(getGuestInfo);
const mockWaitForTask = vi.mocked(waitForTask);

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

describe("snapshot tools", () => {
  let server: any;
  beforeEach(() => {
    server = createMockServer();
    registerSnapshotTools(server);
  });

  it("should register all 2 snapshot tools", () => {
    expect(Object.keys(server.tools).sort()).toEqual([
      "create_snapshot",
      "list_snapshots",
    ]);
  });

  describe("resolveGuestBase (via list_snapshots)", () => {
    it("should find QEMU on specified node", async () => {
      mockPvesh.mockResolvedValueOnce({ status: "running" }); // qemu check
      mockPvesh.mockResolvedValueOnce([]); // list snapshots

      await server.tools["list_snapshots"]({ node: "pve", vmid: 100 });
      expect(mockPvesh).toHaveBeenCalledWith("get", "/nodes/pve/qemu/100/status/current");
      expect(mockPvesh).toHaveBeenCalledWith("get", "/nodes/pve/qemu/100/snapshot");
    });

    it("should fall back to LXC", async () => {
      mockPvesh
        .mockRejectedValueOnce(new Error("nf")) // qemu
        .mockResolvedValueOnce({ status: "stopped" }) // lxc
        .mockResolvedValueOnce([]);

      await server.tools["list_snapshots"]({ node: "pve", vmid: 101 });
      expect(mockPvesh).toHaveBeenCalledWith("get", "/nodes/pve/lxc/101/snapshot");
    });

    it("should fall back to cluster search", async () => {
      mockPvesh
        .mockRejectedValueOnce(new Error("nf")) // qemu on pve
        .mockRejectedValueOnce(new Error("nf")) // lxc on pve
        .mockResolvedValueOnce([]);
      mockGetGuestInfo.mockResolvedValue({ node: "node2", type: "lxc", name: "CT" });

      await server.tools["list_snapshots"]({ node: "pve", vmid: 300 });
      expect(mockGetGuestInfo).toHaveBeenCalledWith(300);
      expect(mockPvesh).toHaveBeenCalledWith("get", "/nodes/node2/lxc/300/snapshot");
    });
  });

  describe("list_snapshots", () => {
    it("should return snapshot list", async () => {
      mockPvesh
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValueOnce([{ name: "snap1" }, { name: "snap2" }]);

      const result = await server.tools["list_snapshots"]({ node: "pve", vmid: 100 });
      expect(result.content[0].text).toContain("snap1");
      expect(result.content[0].text).toContain("snap2");
    });

    it("should propagate errors", async () => {
      mockPvesh
        .mockResolvedValueOnce({ status: "running" })
        .mockRejectedValueOnce(new Error("snapshot list failed"));
      await expect(server.tools["list_snapshots"]({ node: "pve", vmid: 100 })).rejects.toThrow("snapshot list failed");
    });
  });

  describe("create_snapshot", () => {
    it("should create a snapshot with name only", async () => {
      mockPvesh
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValueOnce("UPID:pve:snap:123:456:");
      mockWaitForTask.mockResolvedValue(undefined);

      const result = await server.tools["create_snapshot"]({ node: "pve", vmid: 100, name: "pre-upgrade" });
      expect(mockPvesh).toHaveBeenCalledWith(
        "create",
        "/nodes/pve/qemu/100/snapshot",
        { snapshotname: "pre-upgrade" },
        120000
      );
      expect(mockWaitForTask).toHaveBeenCalledWith("pve", "UPID:pve:snap:123:456:");
      expect(result.content[0].text).toContain("Snapshot 'pre-upgrade' created");
    });

    it("should include description if provided", async () => {
      mockPvesh
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValueOnce(null);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["create_snapshot"]({
        node: "pve", vmid: 100, name: "snap1", description: "before change"
      });
      expect(mockPvesh).toHaveBeenCalledWith(
        "create",
        "/nodes/pve/qemu/100/snapshot",
        { snapshotname: "snap1", description: "before change" },
        120000
      );
    });

    it("should propagate errors", async () => {
      mockPvesh
        .mockResolvedValueOnce({ status: "running" })
        .mockRejectedValueOnce(new Error("snapshot exists"));
      await expect(
        server.tools["create_snapshot"]({ node: "pve", vmid: 100, name: "snap1" })
      ).rejects.toThrow("snapshot exists");
    });

    it("should propagate task errors", async () => {
      mockPvesh
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValueOnce("UPID:pve:snap:1:2:");
      mockWaitForTask.mockRejectedValue(new Error("task failed"));
      await expect(
        server.tools["create_snapshot"]({ node: "pve", vmid: 100, name: "snap1" })
      ).rejects.toThrow("task failed");
    });
  });

});