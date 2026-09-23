import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";

// Mock child_process before importing the module under test
const mockExecFile = vi.fn();
vi.mock("child_process", () => ({
  execFile: (...args: any[]) => mockExecFile(...args),
}));

import {
  ProxmoxError,
  pvesh,
  getGuestInfo,
  getNextVmid,
  generateMac,
  waitForTask,
  expandHome,
} from "../src/proxmox.js";

// Helper to simulate execFile success
function mockSshSuccess(stdout: string) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: any, callback: Function) => {
      callback(null, { stdout, stderr: "" });
    }
  );
}

// Helper to simulate execFile failure
function mockSshFailure(code: number, stderr: string) {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: any, callback: Function) => {
      const err: any = new Error(`ssh: exit code ${code}`);
      err.code = code;
      err.stderr = stderr;
      callback(err, { stdout: "", stderr });
    }
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

// --- ProxmoxError ---

describe("ProxmoxError", () => {
  it("should create an error with message, exitCode, and stderr", () => {
    const err = new ProxmoxError("something failed", 3, "bad thing");
    expect(err.message).toBe("something failed");
    expect(err.exitCode).toBe(3);
    expect(err.stderr).toBe("bad thing");
    expect(err.name).toBe("ProxmoxError");
    expect(err instanceof Error).toBe(true);
  });

  it("should default exitCode to 1 and stderr to empty", () => {
    const err = new ProxmoxError("fail");
    expect(err.exitCode).toBe(1);
    expect(err.stderr).toBe("");
  });
});

// --- expandHome (tested indirectly through SSH_KEY setup) ---
// --- expandHome ---

describe("expandHome", () => {
  it("should expand ~ to home directory", () => {
    expect(expandHome("~/.ssh/id_rsa")).toBe(`${os.homedir()}/.ssh/id_rsa`);
  });

  it("should return path unchanged if no tilde", () => {
    expect(expandHome("/etc/ssh/id_rsa")).toBe("/etc/ssh/id_rsa");
  });
});

// --- ssh (private, tested through pvesh) ---

describe("pvesh", () => {
  it("should parse JSON response", async () => {
    const data = [{ node: "pve", status: "online" }];
    mockSshSuccess(JSON.stringify(data));
    const result = await pvesh("get", "/cluster/status");
    expect(result).toEqual(data);
  });

  it("should return null for empty output", async () => {
    mockSshSuccess("");
    const result = await pvesh("get", "/nodes/pve/qemu/999/config");
    expect(result).toBeNull();
  });

  it("should extract UPID from multi-line output", async () => {
    const output = "Logical volume \"vm-105-disk-0\" created.\nCreating filesystem...\nUPID:pve:001:310DCDBB:6AB30176:vzcreate:105:root@pam:";
    mockSshSuccess(output);
    const result = await pvesh("create", "/nodes/pve/lxc", {});
    expect(result).toBe("UPID:pve:001:310DCDBB:6AB30176:vzcreate:105:root@pam:");
  });

  it("should find JSON in multi-line output", async () => {
    const output = "Some progress text\n{\"result\":true}\nmore text";
    mockSshSuccess(output);
    const result = await pvesh("get", "/test");
    expect(result).toEqual({ result: true });
  });

  it("should throw ProxmoxError for unparseable output", async () => {
    mockSshSuccess("some random non-JSON text without UPID");
    await expect(pvesh("get", "/test")).rejects.toThrow(ProxmoxError);
    await expect(pvesh("get", "/test")).rejects.toThrow("Failed to parse pvesh response");
  });

  it("should throw ProxmoxError on SSH failure", async () => {
    mockSshFailure(255, "Connection refused");
    await expect(pvesh("get", "/cluster/status")).rejects.toThrow(ProxmoxError);
    await expect(pvesh("get", "/cluster/status")).rejects.toThrow("Connection refused");
  });

  it("should use error.message when stderr is empty", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: any, callback: Function) => {
        const err: any = new Error("Operation timed out");
        err.code = 124;
        err.stderr = "";
        callback(err, { stdout: "", stderr: "" });
      }
    );
    await expect(pvesh("get", "/cluster/status")).rejects.toThrow("Operation timed out");
  });

  it("should use fallback message when both stderr and message are empty", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: any, callback: Function) => {
        const err: any = new Error("");
        err.code = 1;
        err.stderr = "";
        callback(err, { stdout: "", stderr: "" });
      }
    );
    await expect(pvesh("get", "/cluster/status")).rejects.toThrow("Unknown SSH error");
  });

  it("should default exit code to 1 when code is undefined", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: any, callback: Function) => {
        const err: any = new Error("failed");
        delete err.code;
        err.stderr = "some error";
        callback(err, { stdout: "", stderr: "some error" });
      }
    );
    try {
      await pvesh("get", "/cluster/status");
    } catch (e: any) {
      expect(e.exitCode).toBe(1);
      expect(e.message).toContain("exit ?");
    }
  });

  it("should pass boolean params as --key 1", async () => {
    mockSshSuccess("null");
    const result = await pvesh("create", "/nodes/pve/qemu", { onboot: true, agent: false });
    expect(result).toBeNull();
    const call = mockExecFile.mock.calls[0];
    const remoteCmd = call[1][call[1].length - 1];
    expect(remoteCmd).toContain("--onboot 1");
    expect(remoteCmd).not.toContain("--agent");
  });

  it("should pass string/number params with quoting", async () => {
    mockSshSuccess("null");
    await pvesh("create", "/nodes/pve/qemu", { name: "test-vm", cores: 4 });
    const call = mockExecFile.mock.calls[0];
    const remoteCmd = call[1][call[1].length - 1];
    expect(remoteCmd).toContain("--name 'test-vm'");
    expect(remoteCmd).toContain("--cores '4'");
  });

  it("should shell-quote single quotes in values", async () => {
    mockSshSuccess("null");
    await pvesh("set", "/nodes/pve/qemu/100/config", { name: "it's a test" });
    const call = mockExecFile.mock.calls[0];
    const remoteCmd = call[1][call[1].length - 1];
    expect(remoteCmd).toContain(`--name 'it'\\''s a test'`);
  });

  it("should include --output-format json in command", async () => {
    mockSshSuccess("null");
    await pvesh("get", "/cluster/status");
    const call = mockExecFile.mock.calls[0];
    const remoteCmd = call[1][call[1].length - 1];
    expect(remoteCmd).toContain("--output-format json");
  });
});

