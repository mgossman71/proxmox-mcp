import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import os from "os";

// Mock https before importing the module under test
const { mockRequest } = vi.hoisted(() => ({ mockRequest: vi.fn() }));
vi.mock("https", () => ({
  default: {
    request: (...args: any[]) => mockRequest(...args),
    Agent: class {
      constructor(public options: any) {}
    },
  },
}));

import {
  ProxmoxError,
  pvesh,
  getGuestInfo,
  getNextVmid,
  generateMac,
  waitForTask,
  expandHome,
  resolveGuest,
  asObject,
  asString,
  ProxmoxParseError,
} from "../src/proxmox.js";

process.env.PROXMOX_HOST = "pve.test";
process.env.PROXMOX_TOKEN_ID = "mcp@pve!mcp";
process.env.PROXMOX_TOKEN_SECRET = "secret-uuid";

interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  options: any;
}

type Reply = { status?: number; statusText?: string; body?: string } | Error;

let requests: CapturedRequest[] = [];

// Answer each https.request with whatever `reply` returns for it
function mockApi(reply: (req: CapturedRequest) => Reply) {
  mockRequest.mockImplementation((url: string, options: any, callback: Function) => {
    const req: any = new EventEmitter();
    let body = "";
    req.write = (chunk: string) => { body += chunk; };
    req.destroy = (err?: Error) => { if (err) req.emit("error", err); };
    req.end = () => {
      queueMicrotask(() => {
        const captured = { method: options.method, url, headers: options.headers, body, options };
        requests.push(captured);
        const r = reply(captured);
        if (r instanceof Error) {
          req.emit("error", r);
          return;
        }
        const res: any = new EventEmitter();
        res.statusCode = r.status ?? 200;
        res.statusMessage = r.statusText ?? "OK";
        callback(res);
        if (r.body) res.emit("data", Buffer.from(r.body));
        res.emit("end");
      });
    };
    return req;
  });
}

// Helper to simulate a successful API call returning `data`
function mockData(data: any) {
  mockApi(() => ({ body: JSON.stringify({ data }) }));
}

// Helper to simulate a non-2xx API response
function mockHttpError(status: number, statusText: string, body = '{"data":null}') {
  mockApi(() => ({ status, statusText, body }));
}

