import { describe, it, expect, vi, beforeEach } from "vitest";
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

import { pvesh, waitForTask, getNextVmid } from "../src/proxmox.js";
import { registerMigrationTools } from "../src/tools/migration.js";

const mockPvesh = vi.mocked(pvesh);
const mockWaitForTask = vi.mocked(waitForTask);
const mockGetNextVmid = vi.mocked(getNextVmid);

function createMockServer() {
  const tools: Record<string, any> = {};
  return {
    tools,
    registerTool(name: string, _meta: any, handler: any) {
      tools[name] = handler;
    },
  } as any;
}

describe("migration tools", () => {
  let server: any;

  beforeEach(() => {
    vi.resetAllMocks();
    server = createMockServer();
    registerMigrationTools(server);
  });

  it("should register both migration tools", () => {
    expect(Object.keys(server.tools).sort()).toEqual([
      "drain_node",
      "migrate_guest",
    ]);
  });

  // ─── migrate_guest ──────────────────────────────────────────────────────────

  describe("migrate_guest", () => {
    it("should migrate a QEMU VM to target node", async () => {
      mockPvesh
        .mockResolvedValueOnce({ status: "running" }) // resolveGuest: qemu check
        .mockResolvedValueOnce({ tags: "" })          // getGuestTags: config (no tags)
        .mockResolvedValueOnce("UPID:pve:123:456:migrate");
      mockWaitForTask.mockResolvedValue(undefined);

      const result = await server.tools["migrate_guest"]({
        node: "pve",
        vmid: 100,
        target_node: "node2",
      });

      expect(mockPvesh).toHaveBeenCalledWith(
        "create",
        "/nodes/pve/qemu/100/migrate",
        { target: "node2", bwlimit: 150, online: 1 },
        600000
      );
      expect(mockWaitForTask).toHaveBeenCalledWith("pve", "UPID:pve:123:456:migrate", 600000);
      expect(result.content[0].text).toContain("Migrated qemu VMID 100");
      expect(result.content[0].text).toContain("node2");
    });

    it("should migrate an LXC container to target node", async () => {
      mockPvesh
        .mockRejectedValueOnce(new Error("nf"))        // resolveGuest: qemu fails
        .mockResolvedValueOnce({ status: "running" })  // resolveGuest: lxc check
        .mockResolvedValueOnce({ tags: "" })           // getGuestTags: config (no tags)
        .mockResolvedValueOnce("UPID:pve:123:456:move");
      mockWaitForTask.mockResolvedValue(undefined);

      const result = await server.tools["migrate_guest"]({
        node: "pve",
        vmid: 200,
        target_node: "node2",
      });

      expect(mockPvesh).toHaveBeenCalledWith(
        "create",
        "/nodes/pve/lxc/200/migrate",
        { target: "node2", bwlimit: 153600, restart: 1 },
        600000
      );
      expect(result.content[0].text).toContain("Migrated lxc VMID 200");
    });

    it("should fall back to clone when LXC move endpoint is unavailable", async () => {
      mockPvesh
        .mockRejectedValueOnce(new Error("nf"))                // resolveGuest: qemu fails
        .mockResolvedValueOnce({ status: "running" })          // resolveGuest: lxc check
        .mockResolvedValueOnce({ tags: "" })                   // getGuestTags: config (no tags)
        .mockRejectedValueOnce(new Error(                     // move endpoint: not available
          "No 'create' handler defined for '/nodes/pve/lxc/200/migrate'"
        ))
        .mockResolvedValueOnce({ hostname: "myct", tags: "" }) // config read for clone fallback
        .mockResolvedValueOnce("UPID:pve:1:clone")            // clone task
        .mockResolvedValueOnce("UPID:node2:2:start")          // start clone
        .mockResolvedValueOnce("UPID:pve:3:stop")             // stop original
        .mockResolvedValueOnce("UPID:pve:4:delete");          // delete original
      mockGetNextVmid.mockResolvedValue(300);
      mockWaitForTask.mockResolvedValue(undefined);

      const result = await server.tools["migrate_guest"]({
        node: "pve",
        vmid: 200,
        target_node: "node2",
      });

      // Verify clone was called
      expect(mockPvesh).toHaveBeenCalledWith(
        "create",
        "/nodes/pve/lxc/200/clone",
        { target: "node2", vmid: 300, name: "myct" },
        600000
      );
      // Verify original was stopped and deleted
      expect(mockPvesh).toHaveBeenCalledWith(
        "create", "/nodes/pve/lxc/200/status/stop", {}, 120000
      );
      expect(mockPvesh).toHaveBeenCalledWith(
        "delete", "/nodes/pve/lxc/200", {}, 120000
      );
      // Result should report the new VMID
      expect(result.content[0].text).toContain("200");
      expect(result.content[0].text).toContain("300");
      expect(result.content[0].text).toContain("clone");
    });

    it("should refuse if guest is already on target node", async () => {
      mockPvesh
        .mockResolvedValueOnce({ status: "running" }); // resolveGuest: finds it on node2

      await expect(
        server.tools["migrate_guest"]({
          node: "node2",
          vmid: 100,
          target_node: "node2",
        })
      ).rejects.toThrow("already on node");
    });

    it("should refuse if guest is tagged dont-move", async () => {
      mockPvesh
        .mockResolvedValueOnce({ status: "running" })  // resolveGuest: qemu
        .mockResolvedValueOnce({ tags: "web;dont-move" }); // config with dont-move

      await expect(
        server.tools["migrate_guest"]({
          node: "pve",
          vmid: 105,
          target_node: "node2",
        })
      ).rejects.toThrow('tagged "dont-move"');
    });

    it("should refuse migration if config read returns null (fail-closed)", async () => {
      mockPvesh
        .mockResolvedValueOnce({ status: "running" })  // resolveGuest: qemu
        .mockResolvedValueOnce(null);                  // getGuestTags: config returns null

      await expect(
        server.tools["migrate_guest"]({
          node: "pve",
          vmid: 106,
          target_node: "node2",
        })
      ).rejects.toThrow("Cannot verify tags");
    });

    it("should pass bandwidth parameter for QEMU", async () => {
      mockPvesh
        .mockResolvedValueOnce({ status: "running" })  // resolveGuest
        .mockResolvedValueOnce({ tags: "" })           // config
        .mockResolvedValueOnce(null);                  // no task
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["migrate_guest"]({
        node: "pve",
        vmid: 100,
        target_node: "node2",
        bandwidth: 200,
      });

      expect(mockPvesh).toHaveBeenCalledWith(
        "create",
        "/nodes/pve/qemu/100/migrate",
        { target: "node2", bwlimit: 200, online: 1 },
        600000
      );
    });

    it("should pass target_storage when specified", async () => {
      mockPvesh
        .mockResolvedValueOnce({ status: "running" })  // resolveGuest
        .mockResolvedValueOnce({ tags: "" })           // config
        .mockResolvedValueOnce(null);                  // no task
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["migrate_guest"]({
        node: "pve",
        vmid: 100,
        target_node: "node2",
        target_storage: "ceph-pool",
      });

      expect(mockPvesh).toHaveBeenCalledWith(
        "create",
        "/nodes/pve/qemu/100/migrate",
        { target: "node2", bwlimit: 150, online: 1, target_storage: "ceph-pool" },
        600000
      );
    });

    it("should propagate task failure", async () => {
      mockPvesh
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValueOnce({ tags: "" })
        .mockResolvedValueOnce("UPID:pve:123:456:migrate");
      mockWaitForTask.mockRejectedValue(new Error("migration failed: disk full"));

      await expect(
        server.tools["migrate_guest"]({
          node: "pve",
          vmid: 100,
          target_node: "node2",
        })
      ).rejects.toThrow("migration failed: disk full");
    });
  });

  // ─── drain_node ─────────────────────────────────────────────────────────────

  describe("drain_node", () => {
    it("should refuse if source and target are the same", async () => {
      await expect(
        server.tools["drain_node"]({
          source_node: "pve",
          target_node: "pve",
        })
      ).rejects.toThrow("Source and target are the same node");
    });

    it("should report no guests if node is empty", async () => {
      mockPvesh
        .mockResolvedValueOnce([]) // qemu list
        .mockResolvedValueOnce([]); // lxc list

      const result = await server.tools["drain_node"]({
        source_node: "pve",
        target_node: "node2",
      });

      expect(result.content[0].text).toContain("has no guests to drain");
    });

    it("should report failed migration when config read returns null (fail-closed)", async () => {
      mockPvesh
        .mockResolvedValueOnce([
          { vmid: 100, name: "web", status: "running" },
        ])
        .mockResolvedValueOnce([]) // no lxc
        .mockResolvedValueOnce(null); // config read for vmid 100 returns null

      const result = await server.tools["drain_node"]({
        source_node: "pve",
        target_node: "node2",
      });

      const text = result.content[0].text;
      expect(text).toContain("Failed: 1");
      expect(text).toContain("Cannot verify tags");
    });

    it("should migrate all guests and report summary", async () => {
      // qemu list, lxc list
      mockPvesh
        .mockResolvedValueOnce([
          { vmid: 100, name: "web", status: "running" },
          { vmid: 101, name: "db", status: "stopped" },
        ])
        .mockResolvedValueOnce([
          { vmid: 200, name: "monitoring", status: "running" },
        ])
        // config for vmid 100 (no dont-move)
        .mockResolvedValueOnce({ tags: "" })
        // config for vmid 101 (no dont-move)
        .mockResolvedValueOnce({ tags: "production" })
        // config for vmid 200 (no dont-move)
        .mockResolvedValueOnce({ tags: "" })
        // migrate 100
        .mockResolvedValueOnce("UPID:pve:1:migrate")
        // migrate 101
        .mockResolvedValueOnce("UPID:pve:2:migrate")
        // migrate 200
        .mockResolvedValueOnce("UPID:pve:3:move");
      mockWaitForTask.mockResolvedValue(undefined);

      const result = await server.tools["drain_node"]({
        source_node: "pve",
        target_node: "node2",
      });

      const text = result.content[0].text;
      expect(text).toContain("Migrated: 3");
      expect(text).toContain("Skipped (dont-move): 0");
      expect(text).toContain("Failed: 0");
      expect(text).toContain("web");
      expect(text).toContain("db");
      expect(text).toContain("monitoring");
    });

    it("should skip dont-move tagged guests", async () => {
      mockPvesh
        .mockResolvedValueOnce([
          { vmid: 100, name: "web", status: "running" },
          { vmid: 105, name: "storage-gw", status: "running" },
        ])
        .mockResolvedValueOnce([]) // no LXC
        // config for 100
        .mockResolvedValueOnce({ tags: "" })
        // config for 105
        .mockResolvedValueOnce({ tags: "infra,dont-move" })
        // migrate 100
        .mockResolvedValueOnce(null);
      mockWaitForTask.mockResolvedValue(undefined);

      const result = await server.tools["drain_node"]({
        source_node: "pve",
        target_node: "node2",
      });

      const text = result.content[0].text;
      expect(text).toContain("Migrated: 1");
      expect(text).toContain("Skipped (dont-move): 1");
      expect(text).toContain("storage-gw");
    });

    it("should continue after a migration failure", async () => {
      mockPvesh
        .mockResolvedValueOnce([
          { vmid: 100, name: "vm-a", status: "running" },
          { vmid: 101, name: "vm-b", status: "running" },
        ])
        .mockResolvedValueOnce([]) // no LXC
        // config 100
        .mockResolvedValueOnce({ tags: "" })
        // config 101
        .mockResolvedValueOnce({ tags: "" })
        // migrate 100 → succeeds
        .mockResolvedValueOnce(null)
        // migrate 101 → fails
        .mockRejectedValueOnce(new Error("network timeout"));
      mockWaitForTask.mockResolvedValueOnce(undefined);

      const result = await server.tools["drain_node"]({
        source_node: "pve",
        target_node: "node2",
      });

      const text = result.content[0].text;
      expect(text).toContain("Migrated: 1");
      expect(text).toContain("Failed: 1");
      expect(text).toContain("vm-a");
      expect(text).toContain("vm-b");
      expect(text).toContain("network timeout");
    });

    it("dry_run should report plan without migrating", async () => {
      mockPvesh
        .mockResolvedValueOnce([
          { vmid: 100, name: "web", status: "running" },
        ])
        .mockResolvedValueOnce([
          { vmid: 200, name: "ct", status: "running" },
        ])
        // config 100
        .mockResolvedValueOnce({ tags: "" })
        // config 200
        .mockResolvedValueOnce({ tags: "dont-move" });

      const result = await server.tools["drain_node"]({
        source_node: "pve",
        target_node: "node2",
        dry_run: true,
      });

      const text = result.content[0].text;
      expect(text).toContain("DRY RUN");
      expect(text).toContain("No migrations performed");
      expect(text).toContain("Would migrate (1)");
      expect(text).toContain("web");
      expect(text).toContain("Skipped — tagged \"dont-move\" (1)");
      expect(text).toContain("ct");

      // Verify no migrate API was called
      const createCalls = mockPvesh.mock.calls.filter((c) => c[0] === "create");
      expect(createCalls).toHaveLength(0);
    });

    it("dry_run with no guests should report empty", async () => {
      mockPvesh
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await server.tools["drain_node"]({
        source_node: "pve",
        target_node: "node2",
        dry_run: true,
      });

      expect(result.content[0].text).toContain("has no guests to drain");
    });
  });
});