# Code Review: Proxmox MCP Server

## Overview

A Model Context Protocol (MCP) server that manages Proxmox VE clusters via SSH + `pvesh`. TypeScript, Express, 23 tools across 4 categories (Inspection, Lifecycle, Snapshots, Provisioning). 123 tests, all passing. TypeScript compiles cleanly.

---

## 🔴 Critical Issues

### 1. Remote Command Injection via Unvalidated Path Parameters

**File:** `src/proxmox.ts` (line 81) + all tool files

The `pvesh` function interpolates the `path` parameter directly into a shell command string that is executed on the remote host:

```ts
let cmd = `pvesh ${method} ${path}`;
```

The `node` and `storage` parameters (from user input) are interpolated into `path` without any validation:

```ts
// inspection.ts:47
const data = await pvesh("get", `/nodes/${node}/qemu`);
// inspection.ts:159
const data = await pvesh("get", `/nodes/${node}/storage/${storage}/content`);
```

**Attack:** An MCP client sending `node = "pve; reboot"` would cause the remote shell to execute `reboot` on the Proxmox host. Since the MCP endpoint has **no authentication** (issue #2), this is trivially exploitable by anyone with network access to the port.

**Fix:** Validate `node` and `storage` against a strict pattern:

```ts
const nodeParam = z.string().default("pve").regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const storageParam = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
```

Or shell-quote the path segments in `pvesh()`.

---

### 2. No Authentication on MCP Endpoint

**File:** `src/index.ts` (line 29)

The `/mcp` endpoint accepts any request without authentication. Combined with the command injection above, this means anyone with network access to port 3040 (the Docker Compose mapping) can:

- Create/destroy VMs
- Execute arbitrary commands on the Proxmox host
- Read all storage contents

Even without injection, an unauthenticated endpoint controlling infrastructure is dangerous. Consider adding a shared secret header (e.g., `Authorization: Bearer <token>`) validated in middleware.

---

## 🟠 High-Priority Bugs

### 3. `waitForTask` Called with Wrong Node

**Files:** `src/tools/lifecycle.ts` (line 58), `src/tools/snapshots.ts` (line 66)

When `resolveGuestPath`/`resolveGuestBase` finds the guest on a *different* node than the one specified, the task is created on the correct node, but `waitForTask` polls the *original* (wrong) node:

```ts
// lifecycle.ts:56-58
const basePath = await resolveGuestPath(node, vmid);  // may resolve to /nodes/node2/qemu/200
const result = await pvesh("create", `${basePath}/status/${action}`, {}, 120000);
await waitForTask(node, result);  // BUG: uses original `node`, not the resolved node
```

**Fix:** Parse the node from the resolved base path, or have `resolveGuestPath` return `{ node, path }`.

---

### 4. `StrictHostKeyChecking=no` Disables MITM Protection

**File:** `src/proxmox.ts` (line 37)

```ts
"-o", "StrictHostKeyChecking=no",
```

This silently accepts any host key, making the SSH connection vulnerable to man-in-the-middle attacks. For an infrastructure management tool, this is a significant risk. Consider requiring a known_hosts file or using `accept-new` (accepts first connection, then verifies subsequently).

---

## 🟡 Medium-Priority Issues

### 5. Duplicated Guest Resolution Logic (3+ copies)

The "try QEMU → try LXC → cluster search" pattern is duplicated in:

- `src/tools/lifecycle.ts` → `resolveGuestPath()`
- `src/tools/snapshots.ts` → `resolveGuestBase()`
- `src/tools/inspection.ts` → inline in `get_guest_status` and `get_guest_config`

These are nearly identical (differing only in the return value). Should be a single shared utility in `src/proxmox.ts`.

---

### 6. Duplicate Zod Schema Definitions

`nodeParam` and `vmidParam` are independently defined in `lifecycle.ts`, `snapshots.ts`, and `provisioning.ts` with identical values. Should be defined once in a shared module (e.g., `src/schemas.ts`).

---

### 7. Dead Code in `get_guest_status`

**File:** `src/tools/inspection.ts` (lines 80-81)

```ts
let guestNode = node;  // assigned but never used
let type: string;      // assigned but never read (each branch returns before it's used)
```

---

### 8. Fragile Error Classification in `waitForTask`

**File:** `src/proxmox.ts` (line 211)

```ts
if (e instanceof ProxmoxError && !e.message.startsWith("Failed to parse")) {
  throw e;
}
```

Using string prefix matching to classify errors is fragile. If the "Failed to parse" message ever changes, this breaks silently. Consider using a dedicated error subclass or an error code.

---

### 9. Test Descriptions Don't Match Reality

- `tests/snapshots.test.ts:45` — says "should register all **4** snapshot tools" but there are only **2**
- `tests/inspection.test.ts:46` — says "should register all **12** inspection tools" but there are **11**
- `tests/server.test.ts:26` — says "should have all **23** tools registered" but never actually verifies the count (only checks that methods exist)

---

### 10. MAC Address Test Checks Wrong Octet

**File:** `tests/proxmox.test.ts` (line 263-269)

```ts
it("should have locally administered bit set (second octet even)", () => {
  // ...
  const secondOctet = parseInt(parts[1], 16);  // parts[1] is "24" (static prefix!)
  expect(secondOctet % 2).toBe(0);
});
```

The locally administered bit is in the **first** octet (`BC`), not the second (`24`). Since `24` is always even, this test always passes regardless of the implementation. Should check `parts[0]` (the `BC` octet) or better yet, the dynamically generated bytes.

---

### 11. No SSH Connection Multiplexing

Every `pvesh()` call spawns a new SSH process. Compound operations like `list_isos` (which queries N storages) open N+1 SSH connections. SSH `ControlMaster`/`ControlPath` options would dramatically reduce connection overhead for multi-step operations.

---

## 🟢 Low-Priority / Style Issues

### 12. `pvesh` Returns `Promise<any>`

The return type loses all type safety at call sites. Consider `Promise<Record<string, any> | any[] | string | null>` or at minimum `Promise<unknown>` with narrowing at call sites.

### 13. No Overall Timeout for Compound Operations

`create_vm` calls `getNextVmid` + `pvesh` + `waitForTask` (up to 5 min). There's no overall timeout wrapping the entire tool handler. A stuck operation could block an MCP session indefinitely.

### 14. Silent Defaults for SSH Configuration

If `PROXMOX_SSH_HOST` is not set, it defaults to `10.0.0.19` with no warning. Consider logging a warning or failing fast when required env vars are missing.

### 15. Dockerfile: No Non-Root User

The container runs as root. Consider adding a `USER node` directive (after the build steps) for the runtime.

### 16. `npm install` in Dockerfile

Should use `npm ci` for reproducible builds in production.

### 17. Test Duration: 8+ Seconds

The `waitForTask` tests in `proxmox.test.ts` use real 2-second poll intervals. Using `vi.useFakeTimers()` would reduce the test suite from ~8s to <1s.

### 18. `expandHome` Exported but Only Used Internally

The function is exported from `src/proxmox.ts` but never imported elsewhere. Remove the `export` or keep it only if intended for external use.

---

## ✅ Strengths

| Area | Notes |
|------|-------|
| **Test coverage** | 123 tests, 100% threshold configured. Good coverage of error paths, edge cases, and fallback logic. |
| **Shell quoting** | The `q()` function correctly handles single-quote escaping for parameter values. |
| **Error wrapping** | `ProxmoxError` provides structured error info (exit code, stderr) beyond the base Error. |
| **Task polling** | `waitForTask` handles UPID extraction, polling, timeout, and failure log retrieval well. |
| **Tool design** | Clear separation into 4 categories. Good use of auto-detection (QEMU vs LXC) to keep the API surface simple for the LLM. |
| **Non-destructive scope** | Deliberately excludes destructive operations (delete VM, node power). Good safety boundary for an AI-operated tool. |
| **Containerized** | Docker + Compose makes deployment straightforward. |

---

## Summary of Recommended Actions (Priority Order)

| # | Action | Effort |
|---|--------|--------|
| 1 | Add input validation (regex) for `node` and `storage` params | Small |
| 2 | Add authentication to the MCP endpoint | Medium |
| 3 | Fix `waitForTask` node bug in lifecycle.ts and snapshots.ts | Small |
| 4 | Replace `StrictHostKeyChecking=no` with `accept-new` | Trivial |
| 5 | Extract shared `resolveGuest()` utility | Medium |
| 6 | Fix test descriptions (4→2, 12→11) and MAC octet test | Trivial |
| 7 | Use `vi.useFakeTimers()` in waitForTask tests | Small |
| 8 | Add non-root user + `npm ci` to Dockerfile | Trivial |
| 9 | Consider SSH multiplexing for performance | Medium |