beforeEach(() => {
  vi.resetAllMocks();
  requests = [];
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

// --- expandHome ---

describe("expandHome", () => {
  it("should expand ~ to home directory", () => {
    expect(expandHome("~/.ssh/id_rsa")).toBe(`${os.homedir()}/.ssh/id_rsa`);
  });

  it("should return path unchanged if no tilde", () => {
    expect(expandHome("/etc/ssh/id_rsa")).toBe("/etc/ssh/id_rsa");
  });
});

// --- pvesh (HTTPS transport) ---

describe("pvesh", () => {
  it("should unwrap the data field", async () => {
    const data = [{ node: "pve", status: "online" }];
    mockData(data);
    const result = await pvesh("get", "/cluster/status");
    expect(result).toEqual(data);
  });

  it("should return null when data is null", async () => {
    mockData(null);
    expect(await pvesh("get", "/nodes/pve/qemu/999/config")).toBeNull();
  });

  it("should return null for an empty body", async () => {
    mockApi(() => ({ body: "" }));
    expect(await pvesh("get", "/cluster/status")).toBeNull();
  });

  it("should return a UPID string from task endpoints", async () => {
    mockData("UPID:pve:001:310DCDBB:6AB30176:vzcreate:105:mcp@pve!mcp:");
    const result = await pvesh("create", "/nodes/pve/lxc", {});
    expect(result).toBe("UPID:pve:001:310DCDBB:6AB30176:vzcreate:105:mcp@pve!mcp:");
  });

  it.each([
    ["get", "GET"],
    ["create", "POST"],
    ["set", "PUT"],
    ["delete", "DELETE"],
  ] as const)("should map %s to %s", async (method, verb) => {
    mockData(null);
    await pvesh(method, "/test");
    expect(requests[0].method).toBe(verb);
  });

  it("should call the configured API base URL", async () => {
    mockData(null);
    await pvesh("get", "/cluster/status");
    expect(requests[0].url).toBe("https://pve.test:8006/api2/json/cluster/status");
  });

  it("should send the API token in the Authorization header", async () => {
    mockData(null);
    await pvesh("get", "/cluster/status");
    expect(requests[0].headers.Authorization).toBe("PVEAPIToken=mcp@pve!mcp=secret-uuid");
  });

  it("should send GET params as a query string", async () => {
    mockData(null);
    await pvesh("get", "/nodes/pve/storage", { content: "iso", enabled: true });
    expect(requests[0].url).toBe("https://pve.test:8006/api2/json/nodes/pve/storage?content=iso&enabled=1");
    expect(requests[0].body).toBe("");
  });

  it("should send POST params as a form body", async () => {
    mockData(null);
    await pvesh("create", "/nodes/pve/qemu", { name: "test-vm", cores: 4 });
    expect(requests[0].url).toBe("https://pve.test:8006/api2/json/nodes/pve/qemu");
    expect(requests[0].headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(requests[0].body).toBe("name=test-vm&cores=4");
  });

  it("should pass booleans as 1 and 0", async () => {
    mockData(null);
    await pvesh("set", "/nodes/pve/qemu/100/config", { onboot: false, agent: true });
    expect(requests[0].body).toBe("onboot=0&agent=1");
  });

  it("should form-encode special characters in values", async () => {
    mockData(null);
    await pvesh("create", "/nodes/pve/qemu", { net0: "virtio=BC:24:11:AA:BB:CC,bridge=vmbr0", name: "it's a test" });
    const form = new URLSearchParams(requests[0].body);
    expect(form.get("net0")).toBe("virtio=BC:24:11:AA:BB:CC,bridge=vmbr0");
    expect(form.get("name")).toBe("it's a test");
  });

  it("should pass the timeout to the request", async () => {
    mockData(null);
    await pvesh("create", "/test", {}, 1234);
    expect(requests[0].options.timeout).toBe(1234);
  });

  it("should throw ProxmoxError with status and reason on HTTP errors", async () => {
    mockHttpError(403, "Permission check failed (/vms/100, VM.Audit)");
    const err = await pvesh("get", "/nodes/pve/qemu/100/config").catch((e) => e);
    expect(err).toBeInstanceOf(ProxmoxError);
    expect(err.message).toBe("HTTP 403: Permission check failed (/vms/100, VM.Audit)");
    expect(err.exitCode).toBe(403);
  });

  it("should include parameter errors in the message", async () => {
    mockHttpError(400, "Parameter verification failed.", JSON.stringify({ data: null, errors: { vmid: "invalid format" } }));
    await expect(pvesh("create", "/nodes/pve/qemu", { vmid: "x" })).rejects.toThrow(
      'HTTP 400: Parameter verification failed. {"vmid":"invalid format"}'
    );
  });

  it("should keep 501 in the message so missing endpoints are detectable", async () => {
    mockHttpError(501, "Method 'POST /nodes/pve/lxc/100/migrate' not implemented");
    await expect(pvesh("create", "/nodes/pve/lxc/100/migrate")).rejects.toThrow(/501.*not implemented/);
  });

  it("should throw ProxmoxError on network failure", async () => {
    mockApi(() => new Error("connect ECONNREFUSED 10.0.0.19:8006"));
    const err = await pvesh("get", "/cluster/status").catch((e) => e);
    expect(err).toBeInstanceOf(ProxmoxError);
    expect(err.message).toContain("ECONNREFUSED");
  });

  it("should throw ProxmoxParseError for a non-JSON body", async () => {
    mockApi(() => ({ body: "<html>proxy error</html>" }));
    const err = await pvesh("get", "/test").catch((e) => e);
    expect(err).toBeInstanceOf(ProxmoxParseError);
    expect(err.message).toContain("Failed to parse Proxmox API response");
  });
});

// --- getGuestInfo ---

describe("getGuestInfo", () => {
  it("should find a QEMU VM in the cluster", async () => {
    const resources = [
      { vmid: 100, type: "qemu", name: "MyVM", node: "pve", status: "running" },
      { vmid: 101, type: "lxc", name: "MyCT", node: "pve", status: "running" },
    ];
    mockData(resources);
    const result = await getGuestInfo(100);
    expect(result).toEqual({
      node: "pve", type: "qemu", name: "MyVM", running: true,
    });
  });

  it("should find an LXC container in the cluster", async () => {
    const resources = [
      { vmid: 100, type: "qemu", name: "MyVM", node: "pve", status: "running" },
      { vmid: 101, type: "lxc", name: "MyCT", node: "pve2", status: "stopped" },
    ];
    mockData(resources);
    const result = await getGuestInfo(101);
    expect(result).toEqual({
      node: "pve2", type: "lxc", name: "MyCT", running: false,
    });
  });

  it("should throw when VMID not found", async () => {
    const resources = [{ vmid: 100, type: "qemu", name: "MyVM", node: "pve" }];
    mockData(resources);
    await expect(getGuestInfo(999)).rejects.toThrow("VMID 999 not found in cluster");
  });

  it("should throw when cluster resources returns non-array", async () => {
    mockData({ error: "bad" });
    await expect(getGuestInfo(100)).rejects.toThrow(
      "Unexpected (non-array) response from /cluster/resources"
    );
  });
});

// --- getNextVmid ---

describe("getNextVmid", () => {
  it("should return 100 when no VMs exist", async () => {
    mockData([]);
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
    mockData(resources);
    const result = await getNextVmid();
    expect(result).toBe(104);
  });

  it("should throw when cluster resources returns non-array", async () => {
    mockData({ error: "bad" });
    await expect(getNextVmid()).rejects.toThrow(
      "Unexpected (non-array) response from /cluster/resources"
    );
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

  it("should have locally administered bit set in first dynamic octet", () => {
    for (let i = 0; i < 50; i++) {
      const mac = generateMac();
      const parts = mac.split(":");
      // parts[3] is the first dynamically generated octet (prefix is BC:24:11:XX:XX:XX)
      const firstDynamicOctet = parseInt(parts[3], 16);
      // Locally administered bit is bit 1 (0x02)
      expect(firstDynamicOctet & 0x02).toBe(0x02);
      // Unicast bit is bit 0 (0x01) — should be 0
      expect(firstDynamicOctet & 0x01).toBe(0);
    }
  });
});

// --- waitForTask ---

describe("waitForTask", () => {
  const UPID = "UPID:pve:123:456:789:task:mcp@pve!mcp:";

  it("should return immediately for null upid", async () => {
    await expect(waitForTask("pve", null)).resolves.toBeUndefined();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("should return immediately for undefined upid", async () => {
    await expect(waitForTask("pve", undefined)).resolves.toBeUndefined();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("should return immediately for non-UPID string", async () => {
    await expect(waitForTask("pve", "not-a-upid")).resolves.toBeUndefined();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("should return immediately for non-string upid", async () => {
    await expect(waitForTask("pve", 123 as any)).resolves.toBeUndefined();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("should resolve when task completes with OK status", async () => {
    mockData({ status: "stopped", exitstatus: "OK" });
    await expect(waitForTask("pve", UPID)).resolves.toBeUndefined();
  });

  it("should poll until task completes", async () => {
    let callCount = 0;
    mockApi(() => {
      callCount++;
      const status = callCount < 3
        ? { status: "running", exitstatus: "OK" }
        : { status: "stopped", exitstatus: "OK" };
      return { body: JSON.stringify({ data: status }) };
    });
    await expect(waitForTask("pve", UPID)).resolves.toBeUndefined();
    expect(callCount).toBe(3);
  });

  it("should URL-encode the UPID in the task path", async () => {
    mockData({ status: "stopped", exitstatus: "OK" });
    await waitForTask("pve", "UPID:pve:123:456:789:task:mcp@pve!mcp:");
    expect(requests[0].url).toBe(
      "https://pve.test:8006/api2/json/nodes/pve/tasks/UPID%3Apve%3A123%3A456%3A789%3Atask%3Amcp%40pve!mcp%3A/status"
    );
  });

  // Fail the task, and answer the log request with `log`
  function mockFailedTask(log: Reply) {
    mockApi((req) => {
      if (req.url.endsWith("/status")) {
        return { body: JSON.stringify({ data: { status: "stopped", exitstatus: "ERROR" } }) };
      }
      return log;
    });
  }

  it("should throw with the log tail when task fails", async () => {
    mockFailedTask({
      body: JSON.stringify({
        data: [
          { n: 1, t: "line1" },
          { n: 2, t: "line2" },
          { n: 3, t: "ERROR: disk full" },
        ],
      }),
    });
    await expect(waitForTask("pve", UPID)).rejects.toThrow(
      `Task ${UPID} failed: line1\nline2\nERROR: disk full`
    );
  });

  it("should throw when task fails and log fetch also fails", async () => {
    mockFailedTask({ status: 500, statusText: "no log" });
    await expect(waitForTask("pve", UPID)).rejects.toThrow(
      `Task ${UPID} failed: exitstatus=ERROR`
    );
  });

  it("should handle log returning empty array", async () => {
    mockFailedTask({ body: JSON.stringify({ data: [] }) });
    await expect(waitForTask("pve", UPID)).rejects.toThrow("failed: exitstatus=ERROR");
  });

  it("should handle log returning non-array value", async () => {
    mockFailedTask({ body: JSON.stringify({ data: "single line error" }) });
    await expect(waitForTask("pve", UPID)).rejects.toThrow("failed: single line error");
  });

  it("should handle log returning null", async () => {
    mockFailedTask({ body: JSON.stringify({ data: null }) });
    await expect(waitForTask("pve", UPID)).rejects.toThrow("failed: exitstatus=ERROR");
  });

  it("should throw on timeout", async () => {
    mockData({ status: "running", exitstatus: "OK" });
    // Use a very short timeout to trigger timeout path
    await expect(waitForTask("pve", UPID, 1)).rejects.toThrow("Timed out waiting for task");
  });

  it("should keep polling on transient parse errors", async () => {
    let callCount = 0;
    mockApi(() => {
      callCount++;
      // First call returns unparseable data (simulating race)
      if (callCount === 1) return { body: "garbage not json" };
      return { body: JSON.stringify({ data: { status: "stopped", exitstatus: "OK" } }) };
    });
    await expect(waitForTask("pve", UPID)).resolves.toBeUndefined();
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});

// --- resolveGuest ---

describe("resolveGuest", () => {
  const notFound = { status: 500, statusText: "Configuration file does not exist" };

  it("should find QEMU VM on the specified node", async () => {
    mockData({ status: "running" });
    const result = await resolveGuest("pve", 100);
    expect(result).toEqual({ node: "pve", type: "qemu", running: true });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it("should fall back to LXC when QEMU is not found", async () => {
    mockApi((req) =>
      req.url.includes("/qemu/") ? notFound : { body: JSON.stringify({ data: { status: "running" } }) }
    );
    const result = await resolveGuest("pve", 101);
    expect(result).toEqual({ node: "pve", type: "lxc", running: true });
    expect(requests).toHaveLength(2);
  });

  it("should fall back to cluster search when not on specified node", async () => {
    mockApi((req) => {
      if (!req.url.endsWith("/cluster/resources")) return notFound;
      return {
        body: JSON.stringify({
          data: [{ vmid: 200, type: "qemu", name: "RemoteVM", node: "node2", status: "running" }],
        }),
      };
    });
    const result = await resolveGuest("pve", 200);
    expect(result).toEqual({ node: "node2", type: "qemu", running: true });
  });
});

// --- asObject ---

describe("asObject", () => {
  it("should return a plain object", () => {
    const obj = { status: "running" };
    expect(asObject(obj)).toBe(obj);
  });

  it("should return null for an array", () => {
    expect(asObject([1, 2, 3])).toBeNull();
  });

  it("should return null for a string", () => {
    expect(asObject("hello")).toBeNull();
  });

  it("should return null for null", () => {
    expect(asObject(null)).toBeNull();
  });
});

// --- asString ---

describe("asString", () => {
  it("should return a string", () => {
    expect(asString("UPID:pve:1:2:3:")).toBe("UPID:pve:1:2:3:");
  });

  it("should return null for an object", () => {
    expect(asString({ key: "value" })).toBeNull();
  });

  it("should return null for an array", () => {
    expect(asString([1, 2])).toBeNull();
  });

  it("should return null for null", () => {
    expect(asString(null)).toBeNull();
  });
});