# Policy-bound agent access

Loci can expose a deliberately narrow research surface to a local agent over
Model Context Protocol (MCP) stdio. The MCP process opens no HTTP or other
network listener. It uses the same validated project, recipe, job, result, and
export code as the desktop and CLI.

Agent access is disabled until a person writes an explicit policy file and
starts the server with that exact path:

```console
cd engine
uv run python -m loci_engine.research_cli mcp --policy /absolute/path/policy.json
```

The policy is local authorization, not a scientific validation record. Source
names and metadata remain untrusted data and must never be treated as agent
instructions.

## Policy lifecycle

`loci_engine.agent_policy.write_policy(path, project, specification)` is the
human-side helper for creating or updating a policy. The local human CLI calls
it with an explicit JSON object or `@file`:

```console
uv run python -m loci_engine.research_cli policy \
  --project /absolute/path/example.loci-study \
  --destination /absolute/path/policy.json \
  --specification @/absolute/path/grants.json
```

The helper accepts every grant as explicit data, fills in the exact study path
and project identity, validates the document, and atomically writes a private
file. On POSIX the policy must be a current-user-owned, single-link plain file
with mode `0600`. The path passed to the server must be absolute.

At startup, the MCP process pins all of the following:

- policy file device/inode and SHA-256 content hash;
- absolute study path and the study's stored project identity;
- each allowed source ID and registered source SHA-256;
- export-root device/inode, when export is enabled.

The process rereads and verifies the policy and project identity before every
tool call. Source bytes are rehashed before a source, job, or result is used.
Editing, replacing, chmod-ing, unlinking, or redirecting the policy revokes the
running process; restart it explicitly to accept a new policy. Replacing the
export root also fails closed.

The policy schema is `loci.agent-policy/v1` and has these exact fields:

```json
{
  "schema": "loci.agent-policy/v1",
  "project": {
    "path": "/absolute/path/example.loci-study",
    "id": "32-lowercase-hex-characters"
  },
  "sources": [
    {
      "id": "32-lowercase-hex-characters",
      "sha256": "64-lowercase-hex-characters",
      "crop": {"x": 0, "y": 0, "width": 512, "height": 512},
      "t": [0],
      "c": [0, 1],
      "z": [0, 1, 2],
      "level": [0],
      "measurement_channels": [0, 1]
    }
  ],
  "recipes": [
    {
      "sha256": "sha256-of-the-normalized-recipe",
      "preview": true,
      "run": false
    }
  ],
  "operations": ["validate_recipe", "preview_recipe"],
  "model_packages": [],
  "runtimes": [
    {
      "engine": "0.1.0",
      "numpy": "exact-version",
      "scipy": "exact-version",
      "scikit_image": "exact-version",
      "backend": "numpy-scipy-cpu",
      "resolved_device": "cpu"
    }
  ],
  "export": null,
  "limits": {
    "cpu_seconds": 300,
    "memory_bytes": 4294967296,
    "concurrency": 1
  },
  "disclosures": []
}
```

Crop bounds are inclusive at `x,y` and exclusive at `x + width,y + height`.
Every selected T, C, Z, and pyramid level must be listed. A Z range is allowed
only when every plane in the half-open range is listed. Measurement channels
have their own list because they can differ from the displayed or segmented
channel.

Recipe hashes are calculated after `Workbench.validate_recipe` resolves all
defaults. Validation can normalize a new proposal and return its hash without
reading pixels. Preview and durable execution require that exact normalized
hash and the corresponding boolean grant. This prevents an agent from varying
a threshold or other image-dependent parameter as a covert query.

The manual workbench may bind flat-field or dark-field reference images. Agent
recipes currently reject every non-empty `references` object before validation.
Adding that capability requires a later policy revision that independently
checks each reference source fingerprint and selection scope.

Runtime records are exact identities for the built-in CPU implementation.
Current workbench recipes do not load model packages; `model_packages` is an
explicit dormant scope for a future recipe integration and grants no download,
installation, loading, or execution right by itself. There is no MCP model or
runtime provisioning tool.

For an export grant, use an existing absolute plain `root` and a non-empty list
of exact single-component `filenames`. Export writes one new directory and
never overwrites an existing path:

```json
"export": {
  "root": "/absolute/plain/export-root",
  "filenames": ["experiment-01-reviewed"]
}
```

## Disclosure categories

Every sensitive response category is denied unless separately named in
`disclosures`:

