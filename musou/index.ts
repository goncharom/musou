import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  SessionManager,
  withFileMutationQueue,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { renderMusouPromptInstructions } from "./prompt";
import { MusouReviewOverlay, type ReviewAction } from "./review-overlay";

type ProposalTarget =
  | "global-agents"
  | "project-agents"
  | `global-skill:${string}`
  | `project-skill:${string}`;

type MusouRunSource = "auto" | "manual";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type MusouMessage = { role?: string; content?: unknown };
type TargetKind = "single-file" | "skill-dir";

interface ManagedTargetFile {
  relativePath: string;
  absolutePath: string;
  content: string;
  cap: number;
}

interface ProposalFileChange {
  relativePath: string;
  absolutePath: string;
  originalContent: string | null;
  proposedContent: string;
  cap: number;
}

interface Proposal {
  target: ProposalTarget;
  reason: string;
  targetPath: string;
  targetKind: TargetKind;
  targetLabel: string;
  fileChanges: ProposalFileChange[];
}

interface ActiveMusouRun {
  tempDir: string;
  startedAt: number;
  source: MusouRunSource;
}

interface MusouState {
  entryCount: number;
  lastMusouAt: number | null;
  pendingProposals: Proposal[] | null;
  lastError: string | null;
  lastSessionFingerprint: string | null;
  activeRun: ActiveMusouRun | null;
}

interface MusouConfig {
  musouEvery: number;
  maxFileLengthChars: number;
  timeoutMs: number;
  thinkingLevel: ThinkingLevel;
}

interface MusouTargetFile {
  target: ProposalTarget;
  kind: TargetKind;
  path: string;
  label: string;
  files: ManagedTargetFile[];
}

interface ParsedProposalFile {
  path?: string;
  content?: string;
}

interface ParsedProposal {
  target: string;
  reason: string;
  proposed_content?: string;
  files?: ParsedProposalFile[];
}

interface MusouRunFiles {
  tempDir: string;
  stdoutPath: string;
  stderrPath: string;
  resultPath: string;
  markerPath: string;
  targetsPath: string;
  configPath: string;
}

interface MusouRunResult {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
}

interface JsonModeAssistantOutput {
  text: string;
  errorMessage: string | null;
}

const MUSOU_STATE_TYPE = "musou-state";
const MUSOU_NO_RECURSE_ENV = "MUSOU_NO_RECURSE";
const RUNNER_POLL_MS = 2000;
const PROGRESS_WIDGET_DELAY_MS = 5000;
const MUSOU_RUN_TRIGGER_PROMPT = "Analyze the current session now and return exactly one JSON array with no prose.";

const DEFAULT_STATE: MusouState = {
  entryCount: 0,
  lastMusouAt: null,
  pendingProposals: null,
  lastError: null,
  lastSessionFingerprint: null,
  activeRun: null,
};

const DEFAULT_CONFIG: MusouConfig = {
  musouEvery: 50,
  maxFileLengthChars: 4000,
  timeoutMs: 120_000,
  thinkingLevel: "medium",
};

