#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { executeJob } from "./execution.mjs";
import { standalone } from "./standalone.mjs";

const capabilities = [
  "playwright",
  "chrome-devtools-mcp",
  "restricted-browser-authoring",
  "script-revisions-v1",
  "linked-repair-v1",
  "published-artifacts-v1",
];

const help = `Aratame QA toolkit — local-first, no Aratame account required

Standalone (file paths are relative to --project):
  aratame plan --project . --config aratame.json --requirements requirements.txt [--context context.txt ...] [--output e2e/aratame/plan.json]
  aratame review --project . --plan e2e/aratame/plan.json
  aratame run --project . --config aratame.json --plan e2e/aratame/plan.json --approve SHA256
  aratame review --project . --plan e2e/aratame/plan.json --repair-review e2e/aratame/local-FAILED_RUN.json
  aratame run --project . --config aratame.json --plan e2e/aratame/plan.json --approve PLAN_SHA256 --repair-review e2e/aratame/local-FAILED_RUN.json --approve-repair REPAIR_SHA256
  aratame plan --project . --config aratame.json --repository OWNER/REPO --commit FULL_SHA [--manifest aratame/knowledge/manifest.json] [--knowledge ID ...] [--case ID ...]

plan sends specified requirement/context files directly to your configured BYOK provider
(OpenAI, Anthropic, OpenRouter), validates the draft/critique/merge, and writes a draft.
An explicit published revision reads a prepared local Git checkout, without fetching
or switching branches. With no --requirements, plan imports existing definitions
without a model; publication never approves execution. KB-only planning uses explicit
--requirements plus selected --knowledge evidence. Plans bind the exact revision,
and review/run reject changed checkout inputs before fixtures and certification.
review displays the complete validated plan and its SHA256. Inspect its cases, gaps,
target and linked specs, plus your config/fixture. run requires that exact digest.
All listed cases execute. Linked failures retain their original evidence. Optional
repair.enabled proposes bounded locator repairs; exact approval selects a separate
feature-owned copy in a NEW run, verified with the original regression selection.
No baseline overwrite, changed assertions, AI shell execution, or approval-as-pass.
Local config: {baseUrl, model:{provider,model,apiKeyEnv}, playwrightConfig?,
storageState?, fixture?:[executable,...args], browserContext?, testTimeoutMs?, deploymentLabel?,
repair?:{enabled:boolean,approval?:"manual"|"locator_only"|"behavior_preserving"}}.
Repair is opt-in; approval defaults manual and is separate from --approve plan.
model is required for planning/uncovered cases; apiKeyEnv names your environment
variable, never a literal key. The selected model must support tool use for exploration.
Fixtures run only if explicitly configured; they may run before and after exploration.
Planning and running never contact Aratame Cloud. Browser observations and provided
non-secret browserContext go directly to your model provider; provider charges apply.
Local auth state is imported into isolated Chromium; known cookie/storage values
are redacted from model observations. Treat all page data and local evidence as sensitive.
Install @playwright/test in the target project and run npx playwright install chromium.
No fixtures or credentials are invented. run does not start your application.
Toolkit-authored files stay in <project>/e2e/aratame/ without overwriting existing files.
Your existing tests and explicit fixture command are trusted code with their own side effects.
Reports: e2e/aratame/local-<uuid>.json; raw reports/traces/transcripts: .artifacts/.
Local deployment-receipt.json records the operator label (missing = unknown), target,
case versions, start time and original artifact root; no Git deployment identity is inferred.
Generated *.spec.mjs are ordinary Playwright tests, usable without Aratame.
Review generated assertions, then manually link specPath/specTag in your plan and
review its new digest before reuse. Exit: 0 passed, 2 human review, 1 failed/blocked.

Optional hosted Cloud (outbound worker; separate Cloud identity/config):
  aratame enroll --server https://YOUR-CLOUD-HOST --token TOKEN --project /path/to/project [--config /path/to/runner.json] [--name NAME]
  aratame start [--config /path/to/runner.json] [--once]
From a Toolkit source checkout, use node cli.mjs or npm start -- instead.
Enrollment consumes a one-time token and saves a mode-0600 credential file at
~/.aratame/runner.json by default. start polls Cloud for approved assignments,
uploads reports/reviews and sends model requests through Cloud. --once handles
at most one job. Optional local execution settings are the same as above, except
Cloud chooses its configured model rather than the local model setting.
No application edits, billing checkout, git pushes or implicit publication.
Connected repair policy comes only from Cloud, never the local repair setting.
`;
function serverURL(value) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "Server must be an origin without credentials, query, or path",
    );
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error(
      "Remote servers require HTTPS; HTTP is permitted only on localhost",
    );
  return url.origin;
}
async function configPathCheck(filename) {
  const absolute = path.resolve(filename);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error("Config path must not contain symlinks");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return absolute;
}
function apiClient(server, token) {
  return async (endpoint, body, signal) => {
    const timeout = AbortSignal.timeout(
      endpoint.endsWith("/model") ? 100_000 : 20_000,
    );
    const response = await fetch(`${server}/api/runner${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body || {}),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
    });
    const raw = await response.text();
    let result;
    try {
      result = JSON.parse(raw);
    } catch {
      throw new Error(`Server returned non-JSON (${response.status})`);
    }
    if (!response.ok)
      throw Object.assign(
        new Error(result.error || `Server request failed (${response.status})`),
        { status: response.status },
      );
    return result;
  };
}
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      server: { type: "string" },
      token: { type: "string" },
      project: { type: "string" },
      config: { type: "string" },
      name: { type: "string" },
      once: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      requirements: { type: "string" },
      context: { type: "string", multiple: true },
      output: { type: "string" },
      plan: { type: "string" },
      approve: { type: "string" },
      "repair-review": { type: "string" },
      "approve-repair": { type: "string" },
      manifest: { type: "string" },
      commit: { type: "string" },
      repository: { type: "string" },
      knowledge: { type: "string", multiple: true },
      case: { type: "string", multiple: true },
    },
  });
  if (values.help || !positionals.length) {
    console.log(help);
    return;
  }
  if (positionals.length !== 1)
    throw new Error("Specify exactly one command; use --help.");
  if (["plan", "review", "run"].includes(positionals[0])) {
    await standalone(positionals[0], values);
    return;
  }
  const filename = await configPathCheck(
    values.config || path.join(os.homedir(), ".aratame", "runner.json"),
  );
  if (positionals[0] === "enroll") {
    if (!values.server || !values.token || !values.project)
      throw new Error("enroll requires --server, --token, and --project");
    const server = serverURL(values.server);
    const project = await fs.realpath(values.project);
    if (!(await fs.stat(project)).isDirectory())
      throw new Error("Project must be a directory");
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    await configPathCheck(filename);
    // Reserve the file before consuming the one-time token; never overwrite an existing identity.
    const file = await fs.open(filename, "wx", 0o600);
    try {
      const enrolled = await apiClient(server)("/enroll", {
        token: values.token,
        name: values.name || os.hostname(),
        capabilities,
      });
      if (typeof enrolled.token !== "string" || !enrolled.runner?.id)
        throw new Error("Invalid enrollment response");
      await file.writeFile(
        JSON.stringify(
          {
            server,
            project,
            token: enrolled.token,
            runnerId: enrolled.runner.id,
          },
          null,
          2,
        ) + "\n",
      );
      await file.sync();
    } catch (error) {
      await file.close();
      await fs.unlink(filename);
      throw error;
    }
    await file.close();
    console.log(
      `Runner enrolled. Private config: ${filename}\nStart: npx aratame start --config ${JSON.stringify(filename)}`,
    );
    return;
  }
  if (positionals[0] !== "start")
    throw new Error("Expected plan, review, run, enroll or start; use --help");
  const stat = await fs.stat(filename);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error(
      "Runner config must be a regular file with mode 0600 (chmod 600 your-config-path)",
    );
  const config = JSON.parse(await fs.readFile(filename, "utf8"));
  config.server = serverURL(config.server);
  if (
    typeof config.token !== "string" ||
    !config.token ||
    typeof config.project !== "string"
  )
    throw new Error("Invalid runner config; enroll first");
  const relativeConfig = path.relative(path.resolve(config.project), filename);
  if (relativeConfig && !relativeConfig.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeConfig))
    config.localConfigPath = relativeConfig.split(path.sep).join("/");
  if (
    config.testTimeoutMs !== undefined &&
    (!Number.isInteger(config.testTimeoutMs) ||
      config.testTimeoutMs < 1000 ||
      config.testTimeoutMs > 600_000)
  )
    throw new Error("testTimeoutMs must be 1000..600000");
  if (
    config.deploymentLabel !== undefined &&
    (typeof config.deploymentLabel !== "string" ||
      !config.deploymentLabel.trim() ||
      config.deploymentLabel.trim().length > 200)
  )
    throw new Error(
      "deploymentLabel must be a non-empty operator label of at most 200 characters",
    );
  const api = apiClient(config.server, config.token);
  const shutdown = new AbortController();
  const stop = () => shutdown.abort(new Error("Runner shutting down"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(
    `Runner ${config.runnerId} polling ${config.server}; project ${config.project}`,
  );
  while (!shutdown.signal.aborted) {
    try {
      await api("/heartbeat", { capabilities }, shutdown.signal);
      const { job } = await api("/claim", { capabilities }, shutdown.signal);
      if (!job) {
        if (values.once) {
          console.log("No queued run available.");
          break;
        }
        await delay(5000, undefined, { signal: shutdown.signal });
        continue;
      }
      console.log(`Claimed ${job.run.id}: ${job.cases.length} case(s)`);
      const assignment = new AbortController();
      const signal = AbortSignal.any([
        shutdown.signal,
        assignment.signal,
        AbortSignal.timeout(30 * 60_000),
      ]);
      let heartbeatBusy = false;
      const heartbeat = setInterval(async () => {
        if (heartbeatBusy || signal.aborted) return;
        heartbeatBusy = true;
        try {
          await api(
            "/heartbeat",
            { runId: job.run.id, leaseToken: job.leaseToken },
            signal,
          );
        } catch (error) {
          assignment.abort(
            new Error(`Lease/cancellation check failed: ${error.message}`),
          );
        } finally {
          heartbeatBusy = false;
        }
      }, 20_000);
      try {
        let report;
        try {
          report = await executeJob(config, job, api, signal);
        } catch (error) {
          report = {
            ...error.partialReport,
            ...((job.publishedRevision || job.run.publishedRevision) ? { publishedRevision: job.publishedRevision || job.run.publishedRevision } : {}),
            ...((job.candidateRevision || job.run.candidateRevision) ? { candidateRevision: job.candidateRevision || job.run.candidateRevision } : {}),
            status: "blocked",
            error: error.message,
            logs: error.message,
            results: job.cases.map(
              (item) =>
                error.partialReport?.results.find(
                  (result) => result.caseId === item.id,
                ) || {
                  caseId: item.id,
                  caseVersion: item.version,
                  status: "blocked",
                  detail: `Execution stopped: ${error.message}`,
                  testCount: 0,
                },
            ),
          };
        }
        // Server rechecks assignment, version, revocation and cancellation; never retry a stale report.
        // The operator deployment receipt remains local, never part of the hosted report.
        const {
          localReceipt: _localReceipt,
          repairs: _repairs,
          ...hostedReport
        } = report;
        if (
          job.settings?.repairEnabled ||
          job.reviews?.some((review) => review.kind === "repair")
        ) {
          // Full failure output, browser artifacts and source remain runner-local.
          hostedReport.logs =
            "Linked repair execution evidence retained on the assigned runner.";
          if (hostedReport.error)
            hostedReport.error =
              "Execution blocked; inspect runner-local evidence.";
          hostedReport.results = hostedReport.results.map((result) => {
            const repair = (hostedReport.reviews || []).find(
              (review) =>
                review.kind === "repair" &&
                review.caseId === result.caseId &&
                review.proposal,
            );
            const proposal = repair ? JSON.parse(repair.proposal) : undefined;
            const originalFailure =
              result.status === "failed" &&
              result.scriptSha256 === proposal?.original.sha256
                ? proposal.originalFailure
                : undefined;
            return {
              ...result,
              detail:
                originalFailure?.detail ||
                `Playwright ${result.status}; ${result.testCount} test(s). Full evidence retained on the assigned runner.`,
              ...(originalFailure?.evidence
                ? { evidence: originalFailure.evidence }
                : {}),
            };
          });
          hostedReport.reviews = (hostedReport.reviews || []).map((review) => ({
            ...review,
            detail:
              review.kind === "repair"
                ? "Bounded linked repair proposal; original failure retained on the runner. Approval selects a new run, not a passing result."
                : /no progress|repeated proposal/i.test(review.detail || "")
                  ? "Repair stopped without applying changes: no progress. Original failure retained on the runner."
                  : /budget exhausted/i.test(review.detail || "")
                    ? "Repair stopped without applying changes: attempt budget exhausted. Revise the plan or review the original failure."
                    : "Linked execution requires review. Full failure evidence remains on the assigned runner.",
          }));
        }
        const completed = await api(`/runs/${job.run.id}/report`, {
          ...hostedReport,
          leaseToken: job.leaseToken,
        });
        console.log(`Run ${completed.id}: ${completed.status}`);
      } catch (error) {
        console.error(
          `Run ${job.run.id} could not be completed: ${error.message}. Local artifacts are preserved; no success was reported.`,
        );
      } finally {
        clearInterval(heartbeat);
        assignment.abort(new Error("Run complete"));
      }
      if (values.once) break;
    } catch (error) {
      if (shutdown.signal.aborted) break;
      if (error.status === 401 || error.status === 403) throw error;
      console.error(`Runner blocked: ${error.message}`);
      if (values.once) throw error;
      await delay(5000, undefined, { signal: shutdown.signal }).catch(() => {});
    }
  }
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