// --- getGuestInfo ---

describe("getGuestInfo", () => {
  it("should find a QEMU VM in the cluster", async () => {
    const resources = [
      { vmid: 100, type: "qemu", name: "MyVM", node: "pve" },
      { vmid: 101, type: "lxc", name: "MyCT", node: "pve" },
    ];
    mockSshSuccess(JSON.stringify(resources));
    const result = await getGuestInfo(100);
    expect(result).toEqual({ node: "pve", type: "qemu", name: "MyVM" });
  });

  it("should find an LXC container in the cluster", async () => {
    const resources = [
      { vmid: 100, type: "qemu", name: "MyVM", node: "pve" },
      { vmid: 101, type: "lxc", name: "MyCT", node: "pve2" },
    ];
    mockSshSuccess(JSON.stringify(resources));
    const result = await getGuestInfo(101);
    expect(result).toEqual({ node: "pve2", type: "lxc", name: "MyCT" });
  });

  it("should throw when VMID not found", async () => {
    const resources = [{ vmid: 100, type: "qemu", name: "MyVM", node: "pve" }];
    mockSshSuccess(JSON.stringify(resources));
    await expect(getGuestInfo(999)).rejects.toThrow("VMID 999 not found in cluster");
  });
});

// --- getNextVmid ---

describe("getNextVmid", () => {
  it("should return 100 when no VMs exist", async () => {
    mockSshSuccess(JSON.stringify([]));
    const result = await getNextVmid();
    expect(result).toBe(100);
  });

  it("should return max+1 when VMs exist", async () => {
    const resources = [
      { vmid: 100 },
      { vmid: 103 },
      { vmid: 101 },
      // non-VM entries (nodes, storage)
      { type: "node" },
      { type: "storage" },
    ];
    mockSshSuccess(JSON.stringify(resources));
    const result = await getNextVmid();
    expect(result).toBe(104);
  });
});

// --- generateMac ---

describe("generateMac", () => {
  it("should generate a MAC with BC:24:11 prefix", () => {
    const mac = generateMac();
    expect(mac).toMatch(/^BC:24:11:[0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}$/);
  });

  it("should generate unique MACs", () => {
    const macs = new Set(Array.from({ length: 100 }, () => generateMac()));
    expect(macs.size).toBeGreaterThan(90); // allow tiny collision probability
  });

  it("should have locally administered bit set (second octet even)", () => {
    for (let i = 0; i < 50; i++) {
      const mac = generateMac();
      const parts = mac.split(":");
      const secondOctet = parseInt(parts[1], 16);
      expect(secondOctet % 2).toBe(0);
    }
  });
});

// --- waitForTask ---