export default function musouExtension(pi: ExtensionAPI): void {
  let state: MusouState = { ...DEFAULT_STATE };
  let config: MusouConfig = { ...DEFAULT_CONFIG };
  let targets: MusouTargetFile[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let currentRunStartedAt: number | null = null;

  function persistState(): void {
    pi.appendEntry(MUSOU_STATE_TYPE, state);
  }

  async function refreshConfig(ctx: ExtensionContext): Promise<void> {
    config = await loadConfig(ctx);
  }

  async function refreshTargets(ctx: ExtensionContext): Promise<void> {
    await refreshConfig(ctx);
    targets = await discoverTargetFiles(ctx, config);
    updatePendingStatus(ctx);
    updateMusouStatus(ctx);
  }

  function clearProgressWidget(ctx: ExtensionContext): void {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = null;
    ctx.ui.setWidget("musou", undefined);
  }

  function armProgressWidget(ctx: ExtensionContext): void {
    clearProgressWidget(ctx);
    progressTimer = setTimeout(() => {
      const lines = [
        "💭 Musou analyzing session in the background...",
        `Source: ${state.activeRun?.source ?? "manual"}`,
        `Targets: ${targets.length}`,
      ];
      ctx.ui.setWidget("musou", lines, { placement: "aboveEditor" });
    }, PROGRESS_WIDGET_DELAY_MS);
  }

  function incrementCount(): void {
    state.entryCount += 1;
  }

  function updatePendingStatus(ctx: ExtensionContext): void {
    const count = state.pendingProposals?.length ?? 0;
    ctx.ui.setStatus("musou-pending", count > 0 ? `💭 ${count} proposals pending (/musou-review)` : undefined);
  }

  function updateMusouStatus(ctx: ExtensionContext): void {
    if (state.activeRun) {
      const elapsedMs = Date.now() - (currentRunStartedAt ?? state.activeRun.startedAt);
      ctx.ui.setStatus("musou", `💭 Musou running ${formatDuration(elapsedMs)}`);
      return;
    }

    const base = `💭 Musou ${state.entryCount}/${config.musouEvery}`;
    const suffix = state.lastMusouAt ? ` · last ${formatAge(state.lastMusouAt)} ago` : " · never run";
    ctx.ui.setStatus("musou", `${base}${suffix}`);
  }

  async function maybeRunAutoMusou(ctx: ExtensionContext): Promise<void> {
    if (state.entryCount < config.musouEvery) {
      updateMusouStatus(ctx);
      return;
    }
    await runMusou(ctx, "auto", false);
  }

  async function runMusou(ctx: ExtensionContext, source: MusouRunSource, force: boolean): Promise<void> {
    await refreshConfig(ctx);

    if (process.env[MUSOU_NO_RECURSE_ENV]) {
      if (source === "manual") ctx.ui.notify("💭 Musou is disabled inside Musou subprocesses.", "info");
      return;
    }
    if (state.activeRun) {
      if (source === "manual") ctx.ui.notify("💭 Musou already in progress.", "info");
      return;
    }
    if ((state.pendingProposals?.length ?? 0) > 0) {
      if (source === "manual") ctx.ui.notify("💭 Review pending proposals first with /musou-review.", "info");
      return;
    }

    await refreshTargets(ctx);
    if (targets.length === 0) {
      ctx.ui.notify("💭 No existing AGENTS.md or skill files found to improve.", "info");
      return;
    }

    const sessionFile = ctx.sessionManager.getSessionFile?.();
    if (!sessionFile) {
      ctx.ui.notify("💭 Musou needs a persisted session file. Restart without --no-session.", "error");
      return;
    }

    const fingerprint = await getSessionFingerprint(sessionFile);
    if (!fingerprint) {
      ctx.ui.notify("💭 Musou could not inspect the current session file.", "error");
      return;
    }

    if (!force && source === "auto" && state.lastSessionFingerprint === fingerprint) {
      state.entryCount = 0;
      state.lastError = null;
      persistState();
      updateMusouStatus(ctx);
      ctx.ui.notify("💭 Musou skipped — session has not changed since the last analysis.", "info");
      return;
    }

    try {
      const run = await spawnMusouRun(ctx, sessionFile, fingerprint, targets, config);
      state.activeRun = { tempDir: run.tempDir, startedAt: Date.now(), source };
      state.lastError = null;
      if (source === "auto") state.entryCount = 0;
      persistState();
      currentRunStartedAt = state.activeRun.startedAt;
      armProgressWidget(ctx);
      updateMusouStatus(ctx);
      startPollingRun(ctx);
      if (source === "manual") ctx.ui.notify("💭 Musou started in the background.", "info");
    } catch (error) {
      state.lastError = `Failed to start Musou: ${String(error)}`;
      persistState();
      updateMusouStatus(ctx);
      ctx.ui.notify("💭 Musou failed to start. Check /musou-status for details.", "error");
    }
  }

  function startPollingRun(ctx: ExtensionContext): void {
    if (pollTimer) clearInterval(pollTimer);

    pollTimer = setInterval(async () => {
      if (!state.activeRun) {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = null;
        clearProgressWidget(ctx);
        updateMusouStatus(ctx);
        return;
      }

      currentRunStartedAt = state.activeRun.startedAt;
      updateMusouStatus(ctx);

      const files = getRunFiles(state.activeRun.tempDir);
      try {
        await access(files.markerPath);
      } catch {
        return;
      }

      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }

      await completeRun(ctx, state.activeRun, files);
    }, RUNNER_POLL_MS);
  }

  async function completeRun(ctx: ExtensionContext, activeRun: ActiveMusouRun, files: MusouRunFiles): Promise<void> {
    clearProgressWidget(ctx);

    try {
      const [rawResult, rawStdout, rawStderr, rawTargets, rawConfig] = await Promise.all([
        readTextIfExists(files.resultPath),
        readTextIfExists(files.stdoutPath),
        readTextIfExists(files.stderrPath),
        readTextIfExists(files.targetsPath),
        readTextIfExists(files.configPath),
      ]);

      const result = parseRunResult(rawResult);
      const runTargets = parseRunTargets(rawTargets);
      const runConfig = parseRunConfig(rawConfig);
      if (!runTargets || !runConfig) {
        throw new Error("Musou run metadata was missing or invalid.");
      }

      state.activeRun = null;
      currentRunStartedAt = null;

      if (result.timedOut) {
        state.lastError = `Musou subprocess timed out after ${runConfig.timeoutMs}ms.`;
        persistState();
        updateMusouStatus(ctx);
        ctx.ui.notify("💭 Musou failed — subprocess timeout. Check /musou-status for details.", "error");
        return;
      }

      if (result.code !== 0) {
        state.lastError = truncate(rawStderr || rawStdout || `Exit code ${result.code}`, 600);
        persistState();
        updateMusouStatus(ctx);
        ctx.ui.notify("💭 Musou failed — subprocess error. Check /musou-status for details.", "error");
        return;
      }

      const assistantOutput = parseJsonModeAssistantOutput(rawStdout ?? "");
      if (!assistantOutput) {
        state.lastError = truncate(rawStderr || rawStdout || "Musou subprocess did not emit an assistant message in JSON mode.", 600);
        persistState();
        updateMusouStatus(ctx);
        ctx.ui.notify("💭 Musou failed — invalid JSON. Check /musou-status for details.", "error");
        return;
      }

      if (assistantOutput.errorMessage) {
        state.lastError = truncate(assistantOutput.errorMessage, 600);
        persistState();
        updateMusouStatus(ctx);
        ctx.ui.notify("💭 Musou failed — subprocess error. Check /musou-status for details.", "error");
        return;
      }

      const assistantText = assistantOutput.text.trim();
      if (!assistantText) {
        state.lastError = "Musou assistant returned empty text output.";
        persistState();
        updateMusouStatus(ctx);
        ctx.ui.notify("💭 Musou failed — invalid JSON. Check /musou-status for details.", "error");
        return;
      }

      const parsed = parseProposalArray(assistantText);
      if (parsed.ok === false) {
        state.lastError = parsed.error;
        persistState();
        updateMusouStatus(ctx);
        ctx.ui.notify("💭 Musou failed — invalid JSON. Check /musou-status for details.", "error");
        return;
      }

      const proposals = parsed.proposals
        .map((proposal): Proposal | null => normalizeProposal(proposal, runTargets, runConfig, ctx.cwd))
        .filter((proposal): proposal is Proposal => proposal !== null);

      state.lastError = null;
      state.lastMusouAt = Date.now();
      state.lastSessionFingerprint = await readRunFingerprint(activeRun.tempDir);

      if (proposals.length === 0) {
        state.pendingProposals = null;
        persistState();
        updatePendingStatus(ctx);
        updateMusouStatus(ctx);
        ctx.ui.notify("💭 Musou complete — nothing to learn from this session.", "info");
        return;
      }

      state.pendingProposals = proposals;
      persistState();
      updatePendingStatus(ctx);
      updateMusouStatus(ctx);
      ctx.ui.notify(
        `💭 Musou complete — ${proposals.length} improvement${proposals.length === 1 ? "" : "s"} proposed. Run /musou-review to inspect.`,
        "info",
      );
    } catch (error) {
      state.activeRun = null;
      currentRunStartedAt = null;
      state.lastError = `Failed to finish Musou run: ${String(error)}`;
      persistState();
      updateMusouStatus(ctx);
      ctx.ui.notify("💭 Musou failed while collecting results. Check /musou-status for details.", "error");
    } finally {
      try {
        await rm(activeRun.tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failure
      }
    }
  }

  async function openReview(ctx: ExtensionCommandContext): Promise<void> {
    const proposals = state.pendingProposals ?? [];
    if (proposals.length === 0) {
      ctx.ui.notify("💭 No pending musou proposals.", "info");
      updatePendingStatus(ctx);
      updateMusouStatus(ctx);
      return;
    }

    const result = await reviewPendingProposals(pi, ctx, proposals);
    state.pendingProposals = result.remaining.length > 0 ? result.remaining : null;
    persistState();
    updatePendingStatus(ctx);
    updateMusouStatus(ctx);

    if (result.quit) {
      ctx.ui.notify(
        `Review paused — ${result.accepted} accepted, ${result.discarded} discarded, ${result.remaining.length} still pending.`,
        "info",
      );
      return;
    }

    ctx.ui.notify(`Review complete — ${result.accepted} accepted, ${result.discarded} discarded.`, "info");
  }

  pi.on("session_start", async (_event, ctx) => {
    state = { ...restoreMusouState(ctx), entryCount: 0 };
    await refreshTargets(ctx);
    if (process.env[MUSOU_NO_RECURSE_ENV]) {
      ctx.ui.setStatus("musou", "💭 Musou subprocess");
      return;
    }
    if (state.activeRun) {
      currentRunStartedAt = state.activeRun.startedAt;
      armProgressWidget(ctx);
      startPollingRun(ctx);
    }
    updatePendingStatus(ctx);
    updateMusouStatus(ctx);
  });

  pi.on("resources_discover", async (_event, ctx) => {
    if (process.env[MUSOU_NO_RECURSE_ENV]) return;
    await refreshTargets(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    const message = (event as { message?: MusouMessage }).message;
    if (!message) return;
    if (message.role === "user" || message.role === "assistant") {
      incrementCount();
      persistState();
      updateMusouStatus(ctx);
    }
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    incrementCount();
    persistState();
    updateMusouStatus(ctx);
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    incrementCount();
    persistState();
    updateMusouStatus(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (process.env[MUSOU_NO_RECURSE_ENV]) return;
    await maybeRunAutoMusou(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    clearProgressWidget(ctx);
    ctx.ui.setStatus("musou", undefined);
    ctx.ui.setStatus("musou-pending", undefined);
  });

  pi.registerCommand("musou", {
    description: "Run musou analysis now",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await runMusou(ctx, "manual", true);
    },
  });

  pi.registerCommand("musou-review", {
    description: "Review pending musou proposals",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();
      await openReview(ctx);
    },
  });

  pi.registerCommand("musou-status", {
    description: "Show musou state",
    handler: async (_args, ctx) => {
      await refreshConfig(ctx);
      const lines = [
        "Musou status",
        `  Entry count: ${state.entryCount} / ${config.musouEvery}`,
        `  Thinking level: ${config.thinkingLevel}`,
        `  Last musou: ${state.lastMusouAt ? new Date(state.lastMusouAt).toLocaleString() : "never"}`,
        `  Pending: ${state.pendingProposals?.length ?? 0}`,
        `  Targets: ${targets.length}`,
        `  Last session fingerprint: ${state.lastSessionFingerprint ?? "none"}`,
        `  Active run: ${state.activeRun ? `${state.activeRun.source} (${state.activeRun.tempDir})` : "none"}`,
        ...targets.map((target) => {
          const charCount = target.files.reduce((sum, file) => sum + file.content.length, 0);
          return `    ${target.path} (${target.files.length} files, ${charCount} chars)`;
        }),
      ];
      if (state.lastError) lines.push(`  Last error: ${state.lastError}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}

function restoreMusouState(ctx: ExtensionContext): MusouState {
  const branch = ctx.sessionManager.getBranch();
  const last = [...branch]
    .reverse()
    .find((entry: any) => entry.type === "custom" && entry.customType === MUSOU_STATE_TYPE) as
    | { data?: Partial<MusouState> }
    | undefined;

  const restored = {
    ...DEFAULT_STATE,
    ...(last?.data ?? {}),
  };

  return {
    ...restored,
    pendingProposals: isStoredProposalArray(restored.pendingProposals) ? restored.pendingProposals : null,
  };
}

function isStoredProposalArray(value: unknown): value is Proposal[] {
  return (
    Array.isArray(value) &&
    value.every(
      (proposal) =>
        proposal &&
        typeof proposal === "object" &&
        Array.isArray((proposal as Proposal).fileChanges) &&
        typeof (proposal as Proposal).targetPath === "string",
    )
  );
}

async function loadConfig(ctx: ExtensionContext): Promise<MusouConfig> {
  const globalConfig = await readJsonIfExists(resolve(getAgentDir(), "musou.json"));
  const projectConfig = await readJsonIfExists(resolve(ctx.cwd, ".pi/musou.json"));
  const merged = {
    ...DEFAULT_CONFIG,
    ...(globalConfig ?? {}),
    ...(projectConfig ?? {}),
  } as Record<string, unknown>;

  return {
    musouEvery: normalizePositiveInt(merged.musouEvery, DEFAULT_CONFIG.musouEvery),
    maxFileLengthChars: normalizePositiveInt(merged.maxFileLengthChars, DEFAULT_CONFIG.maxFileLengthChars),
    timeoutMs: normalizePositiveInt(merged.timeoutMs, DEFAULT_CONFIG.timeoutMs),
    thinkingLevel: normalizeThinkingLevel(merged.thinkingLevel, DEFAULT_CONFIG.thinkingLevel),
  };
}

async function discoverTargetFiles(ctx: ExtensionContext, config: MusouConfig): Promise<MusouTargetFile[]> {
  const targets: MusouTargetFile[] = [];
  const agentDir = getAgentDir();

  await maybeAddSingleFileTarget(targets, resolve(agentDir, "AGENTS.md"), "global-agents", "Global AGENTS.md", config);
  await maybeAddSingleFileTarget(targets, resolve(ctx.cwd, "AGENTS.md"), "project-agents", "Project AGENTS.md", config);
  await addSkillTargets(targets, resolve(agentDir, "skills"), "global", config);
  await addSkillTargets(targets, resolve(ctx.cwd, ".pi/skills"), "project", config);

  return targets;
}

async function maybeAddSingleFileTarget(
  targets: MusouTargetFile[],
  path: string,
  target: ProposalTarget,
  label: string,
  config: MusouConfig,
): Promise<void> {
  try {
    await access(path);
    const content = await readFile(path, "utf8");
    const cap = await readMusouCap(path, config.maxFileLengthChars, content);
    targets.push({
      target,
      kind: "single-file",
      path,
      label,
      files: [{ relativePath: basename(path), absolutePath: path, content, cap }],
    });
  } catch {
    // ignore missing files
  }
}

async function addSkillTargets(
  targets: MusouTargetFile[],
  root: string,
  scope: "global" | "project",
  config: MusouConfig,
): Promise<void> {
  try {
    await access(root);
  } catch {
    return;
  }

  const entries = await discoverSkillEntries(root, root);
  for (const entry of entries) {
    const targetPrefix = scope === "global" ? "global-skill:" : "project-skill:";
    if (entry.kind === "root-markdown") {
      const absolutePath = resolve(root, entry.relativePath);
      const content = await readFile(absolutePath, "utf8");
      const cap = await readMusouCap(absolutePath, config.maxFileLengthChars, content);
      targets.push({
        target: `${targetPrefix}${entry.relativePath}` as ProposalTarget,
        kind: "single-file",
        path: absolutePath,
        label: `${scope === "global" ? "Global" : "Project"} root skill: ${entry.relativePath}`,
        files: [{ relativePath: entry.relativePath, absolutePath, content, cap }],
      });
      continue;
    }

    const skillRoot = resolve(root, entry.relativePath);
    const files = await collectSkillBundleFiles(skillRoot, config.maxFileLengthChars);
    if (files.length === 0) continue;
    targets.push({
      target: `${targetPrefix}${entry.relativePath.replace(/\\/g, "/")}` as ProposalTarget,
      kind: "skill-dir",
      path: skillRoot,
      label: `${scope === "global" ? "Global" : "Project"} skill: ${entry.relativePath.replace(/\\/g, "/")}`,
      files,
    });
  }
}

async function discoverSkillEntries(
  root: string,
  current: string,
): Promise<Array<{ kind: "root-markdown" | "skill-dir"; relativePath: string }>> {
  const results: Array<{ kind: "root-markdown" | "skill-dir"; relativePath: string }> = [];
  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(current, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const skillFile = join(fullPath, "SKILL.md");
      try {
        await access(skillFile);
        results.push({ kind: "skill-dir", relativePath: fullPath.slice(root.length + 1) });
        continue;
      } catch {
        results.push(...(await discoverSkillEntries(root, fullPath)));
      }
      continue;
    }

    if (current === root && entry.isFile() && entry.name.endsWith(".md")) {
      results.push({ kind: "root-markdown", relativePath: entry.name });
    }
  }

  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function collectSkillBundleFiles(skillRoot: string, defaultCap: number): Promise<ManagedTargetFile[]> {
  const files: ManagedTargetFile[] = [];
  await walkSkillBundleFiles(skillRoot, skillRoot, files, defaultCap);
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function walkSkillBundleFiles(
  skillRoot: string,
  current: string,
  files: ManagedTargetFile[],
  defaultCap: number,
): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const absolutePath = join(current, entry.name);

    if (entry.isDirectory()) {
      await walkSkillBundleFiles(skillRoot, absolutePath, files, defaultCap);
      continue;
    }

    if (!entry.isFile()) continue;
    const buffer = await readFile(absolutePath);
    if (!isProbablyTextFile(buffer)) continue;
    const content = buffer.toString("utf8");
    const cap = await readMusouCap(absolutePath, defaultCap, content);
    files.push({
      relativePath: absolutePath.slice(skillRoot.length + 1).replace(/\\/g, "/"),
      absolutePath,
      content,
      cap,
    });
  }
}

function buildMusouPrompt(targets: MusouTargetFile[], cwd: string, config: MusouConfig): string {
  const globalSkillRoot = resolve(getAgentDir(), "skills");
  const projectSkillRoot = resolve(cwd, ".pi/skills");

  const sections: string[] = [
    "You are analyzing the current pi session already loaded in this subprocess to identify improvements to persistent instruction files.",
    "Use the session history available in context to detect repeated mistakes, requests, workflows, or preferences worth capturing.",
    renderMusouPromptInstructions(globalSkillRoot, projectSkillRoot),
    "",
    `Default per-file character cap for NEW files: ${config.maxFileLengthChars}`,
    "",
    "What follows is the content of the managed target files. It is provided for reference only so you can construct exact replacement file contents.",
    "Do not comment on these files outside the required JSON array output.",
    "",
    "## Reference target files",
    "",
  ];

  for (const target of targets) {
    sections.push(`=== ${target.label.toUpperCase()} ===`);
    sections.push(`Target id: ${target.target}`);
    sections.push(`Target kind: ${target.kind}`);
    sections.push(`Target path: ${target.path}`);
    sections.push(`Managed text files: ${target.files.length}`);
    for (const file of target.files) {
      sections.push(`--- FILE ${file.relativePath} (${file.content.length} / ${file.cap} chars cap) ---`);
      sections.push(file.content);
      sections.push("--- END FILE ---");
    }
    sections.push("");
  }

  return sections.join("\n");
}

async function spawnMusouRun(
  ctx: ExtensionContext,
  sessionFile: string,
  fingerprint: string,
  targets: MusouTargetFile[],
  config: MusouConfig,
): Promise<MusouRunFiles> {
  const tempDir = await mkdtemp(join(tmpdir(), "musou-run-"));
  const files = getRunFiles(tempDir);
  const promptPath = join(tempDir, "prompt.txt");
  const requestPath = join(tempDir, "request.json");
  const runnerPath = join(tempDir, "runner.cjs");
  const fingerprintPath = join(tempDir, "fingerprint.txt");

  try {
    const forkedManager = SessionManager.forkFrom(sessionFile, ctx.cwd, tempDir);
    const forkedFile = forkedManager.getSessionFile();
    if (!forkedFile) throw new Error("Forked session file was not created.");

    await writeFile(promptPath, buildMusouPrompt(targets, ctx.cwd, config), "utf8");
    await writeFile(files.targetsPath, JSON.stringify(targets), "utf8");
    await writeFile(files.configPath, JSON.stringify(config), "utf8");
    await writeFile(fingerprintPath, fingerprint, "utf8");

    const request = {
      command: "pi",
      args: [
        "--session",
        forkedFile,
        "--mode",
        "json",
        "-p",
        "--no-context-files",
        "--no-skills",
        "--no-extensions",
        "--no-tools",
        "--thinking",
        config.thinkingLevel,
        "--append-system-prompt",
        promptPath,
        MUSOU_RUN_TRIGGER_PROMPT,
      ],
      cwd: ctx.cwd,
      timeoutMs: config.timeoutMs,
      stdoutPath: files.stdoutPath,
      stderrPath: files.stderrPath,
      resultPath: files.resultPath,
      markerPath: files.markerPath,
      env: { ...process.env, [MUSOU_NO_RECURSE_ENV]: "1" },
    };

    await writeFile(requestPath, JSON.stringify(request), "utf8");
    await writeFile(runnerPath, MUSOU_RUNNER_SCRIPT, "utf8");

    const proc = spawn(process.execPath, [runnerPath, requestPath], {
      cwd: ctx.cwd,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, [MUSOU_NO_RECURSE_ENV]: "1" },
    });
    proc.unref();

    return files;
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function getRunFiles(tempDir: string): MusouRunFiles {
  return {
    tempDir,
    stdoutPath: join(tempDir, "stdout.txt"),
    stderrPath: join(tempDir, "stderr.txt"),
    resultPath: join(tempDir, "result.json"),
    markerPath: join(tempDir, "done.json"),
    targetsPath: join(tempDir, "targets.json"),
    configPath: join(tempDir, "config.json"),
  };
}

function parseProposalArray(raw: string): { ok: true; proposals: ParsedProposal[] } | { ok: false; error: string } {
  const candidates = [raw, stripOuterMarkdownFence(raw), extractStandaloneJsonArray(raw)]
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
    .filter((value, index, array) => array.indexOf(value) === index);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!Array.isArray(parsed)) {
        return { ok: false, error: `Musou subprocess returned non-array JSON: ${truncate(candidate, 600)}` };
      }
      return { ok: true, proposals: parsed as ParsedProposal[] };
    } catch {
      // try next candidate
    }
  }

  return { ok: false, error: `Failed to parse musou JSON: ${truncate(raw, 600)}` };
}

function stripOuterMarkdownFence(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i);
  return match?.[1]?.trim() ?? trimmed;
}

function parseJsonModeAssistantOutput(raw: string): JsonModeAssistantOutput | null {
  let lastAssistant: JsonModeAssistantOutput | null = null;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (event?.type !== "message_end" || !event.message || event.message.role !== "assistant") continue;

    lastAssistant = {
      text: extractAssistantText(event.message),
      errorMessage:
        typeof event.message.errorMessage === "string" && event.message.errorMessage.trim() !== ""
          ? event.message.errorMessage
          : null,
    };
  }

  return lastAssistant;
}

function extractAssistantText(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const typedPart = part as { type?: unknown; text?: unknown };
      return typedPart.type === "text" && typeof typedPart.text === "string" ? typedPart.text : "";
    })
    .join("");
}

function extractStandaloneJsonArray(raw: string): string | null {
  let best: string | null = null;

  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== "[") continue;

    const lineStart = raw.lastIndexOf("\n", start - 1) + 1;
    if (raw.slice(lineStart, start).trim() !== "") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < raw.length; index += 1) {
      const char = raw[index]!;

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "[") {
        depth += 1;
        continue;
      }
      if (char !== "]") continue;

      depth -= 1;
      if (depth !== 0) continue;

      const nextLineBreak = raw.indexOf("\n", index + 1);
      const lineEnd = nextLineBreak === -1 ? raw.length : nextLineBreak;
      if (raw.slice(index + 1, lineEnd).trim() !== "") break;

      const candidate = raw.slice(start, index + 1);
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) best = candidate;
      } catch {
        // try the next array candidate
      }
      break;
    }
  }

  return best;
}

function normalizeProposal(proposal: ParsedProposal, targets: MusouTargetFile[], config: MusouConfig, cwd: string): Proposal | null {
  if (typeof proposal.target !== "string") return null;
  if (typeof proposal.reason !== "string" || proposal.reason.trim() === "") return null;

  const existingTarget = targets.find((item) => item.target === proposal.target);
  const target = existingTarget ?? createNewSkillTarget(proposal.target, cwd);
  if (!target) return null;

  const rawFiles = normalizeProposalFileInputs(proposal, target);
  if (!rawFiles || rawFiles.length === 0) return null;

  const existingByPath = new Map(target.files.map((file) => [normalizePathKey(file.relativePath), file]));
  const seen = new Set<string>();
  const fileChanges: ProposalFileChange[] = [];

  for (const rawFile of rawFiles) {
    const normalized = normalizeProposalFile(rawFile, target, config.maxFileLengthChars);
    if (!normalized) return null;

    const pathKey = normalizePathKey(normalized.relativePath);
    if (seen.has(pathKey)) return null;
    seen.add(pathKey);

    const existingFile = existingByPath.get(pathKey);
    const cap = existingFile?.cap ?? config.maxFileLengthChars;
    if (normalized.content.length > cap) return null;
    if (existingFile && existingFile.content === normalized.content) continue;

    fileChanges.push({
      relativePath: normalized.relativePath,
      absolutePath: normalized.absolutePath,
      originalContent: existingFile?.content ?? null,
      proposedContent: normalized.content,
      cap,
    });
  }

  if (target.kind === "skill-dir") {
    const hasSkillFile = rawFiles.some((file) => normalizePathKey(file.path ?? "") === "skill.md");
    if (target.files.length === 0 && !hasSkillFile) return null;
  }

  if (fileChanges.length === 0) return null;

  return {
    target: target.target,
    reason: proposal.reason,
    targetPath: target.path,
    targetKind: target.kind,
    targetLabel: target.label,
    fileChanges: fileChanges.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
  };
}

function normalizeProposalFileInputs(proposal: ParsedProposal, target: MusouTargetFile): ParsedProposalFile[] | null {
  if (Array.isArray(proposal.files)) {
    return proposal.files;
  }

  if (typeof proposal.proposed_content !== "string") return null;
  if (target.kind !== "single-file" || target.files.length !== 1) return null;

  return [{ path: target.files[0]!.relativePath, content: proposal.proposed_content }];
}

function normalizeProposalFile(
  proposalFile: ParsedProposalFile,
  target: MusouTargetFile,
  defaultCap: number,
): { relativePath: string; absolutePath: string; content: string } | null {
  if (typeof proposalFile.path !== "string" || typeof proposalFile.content !== "string") return null;

  if (target.kind === "single-file") {
    const expectedFile = target.files[0];
    if (!expectedFile) return null;
    const normalizedExpected = normalizePathKey(expectedFile.relativePath);
    const normalizedActual = normalizePathKey(proposalFile.path);
    if (normalizedActual !== normalizedExpected) return null;
    if (proposalFile.content.length > expectedFile.cap) return null;
    return {
      relativePath: expectedFile.relativePath,
      absolutePath: expectedFile.absolutePath,
      content: proposalFile.content,
    };
  }

  const safeRelativePath = sanitizeRelativeSkillFilePath(proposalFile.path);
  if (!safeRelativePath) return null;

  const absolutePath = resolve(target.path, safeRelativePath);
  if (!isPathInsideRoot(absolutePath, target.path)) return null;
  if (proposalFile.content.length > defaultCap && !target.files.some((file) => normalizePathKey(file.relativePath) === normalizePathKey(safeRelativePath))) {
    return null;
  }

  return {
    relativePath: safeRelativePath,
    absolutePath,
    content: proposalFile.content,
  };
}

async function reviewPendingProposals(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  proposals: Proposal[],
): Promise<{ accepted: number; discarded: number; remaining: Proposal[]; quit: boolean }> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Musou review requires interactive mode.", "error");
    return { accepted: 0, discarded: 0, remaining: proposals, quit: true };
  }

  const remaining = [...proposals];
  let accepted = 0;
  let discarded = 0;
  let quit = false;

  while (remaining.length > 0) {
    const proposal = remaining[0]!;
    const action = await reviewProposalUi(ctx, proposal, accepted + discarded + 1, proposals.length);

    if (action === "quit") {
      quit = true;
      break;
    }

    if (action === "accept") {
      const applied = await applyProposal(pi, ctx, proposal);
      if (applied) accepted += 1;
    } else {
      discarded += 1;
    }

    remaining.shift();
  }

  return { accepted, discarded, remaining, quit };
}

async function applyProposal(pi: ExtensionAPI, ctx: ExtensionCommandContext, proposal: Proposal): Promise<boolean> {
  const queueKey = proposal.targetKind === "skill-dir" ? proposal.targetPath : proposal.fileChanges[0]?.absolutePath ?? proposal.targetPath;

  try {
    await withFileMutationQueue(queueKey, async () => {
      for (const change of proposal.fileChanges) {
        await mkdir(dirname(change.absolutePath), { recursive: true });
        await writeFile(change.absolutePath, change.proposedContent, "utf8");
      }
    });

    pi.sendMessage(
      {
        customType: "musou-applied",
        content: `✓ Applied musou improvement to ${proposal.targetPath}`,
        display: true,
        details: {
          path: proposal.targetPath,
          files: proposal.fileChanges.map((file) => file.absolutePath),
          reason: proposal.reason,
          target: proposal.target,
        },
      },
      { deliverAs: "nextTurn" },
    );
    return true;
  } catch (error) {
    ctx.ui.notify(`Musou write failed: ${String(error)}`, "error");
    return false;
  }
}

async function reviewProposalUi(
  ctx: ExtensionCommandContext,
  proposal: Proposal,
  index: number,
  total: number,
): Promise<ReviewAction> {
  return ctx.ui.custom<ReviewAction>(
    (tui, theme, _kb, done) =>
      new MusouReviewOverlay(
        tui,
        theme,
        {
          targetLabel: proposal.targetLabel,
          targetPath: proposal.targetPath,
          reason: proposal.reason,
          fileChanges: proposal.fileChanges.map((file) => ({
            relativePath: file.relativePath,
            originalContent: file.originalContent,
            proposedContent: file.proposedContent,
          })),
        },
        index,
        total,
        done,
      ),
    {
      overlay: true,
      overlayOptions: MusouReviewOverlay.overlayOptions(),
    },
  );
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | null> {
  try {
    await access(path);
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readMusouCap(path: string, fallback: number, content?: string): Promise<number> {
  try {
    const text = content ?? (await readFile(path, "utf8"));
    const match = text.match(/^<!--\s*musou-cap:\s*(\d+)\s*-->\s*(?:\r?\n)?/);
    const parsed = match ? Number.parseInt(match[1]!, 10) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function normalizeThinkingLevel(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
  return value === "off" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh"
    ? value
    : fallback;
}

function createNewSkillTarget(targetId: string, cwd: string): MusouTargetFile | null {
  if (!isProposalTarget(targetId)) return null;
  if (!targetId.startsWith("global-skill:") && !targetId.startsWith("project-skill:")) return null;

  const [scope, skillName] = targetId.split(":", 2) as ["global-skill" | "project-skill", string | undefined];
  if (!skillName || !isSafeSkillName(skillName)) return null;

  const skillRoot = scope === "global-skill" ? resolve(getAgentDir(), "skills") : resolve(cwd, ".pi/skills");
  const path = resolve(skillRoot, skillName);
  if (!isPathInsideRoot(path, skillRoot)) return null;

  return {
    target: targetId,
    kind: "skill-dir",
    path,
    label: `${scope === "global-skill" ? "Global" : "Project"} skill: ${skillName}`,
    files: [],
  };
}

function isProposalTarget(value: string): value is ProposalTarget {
  return value === "global-agents" || value === "project-agents" || value.startsWith("global-skill:") || value.startsWith("project-skill:");
}

function isSafeSkillName(skillName: string): boolean {
  if (skillName.trim() === "") return false;
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName) && skillName.length <= 64;
}

function sanitizeRelativeSkillFilePath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/").trim();
  if (!normalized || normalized.startsWith("/")) return null;
  if (normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  return normalized;
}

function normalizePathKey(value: string): string {
  return value.replace(/\\/g, "/").trim().toLowerCase();
}

function isPathInsideRoot(path: string, root: string): boolean {
  const normalizedPath = resolve(path);
  const normalizedRoot = resolve(root);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function isProbablyTextFile(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  return true;
}

function getAgentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  if (override) return override;
  const home = process.env.HOME;
  return home ? join(home, ".pi/agent") : resolve(".pi/agent");
}

async function getSessionFingerprint(sessionFile: string): Promise<string | null> {
  try {
    const info = await stat(sessionFile);
    return `${info.size}:${Math.floor(info.mtimeMs)}`;
  } catch {
    return null;
  }
}

async function readRunFingerprint(tempDir: string): Promise<string | null> {
  try {
    return (await readFile(join(tempDir, "fingerprint.txt"), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function parseRunResult(raw: string): MusouRunResult {
  try {
    const parsed = JSON.parse(raw) as Partial<MusouRunResult>;
    return {
      code: typeof parsed.code === "number" || parsed.code === null ? parsed.code : 1,
      signal: typeof parsed.signal === "string" || parsed.signal === null ? parsed.signal : null,
      timedOut: parsed.timedOut === true,
    };
  } catch {
    return { code: 1, signal: null, timedOut: false };
  }
}

function parseRunTargets(raw: string): MusouTargetFile[] | null {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MusouTargetFile[]) : null;
  } catch {
    return null;
  }
}

function parseRunConfig(raw: string): MusouConfig | null {
  try {
    const parsed = JSON.parse(raw) as Partial<MusouConfig>;
    return {
      musouEvery: normalizePositiveInt(parsed.musouEvery, DEFAULT_CONFIG.musouEvery),
      maxFileLengthChars: normalizePositiveInt(parsed.maxFileLengthChars, DEFAULT_CONFIG.maxFileLengthChars),
      timeoutMs: normalizePositiveInt(parsed.timeoutMs, DEFAULT_CONFIG.timeoutMs),
      thinkingLevel: normalizeThinkingLevel(parsed.thinkingLevel, DEFAULT_CONFIG.thinkingLevel),
    };
  } catch {
    return null;
  }
}

function formatAge(timestamp: number): string {
  return formatDuration(Date.now() - timestamp);
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds.toString().padStart(2, "0")}s` : `${seconds}s`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

const MUSOU_RUNNER_SCRIPT = String.raw`const fs = require("node:fs");
const { spawn } = require("node:child_process");

const requestPath = process.argv[2];
const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));

const stdoutFd = fs.openSync(request.stdoutPath, "w");
const stderrFd = fs.openSync(request.stderrPath, "w");

let finished = false;
function finish(result) {
  if (finished) return;
  finished = true;
  try {
    fs.writeFileSync(request.resultPath, JSON.stringify(result));
  } catch {}
  try {
    fs.writeFileSync(request.markerPath, JSON.stringify({ done: true, at: Date.now() }));
  } catch {}
  try {
    fs.closeSync(stdoutFd);
  } catch {}
  try {
    fs.closeSync(stderrFd);
  } catch {}
}

let child;
try {
  child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    stdio: ["ignore", stdoutFd, stderrFd],
  });
} catch (error) {
  finish({ code: 1, signal: null, timedOut: false, spawnError: String(error) });
  process.exit(0);
}

const timeoutHandle = setTimeout(() => {
  try {
    child.kill("SIGTERM");
  } catch {}
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
  }, 5000).unref();
}, request.timeoutMs);
timeoutHandle.unref();

child.on("error", (error) => {
  clearTimeout(timeoutHandle);
  try {
    fs.appendFileSync(request.stderrPath, "\nSpawn error: " + String(error) + "\n");
  } catch {}
  finish({ code: 1, signal: null, timedOut: false });
  process.exit(0);
});

child.on("exit", (code, signal) => {
  clearTimeout(timeoutHandle);
  finish({ code, signal, timedOut: signal === "SIGTERM" || signal === "SIGKILL" });
  process.exit(0);
});
`;
