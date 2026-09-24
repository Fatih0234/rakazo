# Data jobs: scraping, durable datasets, scheduled analysis, and verification

## Status

Implementation design for extending Rakazo with flexible, repeatable data collection and analysis.

This document is intentionally broader than "web scraping." The product concept is a **data job**: a persistent agent-maintained workflow that can collect structured data from the web, browser sessions, APIs, downloads, CSV/JSON/Parquet files, or combinations of those sources; preserve reliable historical snapshots; query those snapshots efficiently; and use ordinary Rakazo routines to repeat the work.

The design is grounded in the current repository rather than introducing a second workflow system.

## Product intent

Rakazo already gives each bot a persistent identity, computer, browser profile, files, shell access, skills, routines, artifacts, and one continuous conversation. The data-job feature should make those primitives work together for recurring research and monitoring.

Typical requests include:

- monitor a competitor product catalog and report additions, removals, availability changes, and price moves;
- collect new articles from a known set of sources and summarize only what changed;
- maintain marketplace or listing datasets where the site requires JavaScript or pagination;
- combine a user's CSV or API export with data acquired from the web;
- revisit an authenticated supplier or partner portal on a schedule and analyze downloaded data.

The same architecture should support all of these without adding product-specific scraper types.

## Non-goals

Do not turn Rakazo into:

- a visual scraping workflow builder;
- a site-adapter catalog with a new backend class for every source;
- a crawler DSL for CSS/XPath selectors;
- a second scheduler parallel to routines;
- a data warehouse that stores arbitrary scraped rows directly in Postgres;
- a system that sends full large datasets into the language model context;
- a product-catalog-specific feature disguised as a generic scraper.

This follows the current product direction in [VISION.md](../VISION.md): routines remain scheduled prompts, the backend owns orchestration and recovery, computers are durable places, and chat should show useful results rather than internal execution machinery.

---

## 1. Current fork baseline

The fork already contains two important experimental pieces that should be treated as the starting point.

### 1.1 Built-in `Datasets` skill

[packages/adapters/src/builtin-skills.ts](../packages/adapters/src/builtin-skills.ts) already contains a built-in `Datasets` skill. It teaches bots to:

- use DuckDB;
- keep raw extracts;
- define stable keys;
- compare refreshed data;
- preserve the prior good state if collection partially fails;
- query before charting;
- use `render_plot` for visualization.

This is directionally correct and should not be duplicated with a second overlapping built-in skill.

The recommendation in this document is to **evolve the existing `Datasets` skill into the data-job protocol**, while keeping the skill name stable initially to avoid unnecessary migration. "Data job" is the architecture/product concept; `Datasets` can remain the built-in skill name until there is a strong UX reason to rename it.

### 1.2 DuckDB CLI in the Docker computer image

[infra/sandboxes/computer/Dockerfile](../infra/sandboxes/computer/Dockerfile) already builds and installs the DuckDB CLI.

That is useful for experimentation and for agent-authored collector work inside Docker computers. It is not sufficient as the final canonical analytics boundary because [docs/computer-runtime.md](computer-runtime.md) explicitly treats the **portable workspace**, not the disposable OS image, as durable state. Computer providers can differ in which system packages are installed.

The final design therefore separates:

- **collector implementation and working files**, which live with the bot computer;
- **canonical dataset snapshots**, which are owned by Rakazo;
- **bounded structured analytics**, which should not depend on a particular computer provider having a DuckDB binary.

The existing CLI remains useful for local exploration, transforms, exports, and debugging.

---

## 2. Core architectural decision

The primary abstraction is a **data job**, not a scraper.

Scraping is only one acquisition method.

A data job answers these questions:

1. What information is being maintained?
2. Which sources can supply it?
3. What constitutes one record?
4. What stable key identifies the same record between runs?
5. Which fields are required for a snapshot to be considered valid?
6. What history should be preserved?
7. Which comparisons or questions matter to the user?
8. When should the job run?
9. What should be shown when something changes?
10. What happens when collection is incomplete or unreliable?

The agent remains free to decide how to collect the records:

```text
                         DATA JOB
                            |
          +-----------------+------------------+
          |                 |                  |
          v                 v                  v
      web_fetch          browser              API
          |          navigate/snapshot          |
          |               /act                  |
          +-----------------+------------------+
                            |
                            v
                    generated collector
                  Python / shell / download
                            |
                            v
                   structured staging data
                            |
                            v
                        validate
                            |
                            v
                     dataset_publish
                            |
                            v
                  durable DataSnapshot(s)
                            |
                            v
                       query_data
                            |
                            v
                  model analysis / chart
```

Rakazo owns the durable and safety-sensitive parts. The agent owns the open-ended collection strategy.

---

## 3. Reuse the existing routine execution path

No scraping-specific scheduler should be added.

The current schedule path already has the behavior a data job needs:

```text
Routine.crons
    |
    v
routineWakeupJob()
    |
    v
"routine.wakeup"
    |
    v
background-job-handlers.ts
    |
    v
executor.wakeRoutine()
    |
    +--> expand skill references
    |
    +--> create Task
    |
    +--> create Run(trigger = "routine")
    |
    v
ordinary agent execution
```

Relevant code:

- [packages/adapter-kit/src/background-jobs.ts](../packages/adapter-kit/src/background-jobs.ts)
- [packages/adapters/src/background-job-handlers.ts](../packages/adapters/src/background-job-handlers.ts)
- [packages/adapters/src/executor.ts](../packages/adapters/src/executor.ts)
- [packages/contracts/src/domain.ts](../packages/contracts/src/domain.ts)
- [packages/db/prisma/schema.prisma](../packages/db/prisma/schema.prisma)