describe("waitForTask", () => {
  it("should return immediately for null upid", async () => {
    await expect(waitForTask("pve", null)).resolves.toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("should return immediately for undefined upid", async () => {
    await expect(waitForTask("pve", undefined)).resolves.toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("should return immediately for non-UPID string", async () => {
    await expect(waitForTask("pve", "not-a-upid")).resolves.toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("should return immediately for non-string upid", async () => {
    await expect(waitForTask("pve", 123 as any)).resolves.toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("should resolve when task completes with OK status", async () => {
    mockSshSuccess(JSON.stringify({ status: "stopped", exitstatus: "OK" }));
    await expect(waitForTask("pve", "UPID:pve:123:456:789:task:root@pam:")).resolves.toBeUndefined();
  });

  it("should poll until task completes", async () => {
    let callCount = 0;
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: any, callback: Function) => {
        callCount++;
        const status = callCount < 3
          ? { status: "running", exitstatus: "OK" }
          : { status: "stopped", exitstatus: "OK" };
        callback(null, { stdout: JSON.stringify(status), stderr: "" });
      }
    );
    await expect(waitForTask("pve", "UPID:pve:123:456:789:task:root@pam:")).resolves.toBeUndefined();
    expect(callCount).toBe(3);
  });

  it("should throw when task fails and log is available", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: any, callback: Function) => {
        const remoteCmd = args[args.length - 1];
        if (remoteCmd.includes("/status")) {
          callback(null, { stdout: JSON.stringify({ status: "stopped", exitstatus: "ERROR" }), stderr: "" });
        } else if (remoteCmd.includes("/log")) {
          callback(null, { stdout: JSON.stringify(["line1", "line2", "ERROR: disk full"]), stderr: "" });
        } else {
          callback(null, { stdout: "", stderr: "" });
        }
      }
    );
    await expect(waitForTask("pve", "UPID:pve:123:456:789:task:root@pam:")).rejects.toThrow(
      "Task UPID:pve:123:456:789:task:root@pam: failed"
    );
  });

  it("should throw when task fails and log fetch also fails", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: any, callback: Function) => {
        const remoteCmd = args[args.length - 1];
        if (remoteCmd.includes("/status")) {
          callback(null, { stdout: JSON.stringify({ status: "stopped", exitstatus: "ERROR" }), stderr: "" });
        } else {
          const err: any = new Error("log fetch failed");
          err.code = 1;
          err.stderr = "no log";
          callback(err, { stdout: "", stderr: "no log" });
        }
      }
    );
    await expect(waitForTask("pve", "UPID:pve:123:456:789:task:root@pam:")).rejects.toThrow(
      "Task UPID:pve:123:456:789:task:root@pam: failed: exitstatus=ERROR"
    );
  });

  it("should handle log returning empty array", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: any, callback: Function) => {
        const remoteCmd = args[args.length - 1];
        if (remoteCmd.includes("/status")) {
          callback(null, { stdout: JSON.stringify({ status: "stopped", exitstatus: "ERROR" }), stderr: "" });
        } else if (remoteCmd.includes("/log")) {
          callback(null, { stdout: "[]", stderr: "" });
        } else {
          callback(null, { stdout: "", stderr: "" });
        }
      }
    );
    await expect(waitForTask("pve", "UPID:pve:123:456:789:task:root@pam:")).rejects.toThrow(
      "failed: exitstatus=ERROR"
    );
  });

  it("should handle log returning non-array value", async () => {
    mockExecFile.mockImplementation(
      (_cmd: string, args: string[], _opts: any, callback: Function) => {
        const remoteCmd = args[args.length - 1];
        if (remoteCmd.includes("/status")) {
          callback(null, { stdout: JSON.stringify({ status: "stopped", exitstatus: "ERROR" }), stderr: "" });
        } else if (remoteCmd.includes("/log")) {
          callback(null, { stdout: JSON.stringify("single line error"), stderr: "" });
        } else {
          callback(null, { stdout: "", stderr: "" });
        }
      }
    );
    await expect(waitForTask("pve", "UPID:pve:123:456:789:task:root@pam:")).rejects.toThrow(
      "failed"
    );
  });

  it("should throw on timeout", async () => {
    mockSshSuccess(JSON.stringify({ status: "running", exitstatus: "OK" }));
    // Use a very short timeout to trigger timeout path
    await expect(
      waitForTask("pve", "UPID:pve:123:456:789:task:root@pam:", 1)
    ).rejects.toThrow("Timed out waiting for task");
  });

  it("should keep polling on transient parse errors", async () => {
    let callCount = 0;
    mockExecFile.mockImplementation(
      (_cmd: string, _args: string[], _opts: any, callback: Function) => {
        callCount++;
        if (callCount === 1) {
          // First call returns unparseable data (simulating race)
          callback(null, { stdout: "garbage not json", stderr: "" });
        } else {
          callback(null, { stdout: JSON.stringify({ status: "stopped", exitstatus: "OK" }), stderr: "" });
        }
      }
    );
    await expect(waitForTask("pve", "UPID:pve:123:456:789:task:root@pam:")).resolves.toBeUndefined();
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});