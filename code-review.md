# Code Review: Proxmox MCP Server

> **Two rounds in this file.** Round 1 (below) covers the 23-tool tree and was
> resolved in `407d367`. Round 2 covers the `live-migrate` migration work and is
> **resolved** — jump to [Code Review — `live-migrate` branch](#code-review--live-migrate-branch-2026-09-25)
> and [Remediation](#remediation-2026-09-25).

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
---
---

# Code Review — `live-migrate` branch (2026-09-25)

> The review above is an earlier round against the 23-tool/123-test tree; its
> issues were resolved in `407d367`. This section is a **new, independent round**
> covering only the migration work.

## Scope

`git diff main...HEAD` on branch `live-migrate` — 7 files, +902/-7. Working tree
clean, so the committed range is the full scope.

New code is `src/tools/migration.ts` (+419) plus a `dont-move` guard wired into
`clone_guest`. Commits in range:

```
aceccc6 docs: add migration tools to README, note dont-move protection
40a814f fix: use bwlimit (not bandwidth) for QEMU migrate, respect online param
a11162c fix: split tags on semicolons (PVE 9.x) not just commas
084584d fix: block cross-node clones of dont-move tagged guests
90b3efe fix: fail-closed tag verification to prevent bypassing dont-move
```

**`npx tsc --noEmit` is clean and all 166 tests pass.** None of the findings
below are caught by the suite — see finding 8 for why.

`CONFIRMED` = verified by reading the code in this tree. `PLAUSIBLE` = depends on
the real PVE API contract, which cannot be checked from here; the suggested
`pvesh usage` command is noted inline.

---

## Blocking

### 1. Clone fallback runs two copies, then deletes the original — data loss

**`src/tools/migration.ts:151`** · CONFIRMED

The LXC clone fallback sequence is clone → start clone → stop original → delete
original. The original is never stopped *before* the clone, so:

- PVE full-clone of a running LXC generally refuses, or captures a
  crash-consistent snapshot at best.
- Between the `start` at line 142 and the `stop` at line 151, **both containers
  are live** with the same hostname, IP and MAC.
- Any write the original serves during the clone+start window is destroyed by
  the `delete` at line 161, with no rollback path if a later step fails.

This also contradicts the README's scope note that the server "does **not**
expose ... destructive guest deletion operations" — this path adds one.

**Fix direction:** stop the original before cloning, and do not delete it at all
— leave the stopped original in place for the operator to remove, or gate the
delete behind an explicit opt-in parameter.

### 2. Default migration is offline, contradicting the tool's own description

**`src/tools/migration.ts:79`** · CONFIRMED

```ts
online: online === false ? 0 : 1,
```

paired with the schema at lines 194-197 (and the `drain_node` copy):

```ts
online: z.boolean().default(false)
```

Zod supplies `false` whenever the caller omits the argument, so the ternary
yields `--online 0` and every default QEMU migration is issued **offline**. The
tool description says "Live migrate a QEMU VM ... The guest must currently be
running on the source node" — and PVE refuses an offline migration of a running
VM. The documented happy path fails, and `drain_node` fails on every running
QEMU guest.

The tests assert `online: 1` because the mock server never applies zod defaults,
so `online` arrives as `undefined` — a value production cannot produce. See
finding 8.

**Fix direction:** default `online` to `true` for QEMU, or drop the ternary and
pass the boolean through honestly.

---

## High

### 3. Clone task is awaited on the wrong node, orphaning the clone

**`src/tools/migration.ts:139`** · CONFIRMED

The clone is issued to `/nodes/${node}/lxc/${vmid}/clone` (source node), so its
UPID belongs to the **source** node — but the code calls `waitForTask(target, ...)`,
which queries `/nodes/${target}/tasks/${upid}/status`. PVE rejects a UPID owned
by another node, and because the resulting `ProxmoxError` is not a
`ProxmoxParseError`, `waitForTask` rethrows immediately rather than continuing to
poll (`src/proxmox.ts:300-303`).

Net effect: the clone-based fallback always throws right after issuing the clone,
leaving a half-built duplicate container on the target and the original
untouched.

`src/tools/provisioning.ts:177` has the same pre-existing pattern.

### 4. QEMU `bwlimit` unit disagrees with the LXC branch by 1024x

**`src/tools/migration.ts:78`** · CONFIRMED

The schema documents `bandwidth` as "MB/s". The two branches convert differently
for the same user-facing parameter:

```ts
bwlimit: bandwidth ?? 150,            // line 78  (QEMU) — raw
bwlimit: (bandwidth ?? 150) * 1024,   // line 96  (LXC)  — KiB/s
```

PVE's `bwlimit` is KiB/s on both endpoints, so the QEMU default of 150 becomes
~0.15 MB/s. A 32 GB VM would take days. The commit message on `40a814f` asserts
"MiB/s for QEMU, KiB/s for LXC", which the PVE API schema does not support.

Whichever unit is correct, both branches cannot be — this is a defect either way.

Verify: `pvesh usage /nodes/{node}/qemu/{vmid}/migrate`

---

## Medium

### 5. `target_storage` is likely the wrong PVE parameter name

**`src/tools/migration.ts:81` and `:103`** · PLAUSIBLE

Both branches send `target_storage`. PVE names this `targetstorage` (one word)
on the QEMU migrate endpoint and `target-storage` (hyphen) on the LXC one.
`pvesh` rejects unknown options, so any call supplying this parameter errors out
before the migration starts.

The test at `tests/migration.test.ts:248` locks in the current spelling by
asserting on the params object rather than any real API contract.

Verify: `pvesh usage /nodes/{node}/qemu/{vmid}/migrate` and the `lxc` equivalent.

### 6. LXC clone params may use QEMU spellings

**`src/tools/migration.ts:129`** · PLAUSIBLE

`cloneParams` sets `vmid: newVmid` and `name`, but PVE's
`/nodes/{node}/lxc/{vmid}/clone` takes `newid` for the destination ID and
`hostname` for the name (`name` is the QEMU spelling). Worse, `vmid` is already
the **path** parameter of this endpoint, so passing `--vmid 300` either errors as
a duplicate or is interpreted as the source.

Combined with finding 1, a misinterpreted `vmid` would mean cloning and then
deleting the wrong container.

`src/tools/provisioning.ts:171-173` shares this spelling — if `clone_guest` is
known-working on the cluster, discount this finding.

Verify: `pvesh usage /nodes/{node}/lxc/{vmid}/clone`

### 7. `dry_run` silently drops guests whose tag check failed

**`src/tools/migration.ts:328`** · CONFIRMED

Tag-read failures are pushed into `failed` at line 319, but the dry-run report
(lines 325-346) renders only `toMigrate` and `skipped`. A guest whose config read
returned null or errored appears in **neither** list, so an operator previewing a
drain sees a plan that omits it entirely and concludes the node will be fully
evacuated.

The non-dry-run summary does print a "Failed" section (line 401), so the omission
is clearly unintended.

### 8. Test mock bypasses zod, so no schema default is ever exercised

**`tests/migration.test.ts:57`** · CONFIRMED · *load-bearing*

`createMockServer` stores the raw handler and the tests invoke it directly, so
the `inputSchema` — including every `.default()` — is never applied. Assertions
about default `online`, `bandwidth` and `dry_run` behavior therefore exercise an
`undefined` code path that production cannot reach.

This is exactly why finding 2 shipped green, and it means several other
default-related assertions are currently meaningless. **Fix this first** — it
changes what the rest of the suite is actually proving.

```ts
// in the mock registerTool:
registerTool(name, meta, handler) {
  this.tools[name] = (args) => handler(z.object(meta.inputSchema).parse(args));
}
```

---

## Low

### 9. `bandwidth: 0` silently means *unlimited*

**`src/tools/migration.ts:188` and `:249`** · CONFIRMED

`z.number().default(150)` has no `.min()`, and PVE treats `bwlimit: 0` as "no
limit". A caller asking for zero bandwidth — or a model emitting `0` — gets an
unthrottled migration that can saturate the cluster network during a drain.
Negative and fractional values are likewise unvalidated.

**Fix:** `.int().positive()` on both schemas.

### 10. Fallback trigger matches error text PVE does not emit

**`src/tools/migration.ts:115`** · PLAUSIBLE

```ts
if (!msg.includes("No 'create' handler") && !msg.includes("handler defined")) {
  throw err;
}
```

When the endpoint genuinely does not exist, `pvesh` surfaces a 501
"Method 'POST ...' not implemented" or "no such resource" — neither matches, so
the error is rethrown and the fallback never runs on the very clusters it was
written for. The string match is also brittle across PVE versions and locales.

**Fix direction:** key on `err.exitCode` / HTTP status instead of message text.

---

## Checked and found sound

- **Fail-closed tag verification** (`getGuestTags`, lines 30-41): null or
  non-object config correctly throws rather than treating the guest as untagged.
  `split(/[;,]/)` covers both PVE 8 and 9.x separators.
- **`assertMovable` placement** in `clone_guest`
  (`src/tools/provisioning.ts:164-167`) correctly uses `info.node` — the guest's
  real node — for the config read, and the `target !== info.node` condition
  covers both the explicit-`target_node` and default-`node` cases.
- **`migrate_guest`** resolves the guest's real node via `resolveGuest` before
  the same-node check and the tag check, so a stale `node` argument cannot bypass
  either guard.
- **`drain_node` error isolation**: a single migration failure is caught and the
  loop continues (line 368), and `errMsg` handles non-`Error` throws.
- **No import cycle** introduced by `provisioning.ts` → `migration.ts`.

## Adjacent, pre-existing (out of diff scope)

`src/tools/provisioning.ts:178` issues the clone against `/nodes/${node}/...`
while the new guard reads `info.node`, so `clone_guest` on a guest that is not on
the default node builds a wrong API path. Newly visible next to the guard, but
not introduced by this branch.

---

## Suggested remediation order

1. **Finding 8** — fix the mock so defaults are exercised; this is what lets the
   rest be verified.
2. **Finding 2** — the `online` default (finding 8 will now fail the test that
   hid it).
3. **Finding 1** — restructure or gate the clone fallback's delete.
4. **Finding 3** — `waitForTask(node, ...)`, and the same fix at
   `provisioning.ts:177`.
5. **Findings 5, 6, 10, 4** — confirm against `pvesh usage` on the live cluster,
   then correct together.
6. **Findings 7, 9** — small, independent.


---

# Remediation (2026-09-25)

All ten round-2 findings are addressed. `npx tsc --noEmit` is clean, **182 tests
pass** (up from 166), and coverage is back at the configured **100%** threshold
for statements, branches, functions and lines.

| # | Finding | Resolution |
|---|---------|------------|
| 8 | Test mock bypasses zod | `createMockServer` now runs `z.object(meta.inputSchema).parse(args)` before calling the handler, in all five tool test files — not just `migration.test.ts`. The wrapper is `async`, so schema rejections surface as rejected promises the way the SDK delivers them. |
| 2 | Default migration was offline | `online` dropped its `.default(false)` and is now `.optional()`. `undefined` means "caller did not choose", so QEMU defaults to live and LXC to restart — which is what the tool descriptions always claimed. |
| 1 | Clone fallback ran two copies, then deleted the original | Resequenced to **stop original → clone → start clone**. The two containers are never live at once, the clone is taken from a stopped source, and the original is **no longer deleted** — it is left stopped and reported in the tool output. This restores the README's "no destructive guest deletion" scope note. |
| 3 | Clone task awaited on the wrong node | Clone UPIDs are now polled on the **source** node that owns them, in both `migration.ts` and `provisioning.ts`. |
| 4 | `bwlimit` unit disagreed by 1024x | Both branches now convert MB/s → KiB/s through a single `KIB_PER_MB` constant. |
| 5 | Wrong `target_storage` spelling | Now `targetstorage` on the QEMU migrate endpoint and `target-storage` on the LXC one. |
| 6 | LXC clone used QEMU spellings | LXC clone now sends `newid` + `hostname` (never `vmid`, which is the path parameter); target storage is `storage`. `clone_guest` in `provisioning.ts` was corrected the same way. |
| 7 | `dry_run` silently dropped failed guests | The dry-run report gained a "Cannot determine — tag check failed" section plus an explicit warning that the node would not be fully evacuated. |
| 9 | `bandwidth: 0` meant unlimited | `bandwidthParam` is now `.int().positive()`, shared by both tools. Since zod always supplies the default, the dead `bandwidth ?? 150` fallback inside `performMigration` was removed. |
| 10 | Fallback trigger matched text PVE does not emit | Replaced with `isEndpointMissing()`, which matches a list of missing-endpoint fragments (including `not implemented`, `no such resource` and `501`) case-insensitively against both the message and any captured `stderr`. |

Also fixed, from "Adjacent, pre-existing": `clone_guest` issued its clone against
`/nodes/${node}/...` while the `dont-move` guard read `info.node`. It now uses
`info.node` for both, so cloning a guest that is not on the default node builds
the right API path.

## Still worth confirming on the live cluster

Findings 4, 5, 6 and 10 were marked PLAUSIBLE because they depend on the real PVE
API contract. They have been corrected to the documented PVE parameter names and
units, but that is not the same as observing them work. Before relying on a
production drain, confirm:

```
pvesh usage /nodes/{node}/qemu/{vmid}/migrate
pvesh usage /nodes/{node}/lxc/{vmid}/migrate
pvesh usage /nodes/{node}/lxc/{vmid}/clone
```

The clone fallback in particular has never been exercised against a cluster that
actually lacks the LXC migrate endpoint — only against the mock.