A recurring catalog monitor should therefore still be represented by a normal routine prompt, for example:

```md
@Datasets

Run the acme-catalog data job.

Compare the new successful snapshot with the previous successful snapshot.

Report:
- products added;
- products removed;
- availability changes;
- price changes of at least 10%.

Create a chart only when it improves the explanation.
If nothing significant changed, say so briefly.
```

This preserves a single scheduling model and keeps the data feature aligned with the explicit vision that routines are scheduled prompts rather than a visual workflow language.

---

## 4. Data-job workspace convention

The bot's portable computer workspace is the natural home for job implementation.

Use a predictable directory convention:

```text
data/
  jobs/
    <job-key>/
      JOB.md
      collect.py              # optional; agent chooses language/mechanism
      state.json              # optional non-secret working state
      staging/
        latest.jsonl
        latest.csv
        latest.parquet
      raw/
        2026-09-23/
        2026-09-24/
      debug/
        last-error.html
        last-response.json
```

On Team Computers, relative paths already start inside the bot's folder. Deliberately shared work can still use `shared/` according to [docs/computer-runtime.md](computer-runtime.md). A data job should not assume that all data belongs in the Team shared folder; sharing remains an explicit choice.

### 4.1 `JOB.md`

`JOB.md` is a human-readable job contract, not a full workflow DSL.

Example:

```md
---
name: Acme catalog
key: acme-catalog
---

# Goal

Maintain the current Acme footwear catalog.

# Sources

- https://fixture.example/catalog

# Record identity

Prefer SKU.
If SKU is unavailable, use canonical product URL.

# Required fields

- sku
- name
- brand
- category
- price
- currency
- availability
- source_url

# Collection rules

- follow all category pagination;
- ignore recommendations and reviews;
- normalize prices to numeric values;
- never invent missing values.

# Validation

A valid refresh must:
- contain at least 90% of the previous successful row count unless the source
  clearly indicates a legitimate catalog contraction;
- contain no duplicate non-empty SKU values;
- have source_url for every record;
- parse price as numeric or null.

# Analysis

Compare with the previous successful snapshot.

Highlight:
- new products;
- removed products;
- availability changes;
- price changes >= 10%.
```

The agent may update this file when it learns a stable source quirk or the schema legitimately changes.

Do not put credentials, session cookies, access tokens, passwords, or other protected values in `JOB.md`, collector code, shell history, or state files.

### 4.2 Collector code is intentionally open-ended

Rakazo should not define:

```text
AmazonScraper
ShopifyScraper
NewsScraper
PaginationScraper
InfiniteScrollScraper
...
```

The collector can instead be whatever the persistent agent determines is reliable:

- `web_fetch`;
- browser page tools;
- a direct public API;
- a downloaded file;
- generated Python;
- shell tools;
- a connector;
- a mixture of the above.

The contract is the structured output and successful snapshot semantics, not the internal extraction mechanism.

---

## 5. Acquisition strategy

The evolved `Datasets` skill should teach an explicit preference order.

Prefer the simplest reliable source:

```text
structured API / existing export
           |
           v
      web_fetch
           |
           v
 page-browser tools
           |
           v
 desktop interaction
           |
           v
 reusable generated collector
```

This is a preference, not a hard rule. Some jobs will combine several methods.

### 5.1 Existing tools to reuse

The repository already exposes the needed primitives in
[packages/adapters/src/builtin-tools.ts](../packages/adapters/src/builtin-tools.ts):

- `web_search`;
- `web_fetch`;
- `browser_navigate`;
- `browser_snapshot`;
- `browser_act`;
- `computer_observe`;
- `computer_act`;
- `read_file`;
- `write_file`;
- `list_files`;
- `shell`;
- `attach_file`;
- `render_plot`;
- takeover and secret-related tools.

Do not add a generic `scrape_url` tool initially. That would create a second, less capable acquisition abstraction on top of primitives the agent already has.

---

## 6. Separate job working state from canonical snapshots

The bot computer should hold collector code, temporary files, debugging evidence, and raw extracts useful for maintaining the job.

Canonical successful history should eventually be represented by Rakazo-owned snapshot metadata and Rakazo-owned bytes.

This distinction is important for three reasons.

### 6.1 Computer replacement

[docs/computer-runtime.md](computer-runtime.md) makes the portable workspace durable, but system packages are not guaranteed portable across providers. A dataset history feature should not depend on the lifecycle of one provider machine.

### 6.2 Correct success semantics

A partially collected file must never silently become the new canonical "latest" dataset.

The workflow must be:

```text
last successful snapshot
          |
          v
       collect
          |
          v
       staging
          |
          v
       validate
       /      \
      /        \
 failure      success
    |            |
    v            v
keep old      publish
snapshot      new snapshot
```

### 6.3 Large datasets are not chat attachments

The existing attachment path is intentionally constrained for chat.

[packages/contracts/src/attachments.ts](../packages/contracts/src/attachments.ts) defines a 10 MiB attachment limit, and
[packages/adapters/src/thread-artifacts.ts](../packages/adapters/src/thread-artifacts.ts) applies it when attaching a workspace file to a thread.

That limit is appropriate for chat files. It should not define the maximum size of a canonical dataset.

The implementation can reuse the **storage concept** behind [packages/adapter-kit/src/interfaces.ts](../packages/adapter-kit/src/interfaces.ts) and [packages/adapters/src/artifacts.ts](../packages/adapters/src/artifacts.ts), but dataset publication needs its own contract and limits rather than simply calling the thread-attachment helper.

---

## 7. First persistence model: `DataSnapshot`

Do not begin with a large `DataJob` relational model containing sources, selectors, transforms, schedules, and analysis steps.

