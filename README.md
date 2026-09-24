# Proxmox MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) server for managing [Proxmox VE](https://www.proxmox.com/) clusters. Connects to Proxmox via SSH and uses `pvesh` for all API operations.

## Architecture

```
Claude / Cline (MCP Client)
    ↕ HTTP (Streamable HTTP transport)
Proxmox MCP Server (Docker container)
    ↕ SSH (key-based auth)
Proxmox VE (pvesh)
```

## Prerequisites

- Proxmox VE 8.x or later (tested on 9.2)
- Your SSH public key added to the Proxmox host (`~/.ssh/authorized_keys`)
- Docker + Docker Compose

## Setup

### 1. SSH Key

Ensure your SSH public key is on the Proxmox host:

```bash
ssh-copy-id root@<proxmox-ip>
```

### 2. Configure

Create a .env file with your Proxmox SSH details (required — the app will not start without PROXMOX_SSH_HOST):


```env
PROXMOX_SSH_HOST=10.0.0.19
PROXMOX_SSH_USER=root
PROXMOX_SSH_KEY=~/.ssh/id_rsa
MCP_PORT=3000
```

### 3. Run

```bash
docker compose up -d
```

Verify:

```bash
curl http://localhost:3000/health
# {"status":"ok","service":"proxmox-mcp"}
```

### 4. Connect MCP Client

**Cline / VS Code:**
```json
{
  "mcpServers": {
    "proxmox": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

**Claude Desktop:**
```json
{
  "mcpServers": {
    "proxmox": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

## Tools

> **Scope note:** All lifecycle and power operations target **guests** (QEMU VMs or LXC containers) only. This server does **not** expose physical host power management (node shutdown/reboot) or destructive guest deletion operations. Guests tagged `dont-move` are protected from migration and cross-node cloning.

### Inspection
| Tool | Description |
|------|-------------|
| `list_nodes` | Cluster nodes with status, CPU, memory |
| `list_resources` | All resources (VMs, containers, storage, SDN) |
| `list_vms` | QEMU VMs on a node |
| `list_containers` | LXC containers on a node |
| `get_guest_status` | Live status of a VM/container |
| `get_guest_config` | Full VM/container configuration |
| `list_storage` | Storage pools with usage |
| `list_storage_content` | Files/images in a storage pool |
| `list_isos` | Available ISO files |
| `list_lxc_templates` | Available LXC container templates |
| `list_tasks` | Recent tasks on a node |

### Lifecycle
| Tool | Description |
|------|-------------|
| `start_guest` | Start a VM or container |
| `stop_guest` | Force-stop a VM or container |
| `shutdown_guest` | Graceful shutdown |
| `reboot_guest` | Reboot |
| `suspend_guest` | Suspend (freeze in memory) |
| `resume_guest` | Resume from suspended |

### Snapshots
| Tool | Description |
|------|-------------|
| `list_snapshots` | List snapshots |
| `create_snapshot` | Create a snapshot |

### Provisioning
| Tool | Description |
|------|-------------|
| `create_vm` | Create a QEMU VM from an ISO |
| `create_container` | Create an LXC container from a template |
| `clone_guest` | Clone a VM or container (cross-node clones refused for `dont-move` tagged guests) |
| `set_guest_config` | Modify VM/container settings (CPU, memory, swap (LXC), name, onboot) |

### Migration
| Tool | Description |
|------|-------------|
| `migrate_guest` | Live-migrate a QEMU VM or move an LXC container to another node |
| `drain_node` | Migrate all guests off a node (for maintenance/decommission) |

## Development

```bash
npm install
npm run dev        # run with tsx (no build step)
npm run build      # compile TypeScript
npm start          # run compiled output
```