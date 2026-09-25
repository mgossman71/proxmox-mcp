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

  // Mirrors the real resolveGuest, including the run state it derives from the
  // status call -- migration mode depends on it, so the mock must not drift.
  const isRunning = (s: any) => (s as any)?.status === "running";
  async function resolveGuest(node: string, vmid: number) {
    try {
      const s = await pvesh("get", `/nodes/${node}/qemu/${vmid}/status/current`);
      return { node, type: "qemu" as const, running: isRunning(s) };
    } catch { /* not qemu */ }
    try {
      const s = await pvesh("get", `/nodes/${node}/lxc/${vmid}/status/current`);
      return { node, type: "lxc" as const, running: isRunning(s) };
    } catch { /* not lxc */ }
    const info = await getGuestInfo(vmid);
    return { node: info.node, type: info.type, running: info.running };
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
    registerTool(name: string, meta: any, handler: any) {
      // Apply the tool's own inputSchema the way the MCP SDK does, so every
      // `.default()` is exercised and tests see the values production sees.
      const schema = meta?.inputSchema ? z.object(meta.inputSchema) : null;
      tools[name] = async (args: any = {}) =>
        handler(schema ? schema.parse(args) : args);
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
        { target: "node2", bwlimit: 153600, online: 1 },
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
        .mockRejectedValueOnce(new Error(                      // move endpoint: not available
          "No 'create' handler defined for '/nodes/pve/lxc/200/migrate'"
        ))
        .mockResolvedValueOnce({ hostname: "myct", tags: "" }) // config read for clone fallback
        .mockResolvedValueOnce({ status: "running" })          // original status: running
        .mockResolvedValueOnce("UPID:pve:1:stop")              // stop original
        .mockResolvedValueOnce("UPID:pve:2:clone")             // clone task
        .mockResolvedValueOnce("UPID:node2:3:start");          // start clone
      mockGetNextVmid.mockResolvedValue(300);
      mockWaitForTask.mockResolvedValue(undefined);

      const result = await server.tools["migrate_guest"]({
        node: "pve",
        vmid: 200,
        target_node: "node2",
      });

      // The original is stopped BEFORE the clone, so the copy is consistent and
      // the two containers never run at once with the same hostname/IP/MAC.
      const order = mockPvesh.mock.calls.map((c) => c[0] + " " + c[1]);
      expect(order.indexOf("create /nodes/pve/lxc/200/status/stop")).toBeLessThan(
        order.indexOf("create /nodes/pve/lxc/200/clone")
      );

      // Clone uses PVE's LXC spellings (newid/hostname) and is polled on the
      // SOURCE node, which owns the task UPID.
      expect(mockPvesh).toHaveBeenCalledWith(
        "create",
        "/nodes/pve/lxc/200/clone",
        { target: "node2", newid: 300, hostname: "myct", full: 1 },
        600000
      );
      expect(mockWaitForTask).toHaveBeenCalledWith("pve", "UPID:pve:2:clone", 600000);

      // The clone is started on the target
      expect(mockPvesh).toHaveBeenCalledWith(
        "create", "/nodes/node2/lxc/300/status/start", {}, 120000
      );

      // The original is NOT deleted - this server does not destroy guests
      const deletes = mockPvesh.mock.calls.filter((c) => c[0] === "delete");
      expect(deletes).toHaveLength(0);

      // Result reports the new VMID and the retained original
      expect(result.content[0].text).toContain("200");
      expect(result.content[0].text).toContain("300");
      expect(result.content[0].text).toContain("clone");
      expect(result.content[0].text).toContain("left in place");
    });

    it("clone fallback should not stop an already-stopped original", async () => {
      mockPvesh
        .mockRejectedValueOnce(new Error("nf"))
        .mockResolvedValueOnce({ status: "stopped" })          // resolveGuest: lxc
        .mockResolvedValueOnce({ tags: "" })
        .mockRejectedValueOnce(new Error(
          "501 Method 'POST /nodes/pve/lxc/200/migrate' not implemented"
        ))
        .mockResolvedValueOnce({ hostname: "myct" })           // config
        .mockResolvedValueOnce({ status: "stopped" })          // already stopped
        .mockResolvedValueOnce("UPID:pve:1:clone")
        .mockResolvedValueOnce("UPID:node2:2:start");
      mockGetNextVmid.mockResolvedValue(301);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["migrate_guest"]({
        node: "pve",
        vmid: 200,
        target_node: "node2",
      });

      const stops = mockPvesh.mock.calls.filter(
        (c) => c[1] === "/nodes/pve/lxc/200/status/stop"
      );
      expect(stops).toHaveLength(0);
    });

    it("should rethrow a genuine LXC migrate failure instead of cloning", async () => {
      mockPvesh
        .mockRejectedValueOnce(new Error("nf"))
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValueOnce({ tags: "" })
        .mockRejectedValueOnce(new Error("storage 'ceph' is not available on node2"));

      await expect(
        server.tools["migrate_guest"]({
          node: "pve",
          vmid: 200,
          target_node: "node2",
        })
      ).rejects.toThrow("storage 'ceph' is not available");

      const clones = mockPvesh.mock.calls.filter((c) => String(c[1]).endsWith("/clone"));
      expect(clones).toHaveLength(0);
    });

    it("should reject a non-positive bandwidth", async () => {
      await expect(
        server.tools["migrate_guest"]({
          node: "pve",
          vmid: 100,
          target_node: "node2",
          bandwidth: 0,
        })
      ).rejects.toThrow();
    });

    it("should send online=0 when online is explicitly false for QEMU", async () => {
      mockPvesh
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValueOnce({ tags: "" })
        .mockResolvedValueOnce(null);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["migrate_guest"]({
        node: "pve",
        vmid: 100,
        target_node: "node2",
        online: false,
      });

      expect(mockPvesh).toHaveBeenCalledWith(
        "create",
        "/nodes/pve/qemu/100/migrate",
        { target: "node2", bwlimit: 153600, online: 0 },
        600000
      );
    });

    it("should send online=1 for LXC only when explicitly requested", async () => {
      mockPvesh
        .mockRejectedValueOnce(new Error("nf"))
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValueOnce({ tags: "" })
        .mockResolvedValueOnce(null);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["migrate_guest"]({
        node: "pve",
        vmid: 200,
        target_node: "node2",
        online: true,
      });

      expect(mockPvesh).toHaveBeenCalledWith(
        "create",
        "/nodes/pve/lxc/200/migrate",
        { target: "node2", bwlimit: 153600, online: 1 },
        600000
      );
    });

    // A stopped guest is migrated offline. The tool used to advertise that a
    // guest "must currently be running", which led callers to start a stopped
    // guest first -- unnecessary downtime for no reason.
    it("should migrate a stopped QEMU VM offline, without starting it", async () => {
      mockPvesh
        .mockResolvedValueOnce({ status: "stopped" }) // resolveGuest: qemu, stopped
        .mockResolvedValueOnce({ tags: "" })
        .mockResolvedValueOnce("UPID:pve:1:migrate");
      mockWaitForTask.mockResolvedValue(undefined);

      const result = await server.tools["migrate_guest"]({
        node: "pve",
        vmid: 100,
        target_node: "node2",
      });

      expect(mockPvesh).toHaveBeenCalledWith(
        "create",
        "/nodes/pve/qemu/100/migrate",
        { target: "node2", bwlimit: 153600, online: 0 },
        600000
      );
      // Nothing is started on the caller's behalf.
      const starts = mockPvesh.mock.calls.filter((c) =>
        String(c[1]).endsWith("/status/start")
      );
      expect(starts).toHaveLength(0);
      expect(result.content[0].text).toContain("Migrated qemu VMID 100");
    });

    it("should ignore online=true for a stopped QEMU VM", async () => {
      mockPvesh
        .mockResolvedValueOnce({ status: "stopped" })
        .mockResolvedValueOnce({ tags: "" })
        .mockResolvedValueOnce("UPID:pve:1:migrate");
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["migrate_guest"]({
        node: "pve",
        vmid: 100,
        target_node: "node2",
        online: true,
      });

      // PVE rejects a live migration of a VM that is not running, so the
      // preference cannot be honoured literally.
      expect(mockPvesh).toHaveBeenCalledWith(
        "create",
        "/nodes/pve/qemu/100/migrate",
        { target: "node2", bwlimit: 153600, online: 0 },
        600000
      );
    });

    it("should send neither restart nor online for a stopped LXC container", async () => {
      mockPvesh
        .mockRejectedValueOnce(new Error("nf"))        // resolveGuest: qemu fails
        .mockResolvedValueOnce({ status: "stopped" })  // resolveGuest: lxc, stopped
        .mockResolvedValueOnce({ tags: "" })
        .mockResolvedValueOnce("UPID:pve:1:move");
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["migrate_guest"]({
        node: "pve",
        vmid: 132,
        target_node: "node2",
      });

      // Both flags describe what to do with a running container.
      expect(mockPvesh).toHaveBeenCalledWith(
        "create",
        "/nodes/pve/lxc/132/migrate",
        { target: "node2", bwlimit: 153600 },
        600000
      );
    });

    it("should use PVE's hyphenated target-storage on the LXC endpoint", async () => {
      mockPvesh
        .mockRejectedValueOnce(new Error("nf"))
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValueOnce({ tags: "" })
        .mockResolvedValueOnce(null);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["migrate_guest"]({
        node: "pve",
        vmid: 200,
        target_node: "node2",
        target_storage: "ceph-pool",
      });

      expect(mockPvesh).toHaveBeenCalledWith(
        "create",
        "/nodes/pve/lxc/200/migrate",
        { target: "node2", bwlimit: 153600, restart: 1, "target-storage": "ceph-pool" },
        600000
      );
    });

    it("should rethrow a non-object throw from the LXC migrate endpoint", async () => {
      mockPvesh
        .mockRejectedValueOnce(new Error("nf"))
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValueOnce({ tags: "" })
        .mockRejectedValueOnce(null); // a bare null throw is not "endpoint missing"

      await expect(
        server.tools["migrate_guest"]({
          node: "pve",
          vmid: 200,
          target_node: "node2",
        })
      ).rejects.toBeNull();
    });

    it("clone fallback should pass target storage as `storage`", async () => {
      mockPvesh
        .mockRejectedValueOnce(new Error("nf"))
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValueOnce({ tags: "" })
        .mockRejectedValueOnce(new Error("unknown command"))
        .mockResolvedValueOnce({ hostname: "myct" })
        .mockResolvedValueOnce({ status: "stopped" })
        .mockResolvedValueOnce("UPID:pve:1:clone")
        .mockResolvedValueOnce("UPID:node2:2:start");
      mockGetNextVmid.mockResolvedValue(403);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["migrate_guest"]({
        node: "pve",
        vmid: 200,
        target_node: "node2",
        target_storage: "ceph-pool",
      });

      expect(mockPvesh).toHaveBeenCalledWith(
        "create",
        "/nodes/pve/lxc/200/clone",
        { target: "node2", newid: 403, hostname: "myct", full: 1, storage: "ceph-pool" },
        600000
      );
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
        { target: "node2", bwlimit: 204800, online: 1 },
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
        { target: "node2", bwlimit: 153600, online: 1, targetstorage: "ceph-pool" },
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

    // drain reads run state from the node listings, so a half-stopped node is
    // drained with the right mode per guest rather than one mode for all.
    it("should drain running and stopped guests with the right mode each", async () => {
      mockPvesh
        .mockResolvedValueOnce([
          { vmid: 100, name: "web", status: "running" },
          { vmid: 101, name: "archive", status: "stopped" },
        ])
        .mockResolvedValueOnce([]) // no lxc
        .mockResolvedValueOnce({ tags: "" })          // 100 tags
        .mockResolvedValueOnce({ tags: "" })          // 101 tags
        .mockResolvedValueOnce("UPID:pve:1:migrate")  // 100 migrate
        .mockResolvedValueOnce("UPID:pve:2:migrate"); // 101 migrate
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["drain_node"]({
        source_node: "pve",
        target_node: "node2",
      });

      expect(mockPvesh).toHaveBeenCalledWith(
        "create",
        "/nodes/pve/qemu/100/migrate",
        { target: "node2", bwlimit: 153600, online: 1 },
        600000
      );
      expect(mockPvesh).toHaveBeenCalledWith(
        "create",
        "/nodes/pve/qemu/101/migrate",
        { target: "node2", bwlimit: 153600, online: 0 },
        600000
      );
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

    it("should report a clone-fallback migration and the retained original", async () => {
      mockPvesh
        .mockResolvedValueOnce([])                             // no qemu
        .mockResolvedValueOnce([{ vmid: 200, name: "ct-a" }])  // one lxc
        .mockResolvedValueOnce({ tags: "" })                   // tag check
        .mockRejectedValueOnce(new Error(                      // migrate unavailable
          "no such resource '/nodes/pve/lxc/200/migrate'"
        ))
        .mockResolvedValueOnce({})                             // config without hostname
        .mockResolvedValueOnce(null)                           // status unreadable
        .mockResolvedValueOnce("UPID:pve:1:clone")
        .mockResolvedValueOnce("UPID:node2:2:start");
      mockGetNextVmid.mockResolvedValue(400);
      mockWaitForTask.mockResolvedValue(undefined);

      const result = await server.tools["drain_node"]({
        source_node: "pve",
        target_node: "node2",
      });

      const text = result.content[0].text;
      expect(text).toContain("Migrated: 1");
      expect(text).toContain("200 → 400");
      expect(text).toContain("[clone]");
      expect(text).toContain("Stopped originals left in place");
      // A config with no hostname falls back to a derived name
      expect(mockPvesh).toHaveBeenCalledWith(
        "create",
        "/nodes/pve/lxc/200/clone",
        { target: "node2", newid: 400, hostname: "ct-200", full: 1 },
        600000
      );
      // Status was unreadable, so no stop was attempted
      const stops = mockPvesh.mock.calls.filter(
        (c) => c[1] === "/nodes/pve/lxc/200/status/stop"
      );
      expect(stops).toHaveLength(0);
    });

    it("should fall back to clone when only stderr reveals the missing endpoint", async () => {
      const err: any = new Error("pvesh command failed");
      err.stderr = "501 Method 'POST /nodes/pve/lxc/200/migrate' not implemented";
      mockPvesh
        .mockRejectedValueOnce(new Error("nf"))
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValueOnce({ tags: "" })
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce({ hostname: "myct" })
        .mockResolvedValueOnce({ status: "stopped" })
        .mockResolvedValueOnce("UPID:pve:1:clone")
        .mockResolvedValueOnce("UPID:node2:2:start");
      mockGetNextVmid.mockResolvedValue(402);
      mockWaitForTask.mockResolvedValue(undefined);

      const result = await server.tools["migrate_guest"]({
        node: "pve",
        vmid: 200,
        target_node: "node2",
      });

      expect(result.content[0].text).toContain("402");
    });

    it("should render non-Error throw shapes in the failure report", async () => {
      mockPvesh
        .mockResolvedValueOnce([
          { vmid: 100, name: "a" },
          { vmid: 101, name: "b" },
          { vmid: 102, name: "c" },
          { vmid: 103, name: "d" },
        ])
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce("plain string failure")       // string throw
        .mockRejectedValueOnce({ message: "object message" }) // object with message
        .mockRejectedValueOnce({ stderr: "object stderr" })   // object with stderr only
        .mockRejectedValueOnce({ code: 7 });                  // neither -> JSON

      const result = await server.tools["drain_node"]({
        source_node: "pve",
        target_node: "node2",
      });

      const text = result.content[0].text;
      expect(text).toContain("Failed: 4");
      expect(text).toContain("plain string failure");
      expect(text).toContain("object message");
      expect(text).toContain("object stderr");
      expect(text).toContain('{"code":7}');
    });

    it("should treat a config with no tags field as untagged", async () => {
      mockPvesh
        .mockResolvedValueOnce([{ vmid: 100, name: "web" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce({ cores: 2 }) // config has no `tags` key at all
        .mockResolvedValueOnce(null);
      mockWaitForTask.mockResolvedValue(undefined);

      const result = await server.tools["drain_node"]({
        source_node: "pve",
        target_node: "node2",
      });

      expect(result.content[0].text).toContain("Migrated: 1");
    });

    it("should ignore non-array guest listings", async () => {
      mockPvesh
        .mockResolvedValueOnce(null) // qemu listing is not an array
        .mockResolvedValueOnce("x"); // lxc listing is not an array

      const result = await server.tools["drain_node"]({
        source_node: "pve",
        target_node: "node2",
      });

      expect(result.content[0].text).toContain("has no guests to drain");
    });

    it("should skip listing entries with an unusable vmid and derive missing names", async () => {
      mockPvesh
        .mockResolvedValueOnce([
          { vmid: "bad" }, // not a number
          { vmid: 0 },     // not > 0
          { vmid: 100 },   // valid, but unnamed
        ])
        .mockResolvedValueOnce([
          { vmid: null },  // not a number
          { vmid: -1 },    // not > 0
          { vmid: 200 },   // valid, but unnamed
        ])
        .mockResolvedValueOnce({ tags: "" })
        .mockResolvedValueOnce({ tags: "" });

      const result = await server.tools["drain_node"]({
        source_node: "pve",
        target_node: "node2",
        dry_run: true,
      });

      const text = result.content[0].text;
      expect(text).toContain("Would migrate (2)");
      expect(text).toContain("vm-100");
      expect(text).toContain("ct-200");
      expect(text).not.toContain("bad");
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

    it("dry_run should report guests whose tag check failed", async () => {
      mockPvesh
        .mockResolvedValueOnce([
          { vmid: 100, name: "web", status: "running" },
          { vmid: 101, name: "mystery", status: "running" },
        ])
        .mockResolvedValueOnce([]) // no LXC
        .mockResolvedValueOnce({ tags: "" }) // config 100 -> migratable
        .mockResolvedValueOnce(null);        // config 101 -> fail-closed

      const result = await server.tools["drain_node"]({
        source_node: "pve",
        target_node: "node2",
        dry_run: true,
      });

      const text = result.content[0].text;
      expect(text).toContain("Would migrate (1)");
      // A guest that could not be checked must not silently vanish from the
      // preview, or the operator concludes the node would be fully evacuated.
      expect(text).toContain("Cannot determine");
      expect(text).toContain("mystery");
      expect(text).toContain("would not be fully evacuated");
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