The job is already represented by:

- the bot;
- its persistent workspace;
- `JOB.md`;
- optional reusable collector code;
- the ordinary routine.

The first missing durable product concept is the **successful dataset snapshot**.

Proposed Prisma model:

```prisma
model DataSnapshot {
  id         String   @id @default(cuid())

  spaceId    String
  space      Space    @relation(fields: [spaceId], references: [id], onDelete: Cascade)

  botId      String
  bot        Bot      @relation(fields: [botId], references: [id], onDelete: Cascade)

  userId     String
  runId      String?

  jobKey     String
  name       String

  format     String
  rowCount   Int?
  size       BigInt
  hash       String
  storageKey String

  capturedAt DateTime
  createdAt  DateTime @default(now())

  @@index([spaceId, botId, jobKey, capturedAt])
  @@index([runId])
  @@map("data_snapshots")
}
```

Exact field choices can be adjusted during implementation, but the model should preserve these semantics:

- scoped to a Space authorization boundary;
- attributable to bot/user/run;
- grouped by stable `jobKey`;
- immutable once published;
- ordered by `capturedAt`;
- points at separately stored bytes;
- stores enough metadata to list/query history without opening the dataset.

### 7.1 Why not store rows in Postgres?

A 50,000-row catalog should not become 50,000 Rakazo relational rows unless the product later develops a separate warehouse architecture.

Postgres stores **metadata and ownership**.

The dataset bytes remain in a binary/object storage abstraction.

### 7.2 Why snapshots instead of a mutable `.duckdb` database?

The existing `Datasets` skill currently suggests one logical `.duckdb` file and copying the current table into a `*_prev` table before refresh.

That is a good prototype but weaker as the long-term canonical format:

- DuckDB has one-writer constraints;
- a mutable database makes "what exactly was the successful state on Tuesday?" less explicit;
- copying an open database can be unsafe;
- a failed refresh can accidentally mutate the canonical store before validation;
- immutable Parquet/JSONL snapshots are easier to transport and inspect.

Recommended canonical representation:

```text
raw acquisition
      |
      v
JSONL / CSV / source download
      |
      v
normalized Parquet
      |
      v
immutable DataSnapshot
```

DuckDB is then the query engine over immutable files.

This does not prohibit a collector from using a local `.duckdb` file as working state. It only says that the product-level historical boundary is an immutable snapshot.

---

## 8. New tool: `dataset_publish`

`dataset_publish` should be the first data-specific built-in tool.

Its purpose is not to collect data. It atomically promotes a validated workspace file into a canonical snapshot.

### 8.1 Proposed tool contract

Add to [packages/adapters/src/builtin-tools.ts](../packages/adapters/src/builtin-tools.ts):

```ts
{
  name: "dataset_publish",
  description:
    "Publish a validated structured dataset from this bot's workspace as an immutable " +
    "snapshot for a named data job. Use only after collection and validation succeed.",
  inputSchema: {
    type: "object",
    properties: {
      job_key: { type: "string" },
      name: { type: "string" },
      path: { type: "string" },
      format: {
        type: "string",
        enum: ["parquet", "jsonl", "csv", "json"],
      },
      row_count: { type: "number" },
      captured_at: { type: "string" },
    },
    required: ["job_key", "name", "path", "format"],
  },
}
```

Do not trust model-supplied `row_count` as authoritative if it can be cheaply verified from the file. Treat it as a hint unless the implementation validates it.

### 8.2 Execution flow

The handler should follow the same general executor pattern as `attach_file` and `render_plot`, but live in a focused helper module rather than adding a large amount of code directly to `executor.ts`.

Suggested module:

```text
packages/adapters/src/data-snapshots.ts
```

Execution:

```text
dataset_publish
      |
      v
resolve bot workspace path
      |
      v
SandboxProvider.readFile()
      |
      v
validate size / format / non-empty content
      |
      v
optional lightweight row/schema validation
      |
      v
DatasetStore.put()
      |
      v
transaction: create DataSnapshot metadata
      |
      v
return snapshot metadata
```

### 8.3 Storage interface

The current `ArtifactStore` is close to what is needed:

```ts
put(...)
get(...)
remove(...)
```

Two viable implementations exist.

**Phase-one option:** reuse `ArtifactStore` internally with a distinct dataset path and metadata table.

**Longer-term cleaner option:** introduce a provider-neutral `DatasetStore` only if dataset-specific requirements justify it, for example streaming, objects larger than attachment-oriented limits, or range access.

Follow [AGENTS.md](../AGENTS.md): do not add an interface merely for architectural symmetry. Add `DatasetStore` only when it protects a real external/storage boundary that `ArtifactStore` can no longer express cleanly.

### 8.4 Dataset size limits

Do not inherit `ATTACHMENT_MAX_BYTES`.

Define explicit dataset publication limits based on deployment/resource safety. They should be configurable or at least centralized.

The first implementation should bound:

- maximum source file bytes per publish;
- maximum snapshots retained/queryable per operation if necessary;
- query-time aggregate bytes;
- worker temporary disk usage.

---

## 9. New tool: `query_data`

`query_data` is the second important primitive.

Its purpose is to keep large datasets outside model context while giving the model a flexible analytical language.

### 9.1 The model queries snapshot IDs, not arbitrary server paths

Proposed contract:

```json
{
  "datasets": [
    {
      "snapshot_id": "current-snapshot-id",
      "alias": "current"
    },
    {
      "snapshot_id": "previous-snapshot-id",
      "alias": "previous"
    }
  ],
  "sql": "SELECT ...",
  "max_rows": 200
}
```

Result:

