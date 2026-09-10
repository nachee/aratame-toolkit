# Aratame Toolkit

A standalone, Apache-2.0 QA toolkit with an optional outbound Aratame Cloud worker. Local planning, execution, reports, and generated Playwright tests require no Aratame account, server, or subscription. AI calls use your own provider account and may incur provider charges.

The public [aratame-toolkit repository](https://github.com/nachee/aratame-toolkit) is the canonical source for the Toolkit. Aratame Cloud consumes this package; it does not maintain a separate Toolkit implementation.

## Install

Requires Node.js 24 or later. Install directly from the public Git repository in your target project:

```sh
npm install git+https://github.com/nachee/aratame-toolkit.git
npm install --save-dev @playwright/test
npx playwright install chromium
npx aratame --help
```

To pin a revision, append `#FULL_COMMIT_SHA` to the Git URL, replacing `FULL_COMMIT_SHA` with the chosen commit. Alternatively, install the archive served by your Aratame Cloud deployment with `npm install ./aratame-toolkit.tgz`. Neither installation method requires an npm registry release.

The toolkit includes its MCP/browser dependencies. Existing and generated specs resolve `@playwright/test` from your project. Chromium and any operating-system browser dependencies must also be installed.

### Develop from source

```sh
git clone https://github.com/nachee/aratame-toolkit.git
cd aratame-toolkit
npm ci
npx playwright install chromium
npm test
node cli.mjs --help
npm start -- --help
npm pack
```

`npm pack` creates `aratame-toolkit-0.1.0.tgz` in the checkout for installation in a target project. The package contains no Cloud server imports. From this source directory, use `node cli.mjs` or `npm start --` instead of `npx aratame`; pass the target project's path explicitly with `--project`.

## Configure your target and BYOK model

Create `aratame.json` inside the target project. This example model must be available to your provider account; select a different supported model if necessary:

```json
{
  "baseUrl": "http://localhost:3000",
  "model": {
    "provider": "openai",
    "model": "gpt-4.1",
    "apiKeyEnv": "OPENAI_API_KEY"
  },
  "browserContext": "Describe actual non-secret test prerequisites here."
}
```

Set `OPENAI_API_KEY` in the calling process environment using your normal secret-management mechanism. Never put its value in requirements, plans, command arguments, or config. The config stores only the environment-variable name. Supported provider APIs are OpenAI Chat Completions, OpenRouter Chat Completions, and Anthropic Messages. Use a text model with function/tool calling for browser exploration. The client has bounded context/response sizes, a 90-second request deadline, and reports provider authentication, rate-limit, truncation, refusal, and malformed-response errors without printing provider response bodies or credentials. It does not retry or switch providers silently.

Optional config fields:

| Field              | Meaning                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playwrightConfig` | Project-relative existing Playwright config path. Existing tests otherwise use Playwright's normal config discovery.                                                                                                                                                                                                                  |
| `storageState`     | Project-relative Playwright authentication-state JSON. Imported locally into isolated Chromium for exploration and used by generated verification. Existing specs retain their own project's auth configuration.                                                                                                                      |
| `fixture`          | Explicit executable/argv array, such as `["node", "scripts/reset-test-data.mjs"]`. No shell expansion. Invoked before execution and again after exploration, before generated verification. Only configure a command you trust.                                                                                                       |
| `browserContext`   | Up to 10,000 characters of non-secret, real prerequisites sent to the browser model.                                                                                                                                                                                                                                                  |
| `testTimeoutMs`    | Whole Playwright subprocess timeout, 1,000–600,000 milliseconds; default 180,000. Individual tests have a 30-second timeout.                                                                                                                                                                                                          |
| `deploymentLabel`  | Optional operator-supplied deployment/build label (1–200 characters after trimming), recorded only in the local tested-deployment receipt. Omission means unknown; this is attribution, not verified deployment provenance.                                                                                                           |
| `repair`           | Optional `{ "enabled": true, "approval": "manual" }` enables bounded linked-script repair proposals. Disabled when omitted; approval defaults to `manual`. Optional `locator_only` or `behavior_preserving` policies permit only applicable, unambiguous proposals in those categories when explicitly selected into a new local run. |

`model` is required for planning, uncovered-case exploration, and proposing linked repairs, but not for reviewing or verifying an already approved repair. `baseUrl` is required and must match the reviewed plan exactly. It cannot contain credentials, a query, or a fragment. Keep the separate Cloud runner config out of this local config; unknown fields are rejected.

Start your authorized test application yourself. The toolkit does not start it or invent users, credentials, fixtures, or missing product decisions. Browser interactions can mutate your application: use a disposable test environment, not production. Your existing Playwright configuration and explicitly supplied fixtures are trusted executable project code, not sandboxed code.

## Plan, review, then execute

Write your actual requirements in `requirements.txt`. Supply any desired evidence as explicit context files:

```sh
npx aratame plan --project . --config aratame.json --requirements requirements.txt --context product-context.txt
npx aratame review --project . --plan e2e/aratame/plan.json
npx aratame run --project . --config aratame.json --plan e2e/aratame/plan.json --approve REVIEWED_SHA256
```

Replace `REVIEWED_SHA256` with the digest printed by `review`, only after reviewing the entire plan, target, gaps, linked tests, config, and fixture command. There is no default execution approval. Changing even the plan's whitespace changes its digest and invalidates a previous approval.

All local file arguments are relative to the explicit `--project` directory. Repeat `--context` for up to 20 files; each file is bounded to 100 KB and the combined requirements/context budget is 150 KB. Files are not silently truncated. Only named files are read; there is no repository crawl or source-control integration. `--output e2e/aratame/another-plan.json` chooses another plan destination. Toolkit-authored files are restricted to `e2e/aratame/`, symlink traversal is refused, and existing outputs are never overwritten. Trusted project tests and fixtures can have their own side effects outside that directory.

Planning makes separate draft, independent critique, and merge model calls against the original requirements/evidence, validates the structured results, and checks that source files did not change before saving. It does not open a browser or execute model-generated code. A plan is an editable proposal, not evidence that the application works. Gaps are displayed for human resolution; the toolkit cannot decide whether an unresolved product question is acceptable to you.

### Plan JSON, version 1

`examples/plan.json` is a complete handwritten, non-secret format example, not an executed result. Fields:

- `schemaVersion`: `1`.
- `title`, `baseUrl`, `requirements`: reviewable plan identity, authorized target, and authoritative requirements.
- `sources`: `{ "path": "requirements.txt", "sha256": "..." }` records from planning. Handwritten plans may use an empty array. Hashes record generation provenance, not a promise that external requirements can never change.
- `rationale` and `gaps`: planning explanation and unresolved decisions.
- `cases`: 1–40 behavioral cases. Each has a unique path-safe `id`, positive integer `version`, `title`, `surface`, `category` (`smoke`, `functional`, `edge`, `regression`), `priority` (`P0`, `P1`, `P2`), `preconditions`, string-array `steps`, and exact `expected` outcome.
- Optional case `specPath`: existing project-relative `.spec`/`.test` file. Optional `specTag` filters its test title. Optional `automatedVersion` identifies which case version it covers; a mismatch treats the case as uncovered. Increment the case version when behavior changes, and update automation deliberately.

To reuse existing automation, inspect its assertions and add `specPath`/`specTag` to the corresponding case before reviewing its final digest. Planning never invents file links. Every listed case executes, including edge/regression; edit the plan explicitly if you intend a smaller selection. Unknown fields, unsafe paths, duplicate IDs, and invalid behavioral fields are rejected.

### Execution and generated test review

Execution uses the same engine as the Cloud worker:

1. Run linked Playwright tests first, serially, without retries. Failures and their original evidence remain recorded. Opt-in repair proposes a bounded diff; it never overwrites the linked baseline or executes an unapproved candidate in the failing run.
2. For uncovered cases, open real isolated Chromium through Chrome DevTools MCP, inspect the actual target UI, and perform origin-restricted interactions using your BYOK model.
3. Accept only a restricted browser-action/assertion schema with the exact case version and expected outcome. The model cannot run shell, arbitrary JavaScript, upload files, or choose output paths.
4. Compile the observed proposal into ordinary Playwright `.spec.mjs`, reset fixtures only if explicitly configured, then execute verification. If new tests were generated, rerun the existing selection afterward.
5. Keep generated assertions pending human review. The run's initial approval authorizes exploration and verification, not automatic publication or acceptance of new assertions.

Read generated assertions, exploration evidence, and the report's `reviews` proposals. Once you accept coverage, manually add the generated `specPath` and optional `specTag` to the corresponding case, review the changed plan, and run with the new digest. No Cloud approval is required. The toolkit does not silently edit the reviewed plan or application.

### Linked repair review and independent verification

Enable `"repair": { "enabled": true, "approval": "manual" }` in `aratame.json` to request repair proposals after linked failures. The existing `run` command produces a local report containing the original failure and bounded `reviews` proposals. Review and select that exact report separately from approving the plan:

```sh
npx aratame review --project . --plan e2e/aratame/plan.json --repair-review e2e/aratame/local-FAILED_RUN.json
npx aratame run --project . --config aratame.json --plan e2e/aratame/plan.json --approve PLAN_SHA256 --repair-review e2e/aratame/local-FAILED_RUN.json --approve-repair REPAIR_SHA256
```

Use the two digests printed by `review`. The repair digest binds the entire report bytes, including the selected proposal; editing it invalidates approval. Manual is the default. An explicitly configured local automatic policy can omit `--approve-repair` only for eligible, unambiguous proposals; `--repair-review` and the exact plan approval still select a **new** run. There is no Cloud account, hosted review, Git operation, or implicit PR in this path.

Approval is not a passing result. The new run rechecks the exact case version, steps, expected outcome, target and original source SHA, then materializes the approved bytes under `e2e/aratame/repairs/`. Existing files are never overwritten; an existing candidate is reusable only at its exact approved digest. The original and repaired case are never both selected in one run. Real Playwright verifies the selected candidate and reruns every originally linked regression case, serially without retries. A failed initial verification cannot be erased by a later pass.

Repairs retain required actions, their arguments, assertions and control flow. Same-family action locator changes can be `locator_only`; multiple locator edits or strategy changes can be `behavior_preserving`. The supported mechanical subset also converts literal legacy `page.click(selector, { strict: false })` or `page.fill(selector, value, { strict: false })` into `page.locator(newSelector).first().click()` or `.fill(value)`. An explicit `{ strict: true }` instead maps to the locator action without `.first()`. Only that sole selection option is mapped away; action values stay byte-for-byte unchanged. Optionless legacy calls are unsupported because their context-level strictness is unknown. A literal fill value must already appear in the approved steps or preconditions; otherwise the transformation is refused rather than exposing it in the review diff. The model receives only the selector/strictness projection, not arbitrary source or fill values. Other action rewrites are unsupported. Ambiguous repairs require manual approval. Behavioral or unsupported changes are non-applicable even with manual approval: revise the plan instead. Up to three distinct valid proposals per original binding are retained through the selected report history; duplicate proposals stop as no progress. Invalid model output stops the current explicitly requested run immediately without an automatic retry; its failure evidence remains local. Cancellation preserves partial results and local evidence without reporting success.

Repaired copies preserve relative import targets and use the trusted project's Playwright configuration, hooks, browser projects and authentication rather than the generated-test configuration. A non-executing original test listing identifies the selected browser projects; setup/dependency/teardown projects retain their original selection. Snapshot templates retain the original spec's golden-file identity. All real verification disables snapshot updates, so missing or changed goldens fail rather than minting a new baseline. Entry-script digests do not attest imported dependencies, fixtures, the complete checkout, or the actual deployed build. Arbitrary trusted code that branches on the relocated file path remains outside that attestation. Review relocated scripts before publishing them through your own existing workflow. Keep reports and raw evidence private.

### Action mapping and honest exploration stops

Every proposed scenario preserves the approved case version and exact expected outcome. Its `steps` contain actions only, each tagged with either `mapping: { "kind": "declared", "step": 1 }` (a 1-based approved step) or `mapping: { "kind": "connective", "reason": "Open the form before entering data" }`. Declared references must cover every approved step in order; several concrete actions may implement one step. Connective navigation is allowed but cannot substitute for a missing declared action. Assertions belong in a separate non-empty `assertions` array and never count as action coverage.

The compiler rejects omitted, reordered, out-of-range, unexplained connective, and unmapped proposals. Legacy unmapped proposals require deliberate regeneration and new coverage approval; the toolkit never invents mappings or treats old approval as approval of a changed proposal. Human review must still check whether the actions genuinely implement their declared steps: an index is not proof of semantic coverage. Already linked project specs remain trusted existing automation; this proposal cutover does not rewrite them.

Three consecutive identical successful `take_snapshot` or `list_pages` calls stop exploration early as **no progress**, not as a product defect. The fingerprint covers the tool name, arguments, and full result, not the 15 KB excerpt sent to the model. A changed result, different read, state-changing action, explicit `wait_for`, or failed read breaks the streak. Local diagnostic evidence includes the threshold, fingerprint, and full redacted transcript.

When a step cannot be completed, the browser model can call `report_exploration_gap` instead of proposing a shortened passing test. Valid reasons are `missing_prerequisite`, `unsupported_automation`, `expected_mismatch`, and `unclear_requirement`. The terminal result contains a 1-based `blockedStep` (or `null` if unknown), `observedFacts`, `missingPrerequisite` (explicitly unknown when not established), and a concise `manualCheck` restricted to the authorized non-production target. This produces a blocked result with no spec or model-declared pass. A model-reported mismatch is not automatically a verified bug.

The existing result detail displays a bounded gap summary and its local evidence path; full structured facts remain in `<caseId>-exploration-error.json`. Invalid terminal output preserves earlier observations and the rejected output in that same local error artifact. Error categories distinguish infrastructure failures, invalid model output, model-reported gaps, no-progress stops, and exhausted budgets. No fixtures, product decisions, or repair steps are invented.

## Local outputs and exit status

- Summary: `e2e/aratame/local-<uuid>.json`, including plan digest/path, run ID, target, per-case results, reviews, overall status, and `localReceipt` when execution setup reached receipt creation.
- Raw evidence: `e2e/aratame/.artifacts/local-<uuid>-<timestamp>/`, including assignment/result JSON, `deployment-receipt.json`, Playwright reports/traces, fixture logs, and browser exploration transcripts or errors. An early infrastructure failure may only produce the summary and receipt, or only the summary if setup could not create an artifact root.
- Portable generated test: `e2e/aratame/<caseId>-v<version>-local-<uuid>.spec.mjs`.

The local tested-deployment receipt captures the operator's `deploymentLabel` (`null` means unknown), effective runner target, case IDs/versions, start time, run ID, and absolute original artifact root. The copied standalone summary includes that receipt so the declared deployment and original evidence remain identifiable. The target is the configured runner target used for exploration/generated verification; existing trusted project specs can override their own destinations, so the receipt does not certify their actual navigation. The receipt is created before dependency/fixture execution and therefore records an attempted run, not proof that any test passed. It never infers a deployed build from Git, crawls source, or uploads the receipt to Cloud. An operator label is attribution, not cryptographic provenance.

Exit `0` means execution passed (or a non-execution command succeeded); `2` means human review is required; `1` means command failure or blocked/failed execution. Inspect per-case results even when the overall status is `review`, which can include failures awaiting review. There is no automatic provider retry, result upload, application patch, git push, or billing operation.

Generated specs import only `@playwright/test` and embed the reviewed target URL. They run as ordinary Playwright tests after toolkit removal, without an Aratame subscription. A typical project with default test discovery can use:

```sh
npx playwright test e2e/aratame/ACTUAL_GENERATED_FILE.spec.mjs
```

Use your own Playwright config if its discovery settings exclude that directory, and provide the appropriate `storageState` for authenticated flows. The toolkit-generated per-run config in the artifact directory also records verification settings, but contains machine-local absolute paths; it is evidence, not a portable project config. Review and adapt the generated spec deliberately when moving it to a different target.

## Data boundaries

Local `plan`, `review`, and `run` never contact Aratame Cloud or require an Aratame identity. Planning sends the explicitly supplied requirements/context directly to your chosen model provider. Exploration sends case requirements, non-secret browser context, and browser observations/tool results to that provider. Normal browser requests reach your target and its resources. Existing tests and explicitly configured fixtures may perform their own network operations.

Provider credentials are read from environment, used only for provider authorization, and redacted from model content/results. Known imported cookie/storage values are redacted from browser observations and proposals; this cannot guarantee arbitrary page content is non-sensitive. Local browser profiles, reports, traces, screenshots captured by Playwright, and fixture logs can contain sensitive application data. Keep `e2e/aratame/.artifacts/`, run reports, provider credentials, and authentication state out of public source control; inspect generated tests before sharing them. No telemetry or hosted upload is added by the toolkit; Chrome DevTools MCP usage statistics are explicitly disabled.

## Optional Aratame Cloud worker

This is a separate opt-in data flow, not a standalone prerequisite:

```sh
npx aratame enroll --server https://YOUR-CLOUD-HOST --token YOUR_ONE_TIME_TOKEN --project /absolute/project/path
npx aratame start
```

`enroll` consumes a 15-minute one-time enrollment token issued by your configured Cloud workspace and saves a mode-0600 runner credential at `~/.aratame/runner.json`. Existing identity files are never overwritten. `--config /private/runner.json` selects a different credential path; `--name NAME` labels enrollment. `start --once` processes at most one job and exits; otherwise it polls outbound. Remote Cloud origins require HTTPS; HTTP is limited to loopback development.

The Cloud worker receives approved jobs, sends reports/reviews to Cloud, and sends browser/repair model requests through Cloud's configured provider roles. Raw browser artifacts remain local. Linked-repair reports send bounded validated proposal diffs and result summaries, not full source, traces, browser authentication, or raw failure logs. Its config can include optional local execution settings; Cloud supplies model and repair policy, and a local `model` or `repair` policy never overrides Cloud decisions. The worker never turns a standalone plan into a hosted submission automatically.

Feature-staged Cloud runs require a worker advertising `script-revisions-v1`; repair-capable workers also advertise `linked-repair-v1`. Updated workers advertise capabilities when claiming work, so existing enrollments need no replacement. Cloud assigns immutable plan/case revisions and snapshots exact approved coverage/repair proposals for a new run; feature execution does not publish cases or automation into the shared baseline. Final-candidate runs may verify an already approved repair but never generate a new proposal. Existing final promotion gates and explicit feature-PR publication remain authoritative.

Before executing each staged spec, the worker retains an exclusive read-only copy under the run's local artifact directory and binds its SHA-256, project-relative path and optional tag to the active Cloud assignment. Executed results report that digest; changed source bytes or a different binding are rejected. Original specs execute at their original paths; approved repairs execute only the exclusive relocated candidate, with preserved import targets and trusted project configuration. This identifies the entry spec file, not its imports, fixtures, configuration, complete checkout, or an adversarial filesystem; raw source copies and browser artifacts are not uploaded.

Cloud's optional `deploymentIdentity` is explicit operator attribution captured when queuing a run. Missing identity stays unknown, never inferred from local Git HEAD or the worker's `deploymentLabel`. The local receipt records it separately as `cloudDeploymentIdentity`; neither label verifies what build the target actually serves. Standalone runs and legacy Cloud jobs do not require the staged binding endpoint.
