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
import { registerLifecycleTools } from "../src/tools/lifecycle.js";

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

describe("lifecycle tools", () => {
  let server: any;
  beforeEach(() => {
    server = createMockServer();
    registerLifecycleTools(server);
  });

  it("should register all 6 lifecycle tools", () => {
    expect(Object.keys(server.tools).sort()).toEqual([
      "reboot_guest",
      "resume_guest",
      "shutdown_guest",
      "start_guest",
      "stop_guest",
      "suspend_guest",
    ]);
  });

  describe("resolveGuestPath (via start_guest)", () => {
    it("should find QEMU VM on specified node", async () => {
      mockPvesh.mockResolvedValueOnce({ status: "stopped" }); // resolveGuest qemu check
      mockPvesh.mockResolvedValueOnce(null); // create action (no task)
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["start_guest"]({ node: "pve", vmid: 100 });
      expect(mockPvesh).toHaveBeenCalledWith("get", "/nodes/pve/qemu/100/status/current");
      expect(mockPvesh).toHaveBeenCalledWith("create", "/nodes/pve/qemu/100/status/start", {}, 120000);
      expect(mockWaitForTask).toHaveBeenCalledWith("pve", null);
    });

    it("should find LXC when QEMU fails", async () => {
      mockPvesh
        .mockRejectedValueOnce(new Error("not found")) // qemu check
        .mockResolvedValueOnce({ status: "stopped" }) // lxc check in resolveGuest
        .mockResolvedValueOnce(null); // create action
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["start_guest"]({ node: "pve", vmid: 101 });
      expect(mockPvesh).toHaveBeenCalledWith("get", "/nodes/pve/lxc/101/status/current");
      expect(mockPvesh).toHaveBeenCalledWith("create", "/nodes/pve/lxc/101/status/start", {}, 120000);
    });

    it("should fall back to cluster search", async () => {
      mockPvesh
        .mockRejectedValueOnce(new Error("nf")) // qemu on pve
        .mockRejectedValueOnce(new Error("nf")) // lxc on pve
        .mockResolvedValueOnce([ // cluster resources
          { vmid: 200, type: "qemu", name: "Remote", node: "node2" },
        ])
        .mockResolvedValueOnce(null); // create action
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["start_guest"]({ node: "pve", vmid: 200 });
      expect(mockPvesh).toHaveBeenCalledWith("get", "/cluster/resources");
      expect(mockPvesh).toHaveBeenCalledWith("create", "/nodes/node2/qemu/200/status/start", {}, 120000);
    });

    it("should fall back to cluster search finding LXC", async () => {
      mockPvesh
        .mockRejectedValueOnce(new Error("nf")) // qemu on pve
        .mockRejectedValueOnce(new Error("nf")) // lxc on pve
        .mockResolvedValueOnce([ // cluster resources
          { vmid: 201, type: "lxc", name: "RemoteCT", node: "node3" },
        ])
        .mockResolvedValueOnce(null); // create action
      mockWaitForTask.mockResolvedValue(undefined);

      await server.tools["start_guest"]({ node: "pve", vmid: 201 });
      expect(mockPvesh).toHaveBeenCalledWith("create", "/nodes/node3/lxc/201/status/start", {}, 120000);
    });

    it("should throw when guest not found in cluster", async () => {
      mockPvesh
        .mockRejectedValueOnce(new Error("nf"))
        .mockRejectedValueOnce(new Error("nf"))
        .mockResolvedValueOnce([
          { vmid: 100, type: "qemu", name: "Other", node: "pve" },
        ]);

      await expect(server.tools["start_guest"]({ node: "pve", vmid: 999 })).rejects.toThrow(
        "VMID 999 not found in cluster"
      );
    });
  });

  describe("each action", () => {
    const actions: [string, string][] = [
      ["start_guest", "start"],
      ["stop_guest", "stop"],
      ["shutdown_guest", "shutdown"],
      ["reboot_guest", "restart"],
      ["suspend_guest", "suspend"],
      ["resume_guest", "resume"],
    ];

    for (const [toolName, action] of actions) {
      it(`${toolName} should call ${action} and wait for task`, async () => {
        mockPvesh
          .mockResolvedValueOnce({ status: "running" }) // resolve guest path
          .mockResolvedValueOnce("UPID:pve:123:456:789:" + action);
        mockWaitForTask.mockResolvedValue(undefined);

        const result = await server.tools[toolName]({ node: "pve", vmid: 100 });
        expect(mockPvesh).toHaveBeenCalledWith("create", `/nodes/pve/qemu/100/status/${action}`, {}, 120000);
        expect(mockWaitForTask).toHaveBeenCalledWith("pve", "UPID:pve:123:456:789:" + action);
        expect(result.content[0].text).toContain("VMID 100");
      });

      it(`${toolName} should propagate task errors`, async () => {
        mockPvesh
          .mockResolvedValueOnce({ status: "running" })
          .mockResolvedValueOnce("UPID:pve:123:456:789:" + action);
        mockWaitForTask.mockRejectedValue(new Error("task failed: disk full"));

        await expect(server.tools[toolName]({ node: "pve", vmid: 100 })).rejects.toThrow("task failed");
      });
    }
  });

  describe("return message", () => {
    it("should include a helpful hint", async () => {
      mockPvesh
        .mockResolvedValueOnce({ status: "stopped" })
        .mockResolvedValueOnce(null);
      mockWaitForTask.mockResolvedValue(undefined);

      const result = await server.tools["start_guest"]({ node: "pve", vmid: 100 });
      expect(result.content[0].text).toContain("Use get_guest_status to verify");
    });
  });
});