```json
{
  "columns": [
    { "name": "sku", "type": "VARCHAR" },
    { "name": "old_price", "type": "DOUBLE" },
    { "name": "new_price", "type": "DOUBLE" },
    { "name": "change_pct", "type": "DOUBLE" }
  ],
  "rows": [
    ["A12", 99, 119, 20.2],
    ["B91", 149, 129, -13.4]
  ],
  "truncated": false
}
```

This is preferable to terminal-formatted SQL output because it is:

- structured;
- bounded;
- predictable for the model;
- independent from shell quoting;
- easier to test deterministically.

### 9.2 Example comparisons

Price changes:

```sql
SELECT
  current.sku,
  previous.price AS old_price,
  current.price AS new_price,
  ROUND(
    100 * (current.price - previous.price)
    / NULLIF(previous.price, 0),
    1
  ) AS change_pct
FROM current
JOIN previous USING (sku)
WHERE ABS(
  (current.price - previous.price)
  / NULLIF(previous.price, 0)
) >= 0.10
ORDER BY ABS(change_pct) DESC
LIMIT 100;
```

New products:

```sql
SELECT current.*
FROM current
LEFT JOIN previous USING (sku)
WHERE previous.sku IS NULL;
```

Category summary:

```sql
SELECT
  category,
  COUNT(*) AS product_count,
  AVG(price) AS average_price
FROM current
GROUP BY category
ORDER BY product_count DESC;
```

The model only receives the relevant query result, not the full underlying catalog.

---

## 10. Where DuckDB should run

The fork currently installs the DuckDB CLI in the Docker computer image. Keep that for agent-side exploration and transforms.

For the product-level `query_data` tool, prefer running DuckDB in the Rakazo API/worker execution environment against authorized snapshot bytes rather than requiring every sandbox provider to have a matching DuckDB installation.

Desired boundary:

```text
Bot computer
  collector
      |
      v
dataset_publish
      |
      v
Rakazo-owned DataSnapshot bytes
---------------- trust / provider boundary ----------------
Rakazo worker
      |
 query_data(snapshot ids)
      |
      v
load only authorized snapshots
      |
      v
isolated temporary query directory
      |
      v
DuckDB
      |
      v
bounded structured result
      |
      v
agent
```

Benefits:

- Docker, E2B, Daytona, Box, desktop, and future providers get identical query semantics;
- queries do not depend on a mutable bot machine;
- dataset access is authorized by Rakazo metadata;
- SQL result limits are enforced centrally;
- tests can run against local fixture snapshots without a live computer.

### 10.1 Dependency choice

When implementation begins, use the current supported DuckDB Node API rather than shelling out from the server process if the dependency fits the project.

Keep all DuckDB-specific code in an adapter/helper module so the executor sees a narrow provider-neutral function.

Possible location:

```text
packages/adapters/src/data-query.ts
```

---

## 11. Query security

Model-generated SQL is untrusted input.

`query_data` must not become an unrestricted server filesystem or network access primitive.

The implementation must provide defense in depth.

### 11.1 Snapshot authorization

For every `snapshot_id`:

1. load metadata through the current actor/run context;
2. require the same `spaceId`;
3. require the requesting bot/user policy to permit access;
4. resolve the snapshot's storage key internally;
5. never accept an arbitrary host path from model arguments.

### 11.2 Temporary query sandbox

Materialize only the explicitly authorized snapshots into a fresh temporary directory for the query.

Do not expose the repository root, `DATA_DIR`, secrets, browser profiles, or arbitrary host paths.

### 11.3 DuckDB restrictions

Configure DuckDB so queries cannot freely access external files, extensions, URLs, or the network.

The exact API can vary by DuckDB version, but the intended guarantees are:

- external access disabled by default;
- only materialized snapshot paths are readable;
- configuration is locked after setup;
- extension installation/loading is not model-controlled;
- no arbitrary output path writes.

### 11.4 Resource limits

Enforce outside SQL as well as inside the database:

- query wall-clock timeout;
- memory limit;
- temporary disk limit;
- maximum datasets per call;
- maximum aggregate input bytes;
- maximum result rows;
- maximum result bytes;
- maximum SQL text size.

`max_rows` requested by the model may lower the limit but must never raise the product cap.

### 11.5 Read-only semantics

`query_data` is a read-only analytical tool.

It must not persist mutations back into canonical snapshots.

Temporary DuckDB tables/views created during one call disappear with that call.

---

## 12. Tool registration and executor integration

Follow the existing built-in tool pattern.

### 12.1 Tool definitions

Add `dataset_publish` and `query_data` definitions in:

- [packages/adapters/src/builtin-tools.ts](../packages/adapters/src/builtin-tools.ts)

### 12.2 Tool selection

Existing run-specific built-ins are assembled in:

- [packages/adapters/src/executor.ts](../packages/adapters/src/executor.ts)

The data tools should be available for normal interactive runs and routine runs unless a future capability gate provides a concrete reason to hide them.

### 12.3 Tool execution

Keep data logic in focused modules and call them from the executor dispatch.

Suggested files:

```text
packages/adapters/src/data-snapshots.ts
packages/adapters/src/data-query.ts
```

Avoid turning `executor.ts` into the implementation of storage validation or SQL execution.

### 12.4 Activity descriptions

Add calm tool activity summaries in:

- [packages/adapters/src/pi-runtime.ts](../packages/adapters/src/pi-runtime.ts)

Examples:

```text
dataset_publish -> "Saving dataset snapshot"
query_data      -> "Querying saved data"
```

Do not expose raw SQL, filesystem paths, row-by-row scrape progress, or internal storage keys as user-facing progress.

---

## 13. Approval and unattended routine behavior

