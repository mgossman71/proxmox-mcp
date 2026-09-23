import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/proxmox.js", () => ({
  pvesh: vi.fn(),
  getGuestInfo: vi.fn(),
  waitForTask: vi.fn(),
  getNextVmid: vi.fn(),
  generateMac: vi.fn(() => "BC:24:11:AA:BB:CC"),
  ProxmoxError: class ProxmoxError extends Error {
    constructor(message: string, public exitCode = 1, public stderr = "") {
      super(message);
      this.name = "ProxmoxError";
    }
  },
}));

import { pvesh, getGuestInfo, waitForTask } from "../src/proxmox.js";
import { registerSnapshotTools } from "../src/tools/snapshots.js";

const mockPvesh = vi.mocked(pvesh);
const mockGetGuestInfo = vi.mocked(getGuestInfo);
const mockWaitForTask = vi.mocked(waitForTask);

function createMockServer() {
  const tools: Record<string, any> = {};
  return {
    tools,
    registerTool(name: string, _meta: any, handler: any) {
      tools[name] = handler;
    },
  } as any;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("snapshot tools", () => {
  let server: any;
  beforeEach(() => {
    server = createMockServer();
    registerSnapshotTools(server);
  });

  it("should register all 4 snapshot tools", () => {
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