| Category | Data it permits |
| --- | --- |
| `geometry` | resolved crops, shapes, calibration, and coordinate geometry |
| `source_names` | registered display names and source metadata text |
| `previews` | rendered image content |
| `measurements` | object counts and measurement rows |
| `provenance` | recipe, processing, runtime, and execution provenance |
| `agent_metadata` | policy hash, project ID, granted-operation summary, and extra record metadata |

The `catalog` response is always limited to static tool names and descriptions.
It contains no project or dataset content; policy and project metadata appear
there only with `agent_metadata`.

`preview_recipe` and `result_view` require `previews`. Measurement and
provenance fields in a preview or result are independently omitted unless their
categories are granted. The current full research export contains derived image
data, source metadata, geometry, measurements, and methods provenance, so
`export_result` requires `previews`, `source_names`, `geometry`, `measurements`,
and `provenance` as well as its destination grant.

## Tools

| Tool | Boundary |
| --- | --- |
| `catalog` | Static catalog only; no study enumeration |
| `validate_recipe` | Normalize and validate one policy-scoped proposal; no pixel execution |
| `preview_recipe` | Execute one approved recipe without adopting a result |
| `submit_recipe` | Idempotently submit and asynchronously start an approved durable run |
| `job_status` | Read one supplied, policy-verifiable job ID |
| `cancel_job` | Cancel one supplied, policy-verifiable job ID |
| `result` | Read one supplied, policy-verifiable result ID through disclosure filters |
| `result_view` | Render one supplied, policy-verifiable result revision |
| `export_result` | Export one exact reviewed revision to one authorized filename |

There is no tool for file browsing, import, relink, policy creation or editing,
human review, arbitrary project listing, shell execution, dynamic sampling, or
network egress. MCP cannot manufacture a `reviewed` receipt. A person must set
review state through the local desktop or human CLI before export.

Jobs persist in the study database. Reusing a request key with the same
normalized request returns the same job; reusing it with different parameters
is rejected. Execution uses only this fixed child command:

```text
python -m loci_engine.research_cli run --project PROJECT --job JOB_ID \
  --cpu-seconds CPU_SECONDS --memory-bytes MEMORY_BYTES
```

The server records each child object and signals it only when the durable job
record contains the same PID. Cancellation of an unowned process updates the
durable cancellation flag but never sends a signal to that PID. The result
transaction checks cancellation immediately before publication. A policy
watcher cancels an owned child if its pinned policy is revoked while it runs.

The allowed policy range is 1-86,400 CPU seconds and 64 MiB-8 GiB of memory.
The policy's `working_bytes` ceiling is checked for every recipe. Before opening
the project, the fixed CLI child applies per-process user CPU time and committed
memory limits with a Windows Job Object, `RLIMIT_CPU` and `RLIMIT_AS` on Linux,
and `RLIMIT_CPU` on macOS. macOS exposes but rejects finite `RLIMIT_AS`, so its
memory boundary is the workbench's validated `working_bytes` and bounded array
operations. `concurrency` counts both running durable jobs and live owned child
processes before a new child starts. The Windows CI job exercises CPU
termination and committed-memory denial in real child processes before creating
an installer.

Export first builds and round-trip-checks an exact reviewed package in a private
directory under the authorized root. Loci rechecks the pinned policy, source,
result, recipe, revision, and human review immediately before an atomic
no-replace rename to the authorized filename.

## SDK clients

The Python SDK connects over stdio without a listener:

```python
from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

params = StdioServerParameters(
    command="/absolute/path/to/python",
    args=[
        "-m", "loci_engine.research_cli", "mcp",
        "--policy", "/absolute/path/policy.json",
    ],
)
async with stdio_client(params) as streams, ClientSession(*streams) as session:
    await session.initialize()
    tools = await session.list_tools()
    catalog = await session.call_tool("catalog")
```

The TypeScript SDK uses the same transport and command:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "loci-client", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: "/absolute/path/to/python",
  args: [
    "-m", "loci_engine.research_cli", "mcp",
    "--policy", "/absolute/path/policy.json",
  ],
});
await client.connect(transport);
const tools = await client.listTools();
const catalog = await client.callTool({ name: "catalog", arguments: {} });
await client.close();
```

Both contract exercises in development use generated synthetic TIFF data only.
They verify real SDK initialization, tool discovery, static catalog access, and
recipe validation over the subprocess stdio transport.