Scheduled monitoring is only useful if safe read/query operations can run unattended.

The existing approval taxonomy lives in:

- [packages/core/src/action-approval.ts](../packages/core/src/action-approval.ts)

### 13.1 `query_data`

If implemented with the read-only restrictions above, add `query_data` to the unattended-safe built-in set.

### 13.2 `dataset_publish`

`dataset_publish` mutates Rakazo-owned state, but it is analogous to writing the bot's own durable work rather than an external consequential action.

Do not require a user approval card for every scheduled snapshot publication.

Its safety comes from:

- space/bot ownership checks;
- bounded size;
- immutable snapshots;
- no external side effect;
- no deletion or overwrite of prior successful snapshots.

### 13.3 External actions stay governed normally

If a collection flow needs to:

- purchase something;
- send an email;
- change a supplier record;
- post a message;
- modify an external system;

that action remains subject to the existing connector/action approval rules. Data jobs do not weaken external-effect policy.

---

## 14. Authentication and protected input

Authenticated scraping should use Rakazo's existing persistent browser identity and protected-input boundaries.

Do not inject passwords or session secrets into arbitrary agent-generated code.

Preferred flow:

```text
first visit
   |
   v
browser needs login
   |
   v
request_takeover / protected input
   |
   v
user authenticates in visible browser
   |
   v
browser profile checkpointed
   |
   v
later routine reuses authenticated profile
```

This behavior is already supported conceptually by [docs/computer-runtime.md](computer-runtime.md).

If the session expires during an unattended routine:

- the run should request takeover / report that user action is required;
- the previous successful snapshot remains canonical;
- no "no changes" report may be emitted as though collection succeeded.

For API credentials, use Rakazo's existing secret/connector boundaries rather than writing protected values into collector scripts.

---

## 15. Evolve the existing `Datasets` skill

The current built-in skill is a useful prototype but should evolve from "manage a mutable DuckDB file" to the data-job protocol.

The updated skill should teach:

1. Recognize when a request is a repeatable data job.
2. Create/update `data/jobs/<job-key>/JOB.md`.
3. Prefer the simplest reliable acquisition method.
4. Reuse collector code on subsequent runs.
5. Write collection results to staging first.
6. Validate before publication.
7. Never replace a successful snapshot with a partial/failed collection.
8. Use `dataset_publish` to create canonical history.
9. Use `query_data` for comparisons and aggregation.
10. Use `render_plot` only after querying.
11. Report "no meaningful changes" briefly when that is the verified result.
12. Treat "collection failed" as structurally different from "collection succeeded and nothing changed."
13. Keep protected values out of files and generated scripts.
14. Repair existing collectors when sources change instead of reconstructing the workflow from scratch.

The skill should no longer make one mutable `.duckdb` file the required canonical storage pattern once `DataSnapshot` exists.

Local DuckDB files may remain an optional implementation detail for collector development.

---

## 16. Routine behavior

Routines remain normal prompts.

A job can be created interactively and then scheduled using the current schedule tools/UI.

Example:

```md
@Datasets

Run acme-catalog.

If collection fails validation, do not publish a snapshot and tell me what needs
attention.

If collection succeeds, compare with the previous successful snapshot and report:
- new or removed products;
- availability changes;
- price changes >= 10%.

Use a chart only if the differences are easier to understand visually.
```

A routine should not encode selectors, SQL pipelines, or implementation details that belong in `JOB.md` or reusable collector code.

This keeps the routine readable and editable.

---

## 17. Failure semantics

Correct failure semantics are central to the feature.

The product must distinguish:

```text
A. successful collection + no differences
B. successful collection + meaningful differences
C. collection failed before validation
D. collection validated but snapshot publication failed
E. analysis/query failed after a snapshot was successfully published
F. authentication expired / human action required
```

These cases must not collapse into the same chat message.

### 17.1 Collection failure

- no new canonical snapshot;
- previous latest successful snapshot remains latest;
- explain which part failed at a useful level;
- preserve debugging evidence in the bot workspace where appropriate;
- routine run may fail or complete with a needs-attention result depending on existing run semantics.

### 17.2 Publication failure

If storage succeeds but metadata creation fails, remove the orphaned stored object when safe, matching the cleanup discipline already used by thread artifacts.

If metadata is created, the snapshot is immutable.

### 17.3 Analysis failure after publication

A new successful snapshot should remain a successful snapshot even if a later SQL query or chart fails.

The bot can report:

```text
The catalog refresh completed and was saved, but the comparison could not be generated.
```

Do not delete valid collected data merely because presentation failed.

### 17.4 "No changes" is a successful outcome

Only say "no changes" after:

- collection succeeded;
- validation succeeded;
- snapshot publication succeeded;
- the comparison query completed successfully.

Never infer "no changes" from an empty or partial scrape.

---

## 18. Optional later UI: `dataset` message block

Backend semantics should be proven before adding substantial UI.

Markdown is sufficient for early analysis results, and `render_plot` already publishes a first-class chart block.

Once snapshots are reliable, add a compact first-class dataset result.

### 18.1 Contract

Extend the discriminated `MessageBlock` union in:

- [packages/contracts/src/events.ts](../packages/contracts/src/events.ts)

Possible shape:

```ts
z.object({
  kind: z.literal("dataset"),
  snapshotId: Id,
  name: z.string(),
  rowCount: z.number().int().nonnegative().nullable(),
  columns: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
    }),
  ),
  preview: z.array(z.record(z.string(), z.any())).max(20),
})
```

Do not embed the complete dataset in the thread message.

### 18.2 UI

Render beside the existing chart/message card components, primarily in:

