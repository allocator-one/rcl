# Telemetry and evidence

RCL can record every review on [Harness](https://harness.infra.one) as
evidence: the self-describing run header, findings, reviewer calls and the
report files. Harness computes a gate status for each pull request from that
evidence. This document covers delivery (`rcl telemetry`), the reads
(`rcl evidence`), attested gate reviews (`--attest`), and the supported
recovery operations for evidence that did not land. For the short version, see
the [README](https://github.com/allocator-one/rcl#harness-evidence-and-gate).

## Contents

- [Delivery](#delivery)
- [Verifier notes and redaction](#verifier-notes-and-redaction)
- [`rcl telemetry status`, `flush` and `rejected`](#rcl-telemetry-status-flush-and-rejected)
- [`rcl telemetry recover-reviewer`](#rcl-telemetry-recover-reviewer)
- [`--attest`: attested reviews from the gate workflow](#--attest-attested-reviews-from-the-gate-workflow)
- [`rcl evidence status` and `rcl evidence show`](#rcl-evidence-status-and-rcl-evidence-show)
- [`rcl evidence recover-run`](#rcl-evidence-recover-run)
- [`rcl evidence recover-claim`](#rcl-evidence-recover-claim)
- [`rcl evidence recover-finding`](#rcl-evidence-recover-finding)
- [`rcl evidence retriage-finding`](#rcl-evidence-retriage-finding)
- [`rcl telemetry backfill`](#rcl-telemetry-backfill)
- [`rcl telemetry recover-refutations`](#rcl-telemetry-recover-refutations)

## Delivery

In a repository that carries `.harness-cli/config.json` and with a
`harness login` (or `HARNESS_API_TOKEN` + `HARNESS_API_URL` in CI), every
`rcl review` / `rcl review-plan` records the run on Harness after the report is
written: the self-describing `run` header, one row per consensus finding (with
its stable identity), one row per reviewer call (status, latency, token usage),
the report's `stats`, and — at the default `full` level — the JSON and Markdown
reports exactly as written, digest-checked by the server. The converge commands
report their events (attempt claims, cap changes, processed rounds, verdicts,
resolutions) the same way. Never sent: provider API keys, `GITHUB_TOKEN`, the
Harness credential, environment variables or prompts. Every free-text field is
truncated and scrubbed for key-shaped strings before it leaves the process.
With delivery enabled, `--json-file` and `--markdown` are written from that
same scrubbed view, so the uploaded reports match the local files byte for
byte. Raw model answers are not sent either: a parse-failed call is reduced to
the parser message unless `harness.parseFailures: true` opts in to sending its
answer with fenced code and key-shaped strings removed, capped at 32 KB.
Scrubbing is pattern-based; it cannot recognize every secret.

The stored login is the file `harness login` writes:
`~/.config/harness/credentials.json`, or
`$XDG_CONFIG_HOME/harness/credentials.json` when `XDG_CONFIG_HOME` is set to an
absolute path. An environment token is used only together with
`HARNESS_API_URL`; half a pair is a configuration error, never a fallback to
the stored login.

The review never blocks on the network. A retryable delivery outage is spooled
to `~/.rcl/outbox/<run id>/` (under `RCL_DATA_DIR` when set) and retried, with
its original run id, by `rcl telemetry flush` or at the start of the next
ordinary work command — `rcl review`, `review-plan`, `discuss`, `models`,
`roles`, `converge-attempt`, `converge-report` or `converge-verdict` — bounded
to five seconds. Evidence reads (`rcl evidence status` / `show`), the recovery
and audit commands (`converge-stale`, `converge-gap`, `converge-rejected`,
`evidence recover-run`, `recover-claim`, `recover-finding`,
`retriage-finding`), the
`telemetry` commands other than `flush`, fresh-cycle reviews, pending-launch
export and finalize-only operations, and runs with telemetry off never flush
unrelated evidence.

One dim status line says what happened: `Evidence recorded: <url>`,
`Evidence spooled (Harness unreachable); run rcl telemetry flush`, or
`Evidence not sent: <host> has not enabled review evidence for this
organization`. `--evidence-required` exits 4 when the evidence is
incomplete: the envelope was spooled or refused, the organization has evidence
off, or a declared artifact did not land. It is refused up front, before any
reviewer is paid (exit 1), for a patch file without `--head-sha`, together with
`--no-telemetry`, `RCL_TELEMETRY=off` or `harness.telemetry: off`, outside a
Harness-managed repository, and without a Harness credential. Only a
spooled delivery is worth `rcl telemetry flush --run <id>`; the status line
says which. Under `--ci` the gate verdict keeps its exit code and the evidence
failure is printed beside it. The first delivery from a machine prints a
one-time notice naming the host and what is sent (`~/.rcl/telemetry-notice`
records it).

Completed envelopes are validated locally before transmission. Two valid
reversed line numbers are ordered before finding identity is allocated, with
the original numeric pair retained as parser provenance. Missing, blank,
boolean, negative, fractional or non-finite coordinates remain parser errors;
valid sibling findings are preserved. Provenance delivery requires the server
to advertise evidence protocol version 2.

Local validation failures and terminal server refusals retain the exact JSON
and Markdown bytes in `~/.rcl/quarantine/<run id>/` (or under `RCL_DATA_DIR`).
The immutable manifest records original digests, delivery mode and diagnostics;
distinct later delivery observations are appended separately. Interrupted or
corrupted entries are reported as incomplete. Retention failure, including a
read-only filesystem or the 1 GiB storage cap, is reported explicitly. Retained
evidence is not server acknowledgment. Attested evidence is never queued for
replay with ordinary credentials. A locally invalid report from a convergence
loop has its own recovery path, `rcl converge-rejected` (see
[Convergence and recovery](https://github.com/allocator-one/rcl/blob/main/docs/convergence.md#rcl-converge-rejected)).

Opt out per run with `--no-telemetry`, per machine with `RCL_TELEMETRY=off`, or
per project in the config:

```yaml
# .review-council.yml
harness:
  telemetry: full        # off | envelope | findings | full (default)
  parseFailures: false   # send a parse-failed call's raw answer (scrubbed, 32 KB cap)
```

`envelope` sends the run header and stats, `findings` adds findings and calls,
and `full` also uploads the JSON and Markdown reports.

## Verifier notes and redaction

Structured findings include the recorded verifier model and explanation, when
present, at both `findings` and `full` telemetry levels. The JSON report and
the wire envelope share one normalization: blank values are absent, model
identifiers are capped at 500 Unicode code points and explanations at 2,000.
Missing legacy explanations are never generated. Unicode normalization forms
and gate outcomes are unchanged.

Quoted credential assignments are redacted through their closing quote or the
end of input, including multiline and unfinished values. Preliminary text
truncation keeps only text through the last whitespace in its bounded prefix
(or only an ellipsis if there is none), so a partial secret cannot survive
redaction. The shared fixture `test/fixtures/verification-normalization.json`
pins the receiver contract. Existing source reports are not rewritten to add
explanations; legacy backfill retains its declared artifact scrubbing and
deterministic source identity rules.

## `rcl telemetry status`, `flush` and `rejected`

```bash
rcl telemetry status                # level, credential source, what waits in the outbox
rcl telemetry flush                 # deliver everything spooled, to completion
rcl telemetry flush --run <run id>  # one run only
rcl telemetry flush --run <run id> --envelope-timeout-ms 120000
rcl telemetry rejected --run <run id> --json  # inspect one retained original
rcl review owner/repo#7 --no-telemetry   # keep this review on the machine
```

`rcl telemetry rejected` inspects the quarantine files and verifies their
digests without contacting Harness, flushing the outbox, changing native review
accounting or applying recovery. Recovery of an already-completed historical
run remains a separate operation.

If an envelope is slow to acknowledge, use `telemetry flush
--envelope-timeout-ms` with an integer from 1 to 120000 milliseconds. It
changes only the envelope POST timeout (default: 10000 ms); artifact transfers
keep their 120000 ms ceiling, and ordinary reads and events keep their existing
timeouts. Shorter caller deadlines and known attested credential lifetimes
still apply. A timeout leaves the evidence queued for a later flush; this
option does not rerun reviewers.

## `rcl telemetry recover-reviewer`

```bash
rcl telemetry recover-reviewer --preview --manifest <path> --target <convergence-target> --run <run-uuid> [--json]
rcl telemetry recover-reviewer --apply --manifest <path> --manifest-sha256 <sha256> [--json]
rcl telemetry recover-reviewer --resume --manifest <path> --manifest-sha256 <sha256> [--json]
rcl telemetry recover-reviewer --target <convergence-target> --run <run-uuid> [--json]
```

Reopens one exact retained terminal reviewer report of a guarded convergence
target — the report and its private reviewer artifact, retained under the
repository's common Git directory — authenticates the pair locally, and retries
only its Harness delivery, with evidence required. It never restarts reviewers
or verification. When the exact run also has a retained private reviewer
outbox, preview binds its original manifest, exact envelope, JSON and Markdown
reports, private artifact, complete terminal lineage, and authenticated Harness
principal into an immutable operation manifest. Apply and resume accept only
that manifest's exact digest and revalidate every binding. A durable journal
records activation intent before the sole permitted run POST; an uncertain
POST is never repeated. Completion requires exact ordinary and private
readback, followed by a separate immutable recovery acknowledgement. Generic
`telemetry flush` deliberately keeps refusing an unknown run.
The published mode-less target/run form remains available for an authenticated
terminal report that has no retained private outbox. It preserves the original
delivery result, JSON fields and exit code. If a private outbox exists, even if
its files are malformed, mode-less delivery fails before transport and directs
the operator to preview/apply/resume so it cannot bypass activation journaling.
A verified-consensus report without finding labels is
delivered only when its authenticated reviewer artifact proves the sealed
failed-verification strict fallback with a conservative nonzero CI result;
generic, altered and completed-verification reports fail closed before
transport. Preview makes no server changes and writes only its requested local
manifest. Apply creates the operation journal, while
resume requires that same journal. Successful preparation or completion exits
0; a pair that cannot be reopened or authenticated exits 4.

## `--attest`: attested reviews from the gate workflow

Only evidence recorded from the organization's own gate workflow on GitHub
Actions counts for the enforced gate. Inside such a job — one that grants
`id-token: write` — `rcl review owner/repo#N --attest` asks the runner for the
job's OIDC token with the Harness origin as audience, exchanges it at
`POST /api/v1/reviews/attest` for a **run-bound credential** (`rbc_…`, thirty
minutes, one rcl run id, valid while the Actions run is in progress), and
records the review under it: the envelope, its artifacts, the model keys and
the model stats all travel with that credential and nothing else. Harness
verifies the token, requires the workflow file to be on the organization's gate
allow-list at its default branch, re-reads the pull request through its GitHub
App and stores the run only if the reviewed head is the pull request's current
head and the PR is not from a fork — the run is then `credential_kind:
attested`.

`--attest` fails loudly, before any token is requested or any reviewer is paid:
outside Actions (no `ACTIONS_ID_TOKEN_REQUEST_URL` / `_TOKEN`), without
`HARNESS_API_URL`, off a pull request target, with a telemetry level other than
`full` (from `RCL_TELEMETRY` or the project config — an attested run carries
its full report), or when Harness refuses the exchange (the refusal names the
reason: `workflow_not_allowed`, `reviews_disabled`, `run_not_in_progress`, …).
It never falls back to `HARNESS_API_TOKEN` or the stored login, it implies
`--evidence-required`, and nothing recorded under the run-bound credential is
ever spooled — the credential does not outlive the workflow run. A review that
outlasts most of the credential's thirty minutes mints it again for the same
run id before delivery. Pair it with `--expect-head-sha` so a moved pull
request fails fast instead of being refused at ingest.

If the completed envelope's POST becomes unavailable, delivery first reads a
restricted receipt for that same run with its still-live attested credential. A
matching receipt resumes artifact delivery without another POST; only an
explicit 404 permits replay of the exact serialized envelope. Recovery allows
at most three POSTs including the original, with an additional 20-second
recovery deadline bounded by credential expiry. Conflicts, rejected or
unanswered receipts, expiry and exhausted retries stop recovery. No reviewer is
called again and no ordinary credential is substituted. Failed delivery retains
bounded, redacted transport diagnostics, including the initial error cause,
with the original recovery evidence.

The workflow contract and an abridged example are in the
[README](https://github.com/allocator-one/rcl#the-gate-workflow); this
repository's own gate is
[`.github/workflows/review_gate.yml`](https://github.com/allocator-one/rcl/blob/main/.github/workflows/review_gate.yml).
Operators recovering the gate's encrypted GitHub artifact must use the
[review evidence recovery runbook](https://github.com/allocator-one/rcl/blob/main/docs/review-evidence-recovery.md).
Recovery requires the separately held, version-mapped private key and does not
confer review or merge approval.

## `rcl evidence status` and `rcl evidence show`

What Harness holds — never the client's own claim. `rcl evidence status` prints
the gate status Harness computed for a pull request: its known head, the
advisory and enforced projections (status, the rounds behind them, the
actionable findings still open) and the merge decision once it merged. The exit
code is the contract the skills gate on:

| Exit | Meaning |
| --- | --- |
| 0 | The judged projection (advisory by default, `--enforced` on request) is `converged` |
| 1 | Any other status: `none`, `stale`, `unverified`, `inconclusive`, `fixes_pending`, `unresolved` |
| 2 | The pull request could not be named |
| 3 | The read could not be answered: no credential, evidence off for the organization, unknown pull request, refused credential, unreachable host — never reported as "not converged" |

`rcl evidence show <run id>` prints one recorded run: header and verification,
credential tier and runner, reviewer health, artifact state, and every finding
with its identity and gating reason. Each **Verification** block shows the
recorded result, actual model and complete stored explanation. Recovered notes
identify the original report digest and recovery time. Legacy results without a
note say `Explanation not recorded`; `unavailable` remains distinct from
`refuted`. A separate **Triage** block shows the recorded judgment, reason,
actor, round and recording time when available. Missing attribution stays
unknown, and a displayed judgment does not assert current gate resolution.

Text preserves multiline explanations while scrubbing credential-shaped text
and terminal controls. `--json` preserves the API object's semantic values with
safe control-character escaping. Older servers may omit the optional evidence
and attribution fields. Local Markdown reports also show verifier explanations
for kept findings and the rendered below-threshold appendix; the appendix still
shows at most 20 findings and points to JSON for omitted entries.

The reads use the same credential rules as delivery — the stored
`harness login`, or `HARNESS_API_TOKEN` + `HARNESS_API_URL` in CI, the token
sent to its own host only — and need `reviews:read`. They do not depend on the
telemetry level: switching delivery off does not blind them. Both commands send
only their normal GET requests. They neither fetch an artifact per finding nor
flush pending retry deliveries, run reviewers or record verdicts. Use
`rcl telemetry flush` explicitly to retry queued delivery.

```bash
rcl evidence status                   # error: name the pull request
rcl evidence status 42                # against the current checkout's origin remote
rcl evidence status '#42' --enforced
rcl evidence status owner/repo#42 --json
rcl evidence status https://github.com/owner/repo/pull/42
rcl evidence show 01a08032-0838-76db-ade3-1990f6e54072
```

## `rcl evidence recover-run`

Recover one original completed asserted run without rerunning review, changing
its UUID or rewriting its JSON/Markdown artifacts. This is delivery only: it
does not admit a native round, record verdicts, change attempts/precision,
flush unrelated outbox entries or confer gate approval. Semantic claim splits
are not part of this command.

First prepare an exclusive manifest using explicit original source pins:

```sh
rcl evidence recover-run --preview --manifest original-run.json \
  --run "$ORIGINAL_RUN_ID" --for-pr owner/repo#123 --head "$ORIGINAL_HEAD_SHA" \
  --report-json /absolute/original/report.json --report-sha256 "$JSON_SHA256" \
  --report-md /absolute/original/report.md --markdown-sha256 "$MARKDOWN_SHA256" \
  --original-mode asserted --json
```

Markdown is optional; its path and digest must be supplied together. The
report must retain its complete modern header, explicit finding identities, and
an exact PR or PR-bound patch target. Original run UUID bytes are preserved;
only generated operation IDs are canonical lowercase. Recovery refuses other
spellings instead of rewriting identity. Headerless imports,
CI/attested/backfill originals, unknown mode fields, missing sources and
ambiguous bindings refuse. The explicit asserted mode is an **operator
assertion**, checked against the retained non-CI runner metadata; it is not
cryptographic proof of the original invocation. A run-bound credential is never
converted to a normal login.

Preview validates all local inputs before HTTP and writes only the explicitly
named manifest. Its formatted UTF-8 representation, including the final
newline, must fit within 8 MiB so apply and resume can read it. Oversized
prepared evidence refuses before HTTP; the complete manifest is checked again
before publication. It makes scoped authenticated GET requests, requires
`meta.original_report_recovery_version: 1` and evidence protocol 2, and binds
the host and server organization. An older or disabled server remains
unsupported. Inspect the manifest's exact envelope, source digests,
transformations and retained content limitations, then use the digest printed
by preview:

```sh
rcl evidence recover-run --apply --manifest original-run.json \
  --manifest-sha256 "$MANIFEST_SHA256" --json

# After interruption or an uncertain acknowledgment, reuse that same operation.
rcl evidence recover-run --resume --manifest original-run.json \
  --manifest-sha256 "$MANIFEST_SHA256" --json
```

Apply starts an adjacent `original-run.json.journal` directory with
append-only, fsynced checkpoints before every remote write. Each checkpoint has
an 8 MiB + 1 KiB read/write bound, retaining the manifest's full prose audit and
reserving space for the checkpoint wrapper. Oversized checkpoints refuse before
publication. Apply and resume require the journal to be effective-user-owned
mode 0700, on the supported local storage listed below, with protected
ancestors and no harmful or unknown ACL grants. Apply checks the selected
parent before creating the journal exclusively; resume never creates missing
state or repairs permissions. Each append checks the selected journal's
device/inode identity before writing. This detects replacement between
checkpoints; it does not claim protection against concurrent privileged or
same-user path manipulation. Resume requires that directory; it never generates
a replacement operation. A dedicated `RCL_DATA_DIR/original-run-recovery-locks`
directory serializes applies for the same host/organization/run, including
different manifest paths. Native accounting locks and stores are not used.
Locks with incomplete or unverifiable ownership fail closed and require
inspection; never delete a live lock.

The lock uses a unique registration per acquisition and automatically removes a
dead participant only when its PID is absent in the same kernel boot and PID
namespace. A reboot, foreign scope, PID reuse or uncertain liveness requires
inspection or a bounded retry; age alone never permits deletion. Legacy private
`.lock`/`.reclaim` state is refused, not migrated or bypassed. Empty `.bakery`
registries remain in place, and an interrupted unpublished `.tmp` is harmless.
Concurrent older private recovery clients are unsupported.

This protocol requires coherent ordinary local storage: local APFS/HFS with
ownership enabled on macOS, or ext2/3/4, tmpfs, XFS or Btrfs on Linux. Network,
FUSE, overlay and unknown filesystems are unsupported. macOS refuses an
ambiguous system mount listing, including an ambiguous entry for an unrelated
mount. It uses the existing directory's filesystem name and mountpoint from
bounded `df --libxo json` output, matched to one exact mount-table entry;
firmlink or case aliases never select an ancestor's flags. Unavailable
structured inspection or unmatched/ambiguous attribution refuses without a
fallback. It rejects ACL allow grants or unrecognized ACL output; restrictive
deny-only ACLs are allowed. The root must already be private
(effective-user-owned mode 0700), and ancestors must be protected against other
users' writes, apart from root-owned sticky temporary directories. Missing
private directories are created; existing permissions are never silently
repaired. These checks do not certify arbitrary filesystem implementations or
protect against hostile code running as the same user or a privileged
administrator.

Every invocation rechecks source bytes and the reviewed manifest. Before
retrying, it reads and compares all immutable run
header/settings/findings/calls/artifact declarations, then fetches exact raw
artifact bytes and verifies their digest and size. A POST duplicate receipt or
a stored-artifact flag alone is insufficient. Lost POST/PUT acknowledgment can
finish through exact reads; otherwise the same journal remains incomplete.
Changed bytes, organization, header, findings or calls refuse. A torn last
checkpoint is retained and bound into the next append; it is never treated as
acknowledgment. Preserve the manifest, journal and sources until independent
reconciliation is complete.

Only unpaired UTF-16 units in actual finding `title`, `description` or
`suggestedFix` prose receive a derived wire spelling: visible ASCII `\uD800`,
using uppercase hex. Valid surrogate pairs and existing literal backslash-u
text remain unchanged. Each transformation records the original JSON path,
code-unit index and byte offset. Keys, identifiers, descriptors and structural
fields cannot receive that transformation. Existing producer `[redacted]`
literals in finding prose stay unchanged and are listed as retained-content
limitations; markers in protected bindings, or any newly required secret
redaction, refuse. Markdown requiring redaction is unsupported. No fresh-report
normalizer or backfill UUID is applied to the original.

An original that contains an escaped C0 control or literal DEL in that same
finding prose is unsupported by default. When the retained report must be
represented, select the explicit, versioned mode during preview:

```sh
rcl evidence recover-run --preview --manifest original-run.json \
  --run "$ORIGINAL_RUN_ID" --for-pr owner/repo#123 --head "$ORIGINAL_HEAD_SHA" \
  --report-json /absolute/original/report.json --report-sha256 "$JSON_SHA256" \
  --original-mode asserted --original-prose control-code-units-v1 --json
```

This selection never rewrites the retained artifact or its digest. It projects
only allowed finding-prose controls to visible uppercase `\uXXXX` transport
text and records a version-1 `control_code_unit` transformation with the source
path, code-unit offset and original UTF-8 byte offset. Short JSON escapes
(`\b`, `\f`), `\uXXXX` escapes and literal DEL are covered. Literal tab, LF and
CR are valid JSON prose and remain literal; they are not transformed. Raw
unescaped C0 is invalid JSON; controls in keys, descriptors, identifiers,
locations or other structural fields refuse. Existing surrogate records keep
their prior shape.

The mode is intentionally unavailable against older servers. Preview requires
the usual recovery/evidence metadata **and**
`meta.original_prose_representation_version: 1`; without it, it makes the
scoped capability GET but writes no manifest and sends no delivery request.
Apply and resume use the selected, manifest-pinned representation and repeat
that check. Inspect the visible projection and transformation records before
applying. A successful delivery still does not repair native accounting or
establish a fresh review gate.

Existing transport scrubbing, limits, call summaries and duration rounding
remain explicitly recorded derivations. Two valid reversed integer coordinates
may use `report_projection` provenance bound to the original coordinates and
JSON digest; original finding identities are never recomputed from the
normalized interval. Unsupported coordinate types refuse rather than being
guessed.

Exit codes: `0` means preview prepared or delivery independently verified; `2`
means invalid/unavailable local selection; `3` means remote
capability/read/delivery unanswered; `4` means conflicting destination,
evidence or journal bindings; `5` means local durable journal/lock persistence
failed. JSON diagnostics include the stage and next step. Even successful
delivery does not establish current-head review freshness, convergence,
attestation or historical accounting repair.

## `rcl evidence recover-claim`

Recover one explicitly selected semantic claim on its existing native convergence
target. This requires ordinary authenticated review access and a backend that
advertises the complete `claim_recovery_version: 1` contract. Run/artifact
delivery through `recover-run` does not enable claim recovery by itself.

Run the command from the original repository. Create a private operation directory
(mode 0700) on the [supported local storage](#rcl-evidence-recover-run), then prepare
a selection using the exact original report and authenticated source evidence:

```json
{
  "version": 1,
  "action": "split",
  "source": {
    "scope": {
      "base_url": "https://harness.infra.one",
      "org_id": "<organization UUID>",
      "run_id": "<original run UUID>",
      "repo": "owner/repository",
      "pr_number": 123
    },
    "target": "existing-native-target",
    "round": 2,
    "headSha": "<original Git head>",
    "reportSha256": "<original report SHA-256>"
  },
  "findingRef": "f026",
  "previousIdentity": "<original 16 lowercase hexadecimal digits>",
  "identity": "<unused 16 lowercase hexadecimal digits>",
  "descriptor": {
    "version": 1,
    "operation": "src/cache.ts :: read",
    "invariant": "Expired entries must not be returned.",
    "evidence": ["The selected original branch returns an expired entry."]
  },
  "reason": "Separate this original claim from the shared historical key."
}
```

`findingRef` is positional across kept findings followed by the appendix; use the
API's ref, not a reviewer's embedded ID or a location suffix. The destination
identity must be unused. The descriptor is an explicit correction anchor, never
an original producer sighting. This selection leaves the new claim untriaged.

```sh
rcl evidence recover-claim --preview --selection selection.json \
  --manifest "$RECOVERY_DIR/claim.json" --json

# Inspect the source, affected later reviews and remaining unresolved findings.
# Set MANIFEST_SHA256 to the exact digest returned by this preview.
rcl evidence recover-claim --apply --manifest "$RECOVERY_DIR/claim.json" \
  --manifest-sha256 "$MANIFEST_SHA256" --json

# After interruption or an uncertain acknowledgement, reuse the same operation.
rcl evidence recover-claim --resume --manifest "$RECOVERY_DIR/claim.json" \
  --manifest-sha256 "$MANIFEST_SHA256" --json
```

Preview makes authenticated reads and creates exclusive preparation files. Apply
journals exact event IDs, timestamps and payloads before posting. Resume verifies
accepted receipts instead of posting them again. Preserve the manifest and all
adjacent material, `.proofs`, packets, native plan and journal; every load checks
their retained bytes. A nonzero apply can follow accepted remote events, so keep
the original operation and inspect its diagnostics before resuming. Changes to
the actor, original source, native snapshot or unplanned server history refuse.

If unrelated target history advances after an interrupted split, explicitly
preview adoption of that operation without changing its selection:

```sh
rcl evidence recover-claim --preview \
  --adopt-manifest "$RECOVERY_DIR/claim.json" \
  --adopt-manifest-sha256 "$MANIFEST_SHA256" \
  --manifest "$RECOVERY_DIR/adopted.json" --json
# Inspect the new preview, then apply adopted.json with its own printed digest.
```

Adoption retains accepted event IDs, timestamps, payloads and attribution. Only a
stage proven absent through complete authenticated reads receives a replacement
ID linked to its predecessor. A late old receipt blocks that replacement; inspect
it and re-preview the original operation. Retain every prior manifest and its
referenced files. Adoption does not waive source, native-state or server checks.

Optional `disposition` has `mode: "fresh"`, `verdict: "fixed"` or `"dismissed"`,
the claim's actual `severity`, and a source-backed `reason`. `mode: "preserved"`
also requires `originalVerdictEventId` and matching original, stored and classified
descriptors for every affected member of the old shared key, including original
actor, reason, severity and outcome. Ambiguous or descriptorless old verdicts
need fresh triage. A fixed claim stays pending until an eligible conclusive higher
round started after the server received that assertion. Other members of the old
key and unverifiable historical obligations remain unresolved.

For an existing exact correction anchor, `action: "disposition"` requires a new
explicit disposition; `action: "refresh"` forbids one. Refresh reads the complete
pinned claim history and receipts, posts no event, and updates the local snapshot.
Newly arrived source evidence can reopen unresolved obligations. The snapshot's
read window is not current server approval; the enforced gate independently
recomputes current obligations.

Recovery preserves original reports, findings, rounds, review cycles and spent
attempts. It calls no reviewers and does not flush unrelated evidence. JSON and
artifact reads and writes share a limit of 240 requests per rolling minute; large
histories wait without dropping proof checks. Valid HTTP 429 `Retry-After` values
allow at most three waits of up to 60 seconds per operation. Sustained contention
refuses safely; a write is never blindly retried after an uncertain result.

Recovered targets use native version 3 with recovery metadata version 2; older
readers refuse unsupported formats. Keep the original target and complete
retained material. Continue on that target by claiming the next durable attempt with
`converge-attempt`, then pass the returned ordinal to `review --guarded-converge`
with `--converge-target` and `--attempt`. The guarded producer consumes exactly
that authenticated claim without incrementing the budget again. Admit with
`converge-report --target` using the same target. Before dispatch, RCL
pins the verified predecessor in `run.converge.recovery_source`, preserves
`run.cycle_id`, and declares bound classification before serializing the
report. Admission verifies these bindings under target ownership; a changed
predecessor or mismatched cycle refuses while retaining the completed report.
Use `--start-over` only for an explicitly requested new review, not recovery.

Exit codes: `0` means prepared or acknowledged, `2` means invalid local input,
`3` means ordinary authentication is unavailable, and `4`/`5` indicate remote,
proof or durable checkpoint refusal. Successful recovery supplies no review,
attestation or merge approval. Fresh conclusive native review, the matching
enforced gate and required CI still govern delivery.

## `rcl evidence recover-finding`

Recover one recorded finding whose report identity collided, using its retained
native convergence identity. Preview is the default; `--submit` explicitly
posts one attributed `finding_identity_corrected` event. This unpaid command
never calls reviewers, claims an attempt, changes a round or verdict, updates
precision accounting, flushes/spools an outbox, or rewrites native history.

```bash
rcl evidence recover-finding --target "$TARGET" --run "$RUN_ID" \
  --report-sha256 "$ORIGINAL_REPORT_SHA256" --finding-ref f002 \
  --identity "$NATIVE_IDENTITY" --for-pr example/project#42
# Inspect the preview, then repeat with --submit if authorized.
```

Run it in the checkout holding the retained `.git/rcl-converge-runs` state. All
selectors are mandatory. The command reads the server run and checks its ID,
original report digest, repository/PR, convergence target and round. The
explicit native identity must match the selected ref's exact file, category and
line span. Its latest sighting, verdict and native round-to-run binding must
belong to that same recorded round. Missing or ambiguous evidence is an error,
never a reason to reconstruct state, reset counters or rerun review.

The event includes the digest of the exact retained state bytes and the minimal
native identity/verdict assertion, not private verdict reasons. Harness must
already hold the corresponding canonical verdict on that same run and round;
the command does not create one. Harness validates the bindings, but trusts the
authenticated actor's native mapping assertion. Neither the command nor the
server claims to have retrieved or verified the original report bytes. Normal
transport scrubbing applies; if redaction or truncation would change an exact
binding, both preview and submission refuse it rather than print the raw value
or silently rebind the evidence.

Uses the normal Harness credential rules, requiring `reviews:read` for preview
and also `reviews:write` for submission. Requires backend support for the
event; an older backend rejects it without changing history. Conflicts and
network errors fail visibly, without automatic retries or spooling. An
acknowledgment (exit 0) is not a convergence verdict; separately inspect
`rcl evidence status` when authorized. Originals and sibling sightings remain
unchanged, and the correction is not inherited by another run. A correction can
reopen a previously suppressed critical finding if its canonical verdict is not
critical. A `fixed` correction is audit-only for that run and does not clear
`fixes_pending`.

## `rcl evidence retriage-finding`

Record a **new explicit dismissal** for one existing finding at its actual
recorded severity. This repairs a historical grouped-severity dismissal without
replaying the report or guessing a native identity after spans have drifted. It
is not an automatic upgrade of the old verdict or a gate waiver.

```bash
rcl evidence retriage-finding --target "$TARGET" --run "$RUN_ID" \
  --report-sha256 "$ORIGINAL_REPORT_SHA256" --finding-ref f002 \
  --for-pr example/project#42 --reason-file ./retriage-reason.txt
# Inspect the preview and source-backed reason; repeat with --submit if authorized.
```

All selectors and the UTF-8 reason file are required. The nonblank reason is
limited to 2000 characters; malformed UTF-8 is refused. The command reads the
run, checks its PR, head and stored report metadata, and requires one exact
finding ref with a unique `report:<run-id>:<key>` identity (RCL 3.3+). A native
convergence run must match the selected target and carry a positive round. A
standalone gate run without convergence metadata is accepted only when Harness
records it as an attested, current-head, same-repository CI review. Its PR,
run, report digest and finding ref provide the server binding; the selected
target remains the event's informational label. The required event round is
`1` as a wire-protocol value only, not a claim that the attested review
participated in native convergence. Legacy unqualified or colliding keys are
refused, because a verdict on those keys could affect an unrelated sighting.
The digest is compared with the stored artifact metadata; the command does not
retrieve or claim to verify the original report bytes. It does not need or
read native convergence state. `recover-finding` retains its separate
exact-span/native-verdict checks unchanged.

Preview performs only the run read and labels the standalone-attested transport
round when applicable. `--submit` appends one fresh, authenticated
`verdicts_recorded` event under the original report key, on the selected run,
with the reason and recorded severity. No existing report, verdict, mapping,
attempt count, model statistics or native file is rewritten. No reviewers run,
and no outbox is flushed or spooled. Scrubbing that would alter the selected
evidence or reason causes refusal before submission. The existing Harness API
and its critical-dismissal check remain unchanged.

Uses the normal Harness credential rules (`reviews:read`, plus `reviews:write`
to submit). A refusal or uncertain response fails visibly, without automatic
retry. Each submission is a fresh attributed judgment, not an idempotent replay
of an old event; inspect server evidence before retrying an uncertain write.
Exit 0 means preview succeeded or exactly one new insertion was acknowledged,
**not** that the gate converged. Independently run `rcl evidence status` for
the exact PR.

## `rcl telemetry backfill`

Recovered history becomes day-one evidence on Harness.
`rcl telemetry backfill --from <dir> --repo <owner/repo>` reads the pre-3.0
`rcl-report-*.json` reports and `rcl-converge-*-ledger.md` ledgers in a
directory (the same layout `rcl models seed` reads) and posts each report as a
run with `provenance: backfill`: a synthesized header bound to the named
repository (target `patch`, the report bytes as the digest, a runner claim
naming this command), the report's findings with their stable identities, its
reviewer calls, and the report files as artifacts. Ledger bullets matched to a
round's findings become `verdicts_recorded` events. Run ids are UUIDv5 of
`(host, repo, sha256 of the report)` and event ids derive from them, so running
the backfill twice reports the second run as `0 new` — nothing is duplicated.
Backfilled runs count for model stats and analytics and never enter a gate
decision.

```bash
rcl telemetry backfill --from ~/recovered-rcl-artifacts --repo owner/repo --dry-run
rcl telemetry backfill --from ~/recovered-rcl-artifacts --repo owner/repo
```

## `rcl telemetry recover-refutations`

Recover the original verifier model and explanation from retained modern and
pre-header reports. The default command only reads files and makes
authenticated GET requests. It writes a private manifest for review; `--apply`
is a separate, explicit step. No reviewer is rerun, no triage events are
invented, and retry queues and source reports remain untouched.

```bash
# Offline discovery, also usable before a compatible Harness backend is deployed.
rcl telemetry recover-refutations --inventory-only --manifest inventory.json

# Plan against the authenticated organization. Repeated roots replace defaults.
rcl telemetry recover-refutations --root ~/Development --root /tmp --manifest recovery.json

# Inspect coverage, source hashes, every refutation and each proposed action first.
rcl telemetry recover-refutations --manifest recovery.json --apply --output outcome.json
```

The destination is the complete authenticated Harness base URL plus its
server-reported organization. Applying with a different host, URL path or
organization fails before any write. An older receiver without `meta.org_id`
cannot produce an applyable manifest; use `--inventory-only` until a compatible
backend is available. Inventory-only artifacts are never accepted for apply.
Telemetry opt-outs and the existing Harness login/CI credential rules still
apply.

Default discovery covers `~/Development`, `/tmp`, `/private/tmp`, the
configured OS temporary directory and `RCL_DATA_DIR` (otherwise `~/.rcl`). It
also inspects registered Git worktrees/common directories, RCL output and
outbox directories, and explicit JSON report references in retained ledgers and
task metadata, including references beyond the initial roots. Add `--root` for
other retained cache/task locations. Only bounded candidate files are read;
symlinks, changing files, invalid UTF-8 and files larger than 25 MiB are
rejected. Incomplete, missing and inaccessible sources stay in the coverage
report. Re-inventory after active reviews finish and record a final discovery
cutoff.

Identical report bytes collapse to one SHA-256 entry with all discovered file
locations. The manifest retains positional finding refs, original identities,
normalized model/notes and source bindings. Missing original notes remain
explicit. Legacy repository ownership must be proven by a registered source
worktree or a retained ledger in that worktree; ambiguous ownership is
unresolved. A directory marked `SYNTHETIC_TEST_ONLY`, or a repeated
`--exclude-sha256 <digest>`, explicitly excludes synthetic evidence and all
copies with that digest. Missing reference paths are counted separately from
missing reports; a basename match is not proof.

| Planned action | Application |
| --- | --- |
| `upload_and_recover` | Upload only the absent original artifact matching the recorded run's declaration, then select that run for server recovery. |
| `recover` | Select an existing run for the server's validated, append-only recovery operation. RCL does not patch findings. |
| `import_history` | Import missing evidence once under a deterministic historical ID; preserve original timing/target and explicit original-run/digest binding for modern reports. |
| `already_present` | Read and confirm the recorded evidence; no write. |
| `skip`, `conflict`, `unavailable` | Preserve the disposition for resolution; no write. |

Apply rechecks source bytes and server bindings. It can use a retained,
digest-verified copy if another location disappeared. It never replaces an
existing run or escalates an existing-run selection into a new historical
import. For legacy reports, the established UUID derives from lowercase host
(including port), repository and **original** report digest. Its scrubbed
upload may have a different digest, recorded in the artifact declaration.
Modern originals needing redaction are never uploaded under their original
digest. When that exact artifact is already stored in Harness, it can still
supply server recovery without another upload. Unsafe, unsupported or
conflicting sources require resolution.

An apply outcome includes `server_recovery_run_ids`. An authorized Harness
operator passes those IDs to the bounded server-side recovery operation,
previews the selection, applies it with explicit operator/operation
attribution, and retains its results. Rerun the reviewed manifest to verify the
common API projection afterwards. Repeat application is resumable and
idempotent, including when a delivery receipt is lost; the source, queues and
manifest are never deleted. Outcome `writes` counts acknowledged creations, so
a lost receipt can leave a confirmed stored result without a creation count.
The report dispositions and readback determine completion.

Manifest/output paths must be new and are published atomically with mode
`0600`. Without `--output`, apply uses a unique outcome filename beside the
manifest. Exit `0` means a plan/inventory was written, or apply reconciled its
selected reports; `1` means apply still needs server recovery or
source/conflict resolution; `2` means the command could not validate or perform
the operation. Discovery issues and absent original notes still need explicit
reconciliation even with exit `0`. Stopping and keeping the manifest is the
rollback for an interrupted operation: do not delete historical records,
rewrite original evidence, or flush queued live reviews as a recovery shortcut.
