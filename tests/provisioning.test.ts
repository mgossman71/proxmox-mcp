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

import { pvesh, getGuestInfo, waitForTask, getNextVmid, generateMac, ProxmoxError } from "../src/proxmox.js";
import { registerProvisioningTools } from "../src/tools/provisioning.js";

const mockPvesh = vi.mocked(pvesh);
const mockGetGuestInfo = vi.mocked(getGuestInfo);
const mockWaitForTask = vi.mocked(waitForTask);
const mockGetNextVmid = vi.mocked(getNextVmid);
const mockGenerateMac = vi.mocked(generateMac);

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
  mockGenerateMac.mockReturnValue("BC:24:11:AA:BB:CC");
});

describe("provisioning tools", () => {
  let server: any;
  beforeEach(() => {
    server = createMockServer();
    registerProvisioningTools(server);
  });

  it("should register all 4 provisioning tools", () => {
    expect(Object.keys(server.tools).sort()).toEqual([
      "clone_guest",
      "create_container",
      "create_vm",
      "set_guest_config",
    ]);
  });

  // --- create_vm ---
  describe("create_vm", () => {
    it("should create a VM with auto-assigned ID", async () => {
      mockGetNextVmid.mockResolvedValue(105);
      mockPvesh.mockResolvedValue("UPID:pve:create:105:123:");
      mockWaitForTask.mockResolvedValue(undefined);

      const result = await server.tools["create_vm"]({
        name: "test-vm",
        node: "pve",
        cpus: 4,
        sockets: 2,
        memory: 8192,
        disk: 64,
        storage: "local-lvm",
        iso: "local:iso/ubuntu.iso",
        ostype: "l26",
        bridge: "vmbr0",
        agent: true,
        onboot: true,
      });

      expect(mockGetNextVmid).toHaveBeenCalled();
      const pveshCall = mockPvesh.mock.calls[0];
      expect(pveshCall[0]).toBe("create");
      expect(pveshCall[1]).toBe("/nodes/pve/qemu");
      expect(pveshCall[2]).toMatchObject({
        vmid: 105,
        name: "test-vm",
        sockets: 2,
        cores: 2, // cpus/sockets = 4/2
        memory: 8192,
        scsi0: "local-lvm:64",
        ide2: "local:iso/ubuntu.iso,media=cdrom",
      });
      expect(mockWaitForTask).toHaveBeenCalledWith("pve", "UPID:pve:create:105:123:");
      expect(result.content[0].text).toContain("VM 'test-vm' (VMID 105)");
    });

    it("should use explicit VMID if provided", async () => {
      mockPvesh.mockResolvedValue(null);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["create_vm"]({
        name: "fixed-id",
        node: "pve",
        vmid: 200,
        cpus: 1,
        sockets: 1,
        memory: 1024,
        disk: 16,
        storage: "local-lvm",
        iso: "local:iso/win.iso",
        ostype: "wwin11",
        bridge: "vmbr1",
        agent: false,
        onboot: false,
      });

      expect(mockGetNextVmid).not.toHaveBeenCalled();
      const params = mockPvesh.mock.calls[0][2];
      expect(params.vmid).toBe(200);
      expect(params.agent).toBe(false);
      expect(params.onboot).toBe(false);
    });

    it("should use explicit cores if provided", async () => {
      mockGetNextVmid.mockResolvedValue(110);
      mockPvesh.mockResolvedValue(null);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["create_vm"]({
        name: "test",
        node: "pve",
        cpus: 8,
        sockets: 2,
        cores: 4,
        memory: 4096,
        disk: 32,
        storage: "local-lvm",
        iso: "local:iso/x.iso",
        ostype: "l26",
        bridge: "vmbr0",
        agent: true,
        onboot: true,
      });

      const params = mockPvesh.mock.calls[0][2];
      expect(params.cores).toBe(4);
    });

    it("should propagate task errors", async () => {
      mockGetNextVmid.mockResolvedValue(111);
      mockPvesh.mockResolvedValue("UPID:pve:create:111:1:");
      mockWaitForTask.mockRejectedValue(new Error("no space on storage"));

      await expect(
        server.tools["create_vm"]({
          name: "fail",
          node: "pve",
          cpus: 2,
          sockets: 1,
          memory: 2048,
          disk: 32,
          storage: "local-lvm",
          iso: "local:iso/x.iso",
          ostype: "l26",
          bridge: "vmbr0",
          agent: true,
          onboot: true,
        })
      ).rejects.toThrow("no space on storage");
    });
  });

  // --- create_container ---
  describe("create_container", () => {
    it("should create a container with auto-assigned ID", async () => {
      mockGetNextVmid.mockResolvedValue(106);
      mockPvesh.mockResolvedValue("UPID:pve:ct:106:1:");
      mockWaitForTask.mockResolvedValue(undefined);

      const result = await server.tools["create_container"]({
        name: "my-ct",
        node: "pve",
        template: "local:vztmpl/ubuntu-24.04.tar.zst",
        cpus: 2,
        memory: 1024,
        swap: 512,
        disk: 8,
        storage: "local-lvm",
        bridge: "vmbr0",
        unprivileged: true,
        onboot: true,
      });

      expect(mockGetNextVmid).toHaveBeenCalled();
      const pveshCall = mockPvesh.mock.calls[0];
      expect(pveshCall[1]).toBe("/nodes/pve/lxc");
      expect(pveshCall[2]).toMatchObject({
        vmid: 106,
        ostemplate: "local:vztmpl/ubuntu-24.04.tar.zst",
        hostname: "my-ct",
        cores: 2,
        memory: 1024,
        swap: 512,
        rootfs: "local-lvm:8",
        unprivileged: true,
        onboot: true,
      });
      expect(mockWaitForTask).toHaveBeenCalledWith("pve", "UPID:pve:ct:106:1:");
      expect(result.content[0].text).toContain("Container 'my-ct' (VMID 106)");
    });

    it("should include description if provided", async () => {
      mockGetNextVmid.mockResolvedValue(107);
      mockPvesh.mockResolvedValue(null);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["create_container"]({
        name: "desc-ct",
        node: "pve",
        template: "local:vztmpl/ubuntu.tar.zst",
        cpus: 1,
        memory: 512,
        swap: 256,
        disk: 4,
        storage: "local-lvm",
        bridge: "vmbr0",
        unprivileged: true,
        onboot: true,
        description: "My description",
      });

      expect(mockPvesh.mock.calls[0][2].description).toBe("My description");
    });

    it("should not include description if not provided", async () => {
      mockGetNextVmid.mockResolvedValue(108);
      mockPvesh.mockResolvedValue(null);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["create_container"]({
        name: "no-desc",
        node: "pve",
        template: "local:vztmpl/ubuntu.tar.zst",
        cpus: 1,
        memory: 512,
        swap: 256,
        disk: 4,
        storage: "local-lvm",
        bridge: "vmbr0",
        unprivileged: true,
        onboot: true,
      });

      expect(mockPvesh.mock.calls[0][2].description).toBeUndefined();
    });

    it("should propagate task errors", async () => {
      mockGetNextVmid.mockResolvedValue(109);
      mockPvesh.mockResolvedValue("UPID:pve:ct:109:1:");
      mockWaitForTask.mockRejectedValue(new Error("template not found"));

      await expect(
        server.tools["create_container"]({
          name: "fail-ct",
          node: "pve",
          template: "local:vztmpl/bad.tar.zst",
          cpus: 1,
          memory: 512,
          swap: 256,
          disk: 4,
          storage: "local-lvm",
          bridge: "vmbr0",
          unprivileged: true,
          onboot: true,
        })
      ).rejects.toThrow("template not found");
    });

    it("should handle unprivileged: false", async () => {
      mockGetNextVmid.mockResolvedValue(120);
      mockPvesh.mockResolvedValue(null);
      mockWaitForTask.mockResolvedValue(undefined);

      const result = await server.tools["create_container"]({
        name: "priv-ct",
        node: "pve",
        template: "local:vztmpl/ubuntu.tar.zst",
        cpus: 1,
        memory: 512,
        swap: 256,
        disk: 4,
        storage: "local-lvm",
        bridge: "vmbr0",
        unprivileged: false,
        onboot: true,
      });

      expect(mockPvesh.mock.calls[0][2].unprivileged).toBe(false);
      expect(result.content[0].text).toContain("Unprivileged: no");
    });
  });

  // --- clone_guest ---
  describe("clone_guest", () => {
    it("should clone a QEMU VM (full clone)", async () => {
      mockGetNextVmid.mockResolvedValue(115);
      mockGetGuestInfo.mockResolvedValue({ node: "pve", type: "qemu", name: "OrigVM" });
      mockPvesh.mockResolvedValue("UPID:pve:clone:115:1:");
      mockWaitForTask.mockResolvedValue(undefined);

      const result = await server.tools["clone_guest"]({
        node: "pve", vmid: 100, new_name: "CloneVM", full: true,
      });

      expect(mockPvesh).toHaveBeenCalledWith(
        "create", "/nodes/pve/qemu/100/clone",
        { name: "CloneVM", target: "pve", vmid: 115 },
        300000
      );
      expect(mockWaitForTask).toHaveBeenCalledWith("pve", "UPID:pve:clone:115:1:");
      expect(result.content[0].text).toContain("CloneVM");
    });

    it("should clone LXC container", async () => {
      mockGetNextVmid.mockResolvedValue(116);
      mockGetGuestInfo.mockResolvedValue({ node: "pve", type: "lxc", name: "OrigCT" });
      mockPvesh.mockResolvedValue(null);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["clone_guest"]({
        node: "pve", vmid: 101, new_name: "CloneCT", full: true,
      });

      expect(mockPvesh).toHaveBeenCalledWith(
        "create", "/nodes/pve/lxc/101/clone",
        { name: "CloneCT", target: "pve", vmid: 116 },
        300000
      );
    });

    it("should do linked clone (snapshot) for QEMU", async () => {
      mockGetNextVmid.mockResolvedValue(117);
      mockGetGuestInfo.mockResolvedValue({ node: "pve", type: "qemu", name: "OrigVM" });
      mockPvesh.mockResolvedValue(null);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["clone_guest"]({
        node: "pve", vmid: 100, new_name: "Linked", full: false,
      });

      const params = mockPvesh.mock.calls[0][2];
      expect(params.snapshot).toBe("current");
    });

    it("should do linked clone (snapshot) for LXC", async () => {
      mockGetNextVmid.mockResolvedValue(121);
      mockGetGuestInfo.mockResolvedValue({ node: "pve", type: "lxc", name: "OrigCT" });
      mockPvesh.mockResolvedValue(null);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["clone_guest"]({
        node: "pve", vmid: 101, new_name: "LinkedCT", full: false,
      });

      expect(mockPvesh).toHaveBeenCalledWith(
        "create", "/nodes/pve/lxc/101/clone",
        { target: "pve", name: "LinkedCT", vmid: 121, snapshot: "current" },
        300000
      );
    });

    it("should use explicit new_vmid", async () => {
      mockGetGuestInfo.mockResolvedValue({ node: "pve", type: "qemu", name: "OrigVM" });
      mockPvesh.mockResolvedValue(null);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["clone_guest"]({
        node: "pve", vmid: 100, new_name: "Fixed", new_vmid: 300,
      });

      expect(mockGetNextVmid).not.toHaveBeenCalled();
      expect(mockPvesh.mock.calls[0][2].vmid).toBe(300);
    });

    it("should use target_node if specified", async () => {
      mockGetNextVmid.mockResolvedValue(118);
      mockGetGuestInfo.mockResolvedValue({ node: "pve", type: "qemu", name: "OrigVM" });
      mockPvesh.mockResolvedValueOnce({ tags: "" }).mockResolvedValue(null);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["clone_guest"]({
        node: "pve", vmid: 100, new_name: "Migrated", target_node: "node2",
      });

      expect(mockPvesh.mock.calls[1][2].target).toBe("node2");
      expect(mockWaitForTask).toHaveBeenCalledWith("node2", null);
    });

    it("should propagate task errors", async () => {
      mockGetNextVmid.mockResolvedValue(119);
      mockGetGuestInfo.mockResolvedValue({ node: "pve", type: "qemu", name: "OrigVM" });
      mockPvesh.mockResolvedValue("UPID:pve:clone:119:1:");
      mockWaitForTask.mockRejectedValue(new Error("not enough disk space"));

      await expect(
        server.tools["clone_guest"]({ node: "pve", vmid: 100, new_name: "Fail" })
      ).rejects.toThrow("not enough disk space");
    });
  });

  // --- set_guest_config ---
  describe("set_guest_config", () => {
    it("should change CPU and memory for QEMU", async () => {
      mockGetGuestInfo.mockResolvedValue({ node: "pve", type: "qemu", name: "VM" });
      mockPvesh.mockResolvedValue(null);
      mockWaitForTask.mockResolvedValue(undefined);

      const result = await server.tools["set_guest_config"]({
        node: "pve", vmid: 100, cpus: 8, memory: 16384,
      });

      expect(mockPvesh).toHaveBeenCalledWith(
        "set", "/nodes/pve/qemu/100/config",
        { cores: 8, memory: 16384 },
        120000
      );
      expect(result.content[0].text).toContain("cores: 8");
      expect(result.content[0].text).toContain("memory: 16384");
    });

    it("should change swap only for LXC", async () => {
      mockGetGuestInfo.mockResolvedValue({ node: "pve", type: "lxc", name: "CT" });
      mockPvesh.mockResolvedValue(null);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["set_guest_config"]({
        node: "pve", vmid: 101, swap: 1024,
      });

      expect(mockPvesh).toHaveBeenCalledWith(
        "set", "/nodes/pve/lxc/101/config",
        { swap: 1024 },
        120000
      );
    });

    it("should ignore swap for QEMU", async () => {
      mockGetGuestInfo.mockResolvedValue({ node: "pve", type: "qemu", name: "VM" });
      mockPvesh.mockResolvedValue(null);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["set_guest_config"]({
        node: "pve", vmid: 100, cpus: 4, swap: 1024,
      });

      const params = mockPvesh.mock.calls[0][2];
      expect(params.swap).toBeUndefined();
      expect(params.cores).toBe(4);
    });

    it("should rename LXC using hostname param", async () => {
      mockGetGuestInfo.mockResolvedValue({ node: "pve", type: "lxc", name: "OldName" });
      mockPvesh.mockResolvedValue(null);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["set_guest_config"]({
        node: "pve", vmid: 101, name: "NewName",
      });

      expect(mockPvesh.mock.calls[0][2]).toMatchObject({ hostname: "NewName" });
    });

    it("should rename QEMU using name param", async () => {
      mockGetGuestInfo.mockResolvedValue({ node: "pve", type: "qemu", name: "OldName" });
      mockPvesh.mockResolvedValue(null);
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["set_guest_config"]({
        node: "pve", vmid: 100, name: "NewName",
      });

      expect(mockPvesh.mock.calls[0][2]).toMatchObject({ name: "NewName" });
    });

    it("should throw when no changes specified", async () => {
      mockGetGuestInfo.mockResolvedValue({ node: "pve", type: "qemu", name: "VM" });

      await expect(
        server.tools["set_guest_config"]({ node: "pve", vmid: 100 })
      ).rejects.toThrow("No configuration changes specified");
    });

    it("should propagate task errors", async () => {
      mockGetGuestInfo.mockResolvedValue({ node: "pve", type: "qemu", name: "VM" });
      mockPvesh.mockResolvedValue("UPID:pve:set:1:2:");
      mockWaitForTask.mockRejectedValue(new Error("config rejected"));

      await expect(
        server.tools["set_guest_config"]({ node: "pve", vmid: 100, cpus: 4 })
      ).rejects.toThrow("config rejected");
    });

    it("should combine multiple changes", async () => {
      mockGetGuestInfo.mockResolvedValue({ node: "pve", type: "lxc", name: "CT" });
      mockPvesh.mockResolvedValue(null);
      mockWaitForTask.mockResolvedValue(undefined);

      const result = await server.tools["set_guest_config"]({
        node: "pve", vmid: 101, cpus: 4, memory: 4096, swap: 1024, name: "Renamed", onboot: false,
      });

      expect(mockPvesh.mock.calls[0][2]).toMatchObject({
        cores: 4,
        memory: 4096,
        swap: 1024,
        hostname: "Renamed",
        onboot: false,
      });
    });
  });
});