- [apps/web/src/pages/shell/message-cards.tsx](../apps/web/src/pages/shell/message-cards.tsx)

Concept:

```text
Acme catalog
24 Sep 2026 · 1,842 rows

+17 added
-4 removed
36 price changes

[View data] [Download]

      average price by category
      -------------------------
              chart

Acme increased pricing most strongly in ...
```

The product should remain calm:

- no page-fetch counters;
- no selector logs;
- no raw SQL;
- no internal storage details;
- no persistent "scraper dashboard" unless later user evidence justifies one.

---

## 19. Download and history APIs

Once `DataSnapshot` exists, add product APIs only as needed by real UI.

Likely eventual contracts:

```text
datasets/listSnapshots
datasets/getSnapshot
datasets/downloadSnapshot
```

Inputs must be scoped by current actor and Space.

Do not expose raw `storageKey` values to clients.

"Latest" should mean latest **successful published** snapshot for `(spaceId, botId, jobKey)`.

A history UI can be added later without changing the collection architecture.

---

## 20. End-to-end architecture

```text
USER
"Monitor Acme's catalog every morning."
                    |
                    v
              Rakazo Bot
                    |
              reads @Datasets
                    |
                    v
     data/jobs/acme-catalog/JOB.md
     data/jobs/acme-catalog/collect.py
                    |
                    v
             test collection
                    |
                 validate
                    |
                    v
            dataset_publish
                    |
                    v
             DataSnapshot #1
                    |
                    v
              create Routine
                    |
             every morning
====================|================================
                    |
              routine.wakeup
                    |
                    v
              normal Run
           trigger = "routine"
                    |
                    v
            run collector
                    |
                    v
              staging file
                    |
                 validate
                    |
                    v
            dataset_publish
                    |
                    v
             DataSnapshot #2
                    |
                    v
 query_data(#2 AS current, #1 AS previous)
                    |
                    v
          structured differences
                    |
          +---------+---------+
          |                   |
          v                   v
    model analysis       render_plot
          |                   |
          +---------+---------+
                    |
                    v
               chat result
```

There is deliberately no:

- scraper scheduler;
- scraper workflow engine;
- site-specific adapter framework;
- product-catalog-only schema;
- selector DSL;
- full dataset injection into model context.

---

# 21. Verification strategy

Rakazo's existing [docs/agent-verification.md](agent-verification.md) separates deterministic execution regressions from real-model quality. Data jobs should follow the same philosophy.

Most acceptance behavior should be demonstrated against deterministic fixture sites and fixture datasets first.

The goal is not merely "can the bot scrape HTML?" The goal is to prove that the abstraction survives different acquisition methods, recurrence patterns, historical comparisons, authentication, source breakage, and mixed inputs.

## 21.1 Use case 1: competitor product catalog monitor

### User task

> Monitor this competitor's footwear catalog every morning. Track SKU, product
> name, category, price, discount, availability, and URL. Tell me about new or
> removed products and price moves above 10%.

### Fixture

Create a deterministic catalog site with approximately 300-1,000 products across multiple pages.

Fixture revision A:

- baseline catalog.

Fixture revision B:

- add products;
- remove products;
- change availability;
- change prices above and below the 10% threshold.

Fixture revision C:

- intentionally change the source markup or response shape so the existing collector fails or produces suspiciously incomplete output.

### What it validates

- recognizing a repeated data job;
- creating/reusing `JOB.md`;
- generated collector persistence;
- pagination;
- stable record identity;
- snapshot validation;
- immutable history;
- SQL-based diffing;
- concise routine result;
- optional charting;
- safe failure behavior.

### Required three-run sequence

```text
RUN 1
300 products
-> establish baseline snapshot

RUN 2
+12 products
-3 products
17 price changes
-> correct diff + analysis

RUN 3
source breaks collector
-> validation fails
-> snapshot from run 2 remains latest successful snapshot
-> bot reports collection problem
-> bot must NOT report "0 changes"
```

This is the canonical vertical slice and should be implemented first.

## 21.2 Use case 2: news/research intelligence monitor

### User task

> Every weekday morning, collect new articles mentioning Acme Robotics from these
> five sources. Deduplicate them, categorize them as product, company, funding,
> partnership, or regulation, and give me the important developments from the
> last 24 hours.

### Fixture

Static public article/feed pages that can be handled without graphical browsing.

Include:

- duplicate/syndicated articles;
- old articles that remain present;
- new articles across several categories.

### What it validates

- data-job generality beyond product catalogs;
- `web_fetch`/structured acquisition preference;
- URL or canonical-id based identity;
- historical deduplication;
- date filtering;
- query_data aggregation;
- not repeatedly reporting yesterday's records.

The bot should not use a graphical browser merely because a browser exists.

## 21.3 Use case 3: dynamic paginated/infinite-scroll marketplace

### User task

> Monitor all apartment listings matching these criteria twice a week. Track
> listing ID, address, bedrooms, price, square meters, and availability.

### Fixture

A deterministic JS-driven site where:

- useful data is not available from the first static fetch;
- interaction or page-browser tools are required;
- pagination or load-more behavior exists;
- records disappear between revisions;
- a later revision changes DOM structure while preserving the underlying information.

### What it validates

- investigation with `browser_navigate`, `browser_snapshot`, and `browser_act`;
- agent-generated reusable collection logic;
- collector reuse on later runs;
- self-repair when the source changes;
- validation before snapshot publication.

This test determines whether the design really avoids needing a universal selector DSL.

## 21.4 Use case 4: user CSV/API plus web enrichment

### User task

> Every Friday, take the latest sales export, enrich each product with the current
> competitor price, and tell me where we are more than 8% above the competitor.

### Fixture

- a deterministic CSV with thousands of SKUs;
- a fixture API or website containing competitor price data.

### What it validates

- acquisition is broader than scraping;
- joining user-owned structured data with newly collected data;
- DuckDB/query_data as the main analysis engine;
- large-data behavior without model-context dumping;
- category/brand aggregations;
- output limited to actionable differences.

This case should work without introducing a separate "CSV workflow" product concept.

## 21.5 Use case 5: authenticated supplier portal

### User task

> Every Monday, sign in to our supplier portal, download the current inventory
> catalog, compare it with last week, and tell me which products fell below 20
> units.

### Fixture

Use a local deterministic login flow, never real credentials.

Test:

1. first run requires user takeover/authentication;
2. browser profile persists;
3. second scheduled run reuses the session;
4. later fixture revision expires the session;
5. another revision returns a malformed/incomplete download.

### What it validates

- persistent browser identity;
- protected-input boundary;
- unattended routine reuse;
- session expiry handling;
- malformed-download validation;
- previous successful snapshot preservation.

The collector must never put the password into generated Python, `JOB.md`, shell environment, or dataset files.

---

## 22. Cross-cutting acceptance criteria

Apply these assertions to every scenario.

### Persistence

- Job implementation survives a new agent run.
- Collector code is reused or repaired rather than regenerated from scratch on every routine.
- Successful snapshots remain queryable after later runs.
- Snapshot history is immutable.

### Scheduling

- Recurrence uses the existing routine path.
- No scraping-specific schedule table or worker is introduced.
- A routine run remains a normal `Run(trigger = "routine")`.

### Correctness

- Only validated data is published.
- Failed/partial collection cannot become the latest successful snapshot.
- "No changes" is only emitted after a successful comparison.
- Stable keys drive row identity across snapshots.

### Model-context discipline

- Large datasets are not pasted into the LLM context.
- SQL reduces data before reasoning.
- Query results are bounded and structured.
- Charts use query output rather than hand-retyped rows.

### Security

- Snapshot IDs are authorization checked.
- SQL cannot access arbitrary server files or the network.
- Credentials never appear in collector files.
- Authenticated web work uses browser/takeover boundaries.
- Data jobs do not bypass normal external-effect approvals.

### UX

- Chat reports outcomes, not scraper internals.
- Healthy "no change" runs are brief.
- Failures identify useful next action without dumping logs.
- Charts appear only when they improve comprehension.

---

# 23. Deterministic test layers

Use the existing verification model rather than making every test a live-model browser test.

## 23.1 Unit/contract tests

Add tests for:

- `DataSnapshot` serialization/contracts;
- snapshot ownership/Space isolation;
- dataset format validation;
- hash calculation;
- failure cleanup when storage succeeds but DB metadata creation fails;
- latest-successful ordering;
- query result truncation;
- query timeout and size limits;
- denial of arbitrary paths/external access;
- action approval classification.

Likely locations:

```text
packages/adapters/src/data-snapshots.test.ts
packages/adapters/src/data-query.test.ts
packages/core/src/action-approval.test.ts
packages/contracts/... tests
```

## 23.2 Executor tests

Verify real built-in tool dispatch with scripted/model-emulator calls:

```text
dataset_publish
query_data
render_plot
```

The next model request should contain the actual bounded tool result, following the existing Pi verification discipline.

## 23.3 Product journey

Add a Postgres-backed journey covering:

1. create bot;
2. create first snapshot;
3. create second snapshot;
4. invoke `query_data`;
5. verify persisted metadata and result;
6. verify Space isolation.

## 23.4 Computer replay

Use a local fixture site to exercise actual browser/file/download behavior while keeping the model endpoint deterministic.

The product-catalog use case should eventually have a Docker replay covering the first two successful revisions.

## 23.5 Real-model quality

Only after deterministic behavior is stable, add a smaller real-model evaluation proving the model chooses the intended primitives from a natural request:

- creates/reuses a data job;
- does not dump a large dataset into context;
- queries before analyzing;
- handles a broken collection as failure rather than "no changes."

---

# 24. Proposed implementation phases

## Phase 0: document and stabilize the current prototype

Current fork state already includes:

- DuckDB CLI in the Docker computer;
- built-in `Datasets` skill.

Before adding product contracts:

- keep the existing functionality working;
- add deterministic coverage for the current skill/DuckDB image if missing;
- use the catalog fixture to understand what the agent currently does.

Success means the baseline is known, not that the final architecture is complete.

## Phase 1: canonical snapshots

Implement:

- `DataSnapshot` Prisma model + migration;
- dataset byte storage using the smallest justified storage abstraction;
- `dataset_publish`;
- snapshot listing helpers;
- immutable publication/failure cleanup;
- ownership tests.

Update the `Datasets` skill to use staging + publish semantics.

No new dataset UI yet.

## Phase 2: bounded analytics

Implement:

- `query_data`;
- worker-side DuckDB integration;
- snapshot materialization;
- read-only/external-access restrictions;
- time/memory/row/byte limits;
- structured output;
- unattended-safe classification;
- deterministic query tests.

Update the `Datasets` skill so historical comparisons use `query_data`.

## Phase 3: canonical product-catalog vertical slice

Build use case 1 end-to-end:

- fixture revisions A/B/C;
- collector creation/reuse;
- routine;
- snapshots;
- comparison;
- chart;
- broken-source validation failure.

Do not broaden the backend abstraction until this vertical slice is reliable.

## Phase 4: generality tests

Add use cases 2-4:

- news monitor;
- dynamic marketplace;
- CSV/API + web enrichment.

If these require product-level changes, prefer the smallest general primitive that explains all cases.

Do not introduce source-specific schema merely because one fixture is awkward.

## Phase 5: authenticated source

Add use case 5 and verify:

- login takeover;
- persisted browser identity;
- session expiration;
- malformed download;
- no secret leakage.

## Phase 6: dataset presentation

Only after the backend contract is stable:

- optional `dataset` message block;
- compact preview;
- download;
- history/navigation where useful;
- web and mobile surfaces according to shared contracts.

Do not build a large dataset dashboard before evidence shows users need one.

---

# 25. File-by-file implementation map

This is the expected initial change surface, not a requirement to modify every file at once.

| Area | File(s) | Change |
| --- | --- | --- |
| Product guidance | `packages/adapters/src/builtin-skills.ts` | Evolve `Datasets` into data-job workflow |
| Tool contracts | `packages/adapters/src/builtin-tools.ts` | Add `dataset_publish`, `query_data` |
| Executor wiring | `packages/adapters/src/executor.ts` | Dispatch new tools through focused helpers |
| Snapshot logic | `packages/adapters/src/data-snapshots.ts` | New publication/lookup helpers |
| Query logic | `packages/adapters/src/data-query.ts` | New bounded DuckDB query helper |
| Persistence | `packages/db/prisma/schema.prisma` + migration | Add `DataSnapshot` |
| Storage boundary | `packages/adapter-kit/src/interfaces.ts` only if justified | Reuse ArtifactStore first; add DatasetStore only if real requirements demand it |
| Local storage | `packages/adapters/src/artifacts.ts` or new dataset store | Store snapshot bytes |
| Approvals | `packages/core/src/action-approval.ts` | Mark `query_data` unattended-safe; classify publication |
| Tool activity | `packages/adapters/src/pi-runtime.ts` | Calm activity labels |
| Contracts/UI later | `packages/contracts/src/events.ts` | Optional `dataset` block |
| Web UI later | `apps/web/src/pages/shell/message-cards.tsx` | Optional dataset card/preview |
| Tests | adapters/core/testkit | Deterministic snapshot/query/executor/journey coverage |
| Computer fixture tests | testkit / computer replay fixtures | Catalog, dynamic site, authenticated portal cases |
| Docs | this file + agent verification if behavior becomes permanent | Keep verification commands/contracts current |

---

# 26. Decisions to preserve during implementation

These are architectural guardrails.

1. **Data job, not scraper, is the abstraction.**
2. **Routines remain the only recurring schedule model.**
3. **The agent chooses acquisition strategy.**
4. **Collector code lives in the bot's durable workspace.**
5. **Canonical successful history is immutable.**
6. **Validation happens before publication.**
7. **Postgres stores dataset metadata, not every scraped row.**
8. **DuckDB is an analytics engine, not the model context.**
9. **Snapshot IDs, not arbitrary host paths, are the query API.**
10. **Query execution is read-only and resource bounded.**
11. **Protected credentials never enter arbitrary collector code.**
12. **A failed scrape is not equivalent to zero changes.**
13. **The chat stays calm: results, charts, and requests for help, not internal logs.**
14. **Do not add a first-class `DataJob` database model until concrete UI/product requirements require it.**
15. **Do not add `DatasetStore` merely for symmetry if the existing storage interface can safely support the initial requirements.**

---

# 27. Alternatives considered

## Universal `scrape_url` tool

Rejected for the initial architecture.

It overlaps with existing web/browser/shell primitives and cannot express authenticated, JS-heavy, downloaded-file, mixed-source, or agent-repaired workflows without growing into another browser framework.

## Site-specific scraper adapters

Rejected as the core model.

Useful specialized connectors can still exist later, but a site-adapter hierarchy would make the feature less general and create permanent maintenance for source-specific behavior.

## Visual scraping workflow editor

Rejected.

It conflicts with Rakazo's current product direction that routines remain prompts and advanced execution stays beneath a calm interface.

## One mutable DuckDB file as the canonical dataset

Useful prototype; not preferred as the final durable boundary.

Immutable snapshots make validation, recovery, historical identity, portability, and failed-refresh semantics clearer.

## Store all records in Postgres

Rejected for the initial feature.

It turns Rakazo's application database into a warehouse and creates row-scale retention/schema complexity unrelated to the core product.

## Let the model read the entire dataset

Rejected.

Large dataset reasoning should be performed through bounded SQL queries. The model receives only the relevant rows/aggregates required to answer the user's question.

---

# 28. Definition of done for the first production-quality slice

The first slice is complete when the deterministic competitor-catalog scenario can demonstrate all of the following:

1. A user can ask naturally for recurring catalog monitoring.
2. The bot creates a persistent reusable data-job implementation.
3. The first valid collection becomes an immutable baseline snapshot.
4. A normal Rakazo routine triggers the next run.
5. The existing collector is reused.
6. The second valid collection becomes a second immutable snapshot.
7. `query_data` correctly detects additions, removals, and price changes.
8. The model receives bounded query results rather than both full catalogs.
9. `render_plot` can visualize an appropriate aggregation.
10. The chat presents a concise analysis.
11. A third source revision breaks/incompletes the collector.
12. Validation prevents publication.
13. The second snapshot remains the latest successful snapshot.
14. The bot reports a collection problem rather than "no changes."
15. No credential, arbitrary server path, or unrestricted SQL access is exposed.
16. All core behavior has deterministic offline coverage consistent with [docs/agent-verification.md](agent-verification.md).

Once this succeeds, the news, dynamic marketplace, mixed CSV/API, and authenticated portal scenarios decide whether the abstraction is genuinely general. If those scenarios pass without introducing source-specific product concepts, the data-job design has achieved its main goal.
