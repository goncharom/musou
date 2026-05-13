import type { Theme } from "@mariozechner/pi-coding-agent";
import { structuredPatch } from "diff";
import type { Focusable, TUI } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";

export type ReviewAction = "accept" | "discard" | "quit";

export interface ReviewOverlayFileChange {
  relativePath: string;
  originalContent: string | null;
  proposedContent: string;
}

export interface ReviewOverlayProposal {
  targetLabel: string;
  targetPath: string;
  reason: string;
  fileChanges: ReviewOverlayFileChange[];
}

const OVERLAY_WIDTH = "72%";
const OVERLAY_MIN_WIDTH = 76;
const OVERLAY_MAX_HEIGHT_PERCENT = 82;
const MIN_DIFF_ROWS = 8;
const CHROME_ROWS = 8;
const REVIEW_DIFF_CONTEXT_LINES = 3;

function padRight(text: string, width: number): string {
  const vis = visibleWidth(text);
  return text + " ".repeat(Math.max(0, width - vis));
}

function wrapLine(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const wrapped = wrapTextWithAnsi(text, safeWidth);
  return wrapped.length > 0 ? wrapped.map((line) => truncateToWidth(line, safeWidth, "", true)) : [""];
}

function styleDiffLine(theme: Theme, line: string): string {
  if (line.startsWith("+ ")) return theme.fg("success", line);
  if (line.startsWith("- ")) return theme.fg("error", line);
  if (line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++")) return theme.fg("accent", line);
  if (line.startsWith("===")) return theme.fg("accent", theme.bold(line));
  return line;
}

export class MusouReviewOverlay implements Focusable {
  focused = false;

  private diffScroll = 0;
  private diffLines: string[];

  constructor(
    private tui: TUI,
    private theme: Theme,
    private proposal: ReviewOverlayProposal,
    private index: number,
    private total: number,
    private done: (result: ReviewAction) => void,
  ) {
    this.diffLines = buildProposalDiffLines(proposal);
  }

  handleInput(data: string): void {
    const diffRows = this.getDiffViewportRows();
    const maxScroll = Math.max(0, this.getWrappedDiffLines(this.getInnerWidth()).length - diffRows);

    if (matchesKey(data, Key.up) || data === "k") {
      this.diffScroll = Math.max(0, this.diffScroll - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down) || data === "j") {
      this.diffScroll = Math.min(maxScroll, this.diffScroll + 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.diffScroll = Math.max(0, this.diffScroll - diffRows);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.diffScroll = Math.min(maxScroll, this.diffScroll + diffRows);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter) || data.toLowerCase() === "a") {
      this.done("accept");
      return;
    }
    if (data.toLowerCase() === "d") {
      this.done("discard");
      return;
    }
    if (matchesKey(data, Key.escape) || data.toLowerCase() === "q") {
      this.done("quit");
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    const border = (s: string) => th.fg("border", s);
    const dim = (s: string) => th.fg("dim", s);
    const accent = (s: string) => th.fg("accent", s);
    const innerWidth = Math.max(20, width - 4);
    const row = (content: string) => border("│ ") + padRight(content, innerWidth) + border(" │");

    const lines: string[] = [];
    lines.push(border("╭" + "─".repeat(Math.max(1, width - 2)) + "╮"));

    const title = accent(th.bold(`Musou Review ${this.index}/${this.total}`));
    const right = dim("A accept  D discard  Q quit");
    const rightW = visibleWidth(right);
    const left = truncateToWidth(title, Math.max(0, innerWidth - rightW - 1), "...", true);
    lines.push(row(left + " ".repeat(Math.max(1, innerWidth - visibleWidth(left) - rightW)) + right));

    lines.push(row(dim(truncateToWidth("↑↓/j/k scroll  PgUp/PgDn faster  Enter accept  Esc quit", innerWidth, "...", true))));
    lines.push(border("├" + "─".repeat(Math.max(1, width - 2)) + "┤"));

    const metadata = this.getMetadataLines(innerWidth);
    for (const line of metadata) lines.push(row(line));

    lines.push(border("├" + "─".repeat(Math.max(1, width - 2)) + "┤"));

    const wrappedDiff = this.getWrappedDiffLines(innerWidth);
    const diffRows = this.getDiffViewportRows();
    const maxScroll = Math.max(0, wrappedDiff.length - diffRows);
    if (this.diffScroll > maxScroll) this.diffScroll = maxScroll;
    const start = this.diffScroll;
    const slice = wrappedDiff.slice(start, start + diffRows);

    for (let i = 0; i < diffRows; i++) {
      lines.push(row(slice[i] ?? ""));
    }

    lines.push(border("├" + "─".repeat(Math.max(1, width - 2)) + "┤"));
    const shownFrom = wrappedDiff.length === 0 ? 0 : Math.min(start + 1, wrappedDiff.length);
    const shownTo = Math.min(start + diffRows, wrappedDiff.length);
    const footer = wrappedDiff.length > diffRows
      ? `Diff ${shownFrom}-${shownTo} of ${wrappedDiff.length}`
      : `Diff ${wrappedDiff.length} lines`;
    lines.push(row(dim(truncateToWidth(footer, innerWidth, "...", true))));
    lines.push(border("╰" + "─".repeat(Math.max(1, width - 2)) + "╯"));

    return lines;
  }

  invalidate(): void {}

  dispose(): void {}

  static overlayOptions() {
    return {
      anchor: "center" as const,
      width: OVERLAY_WIDTH,
      minWidth: OVERLAY_MIN_WIDTH,
      maxHeight: `${OVERLAY_MAX_HEIGHT_PERCENT}%`,
      margin: 1,
    };
  }

  private getMetadataLines(innerWidth: number): string[] {
    const th = this.theme;
    const lines: string[] = [];
    const pushWrapped = (label: string, value: string, color: (s: string) => string = (s) => s) => {
      const prefix = th.fg("dim", `${label}: `);
      const wrapped = wrapLine(`${prefix}${color(value)}`, innerWidth);
      lines.push(...wrapped);
    };

    pushWrapped("Target", this.proposal.targetLabel, (s) => th.fg("accent", s));
    pushWrapped("Path", this.proposal.targetPath);
    pushWrapped("Reason", this.proposal.reason);

    const fileLabels = this.proposal.fileChanges.map((file) =>
      file.originalContent === null ? `${file.relativePath} (new)` : file.relativePath,
    );
    pushWrapped("Files", fileLabels.join(", "));
    return lines;
  }

  private getWrappedDiffLines(innerWidth: number): string[] {
    const wrapped: string[] = [];
    for (const line of this.diffLines) {
      wrapped.push(...wrapLine(styleDiffLine(this.theme, line), innerWidth));
    }
    return wrapped;
  }

  private getInnerWidth(): number {
    const widthSetting = Math.max(OVERLAY_MIN_WIDTH, Math.floor((this.tui.terminal.columns * 72) / 100));
    return Math.max(20, widthSetting - 4);
  }

  private getOverlayRows(): number {
    return Math.max(18, Math.floor((this.tui.terminal.rows * OVERLAY_MAX_HEIGHT_PERCENT) / 100));
  }

  private getDiffViewportRows(): number {
    return Math.max(MIN_DIFF_ROWS, this.getOverlayRows() - CHROME_ROWS - this.getMetadataRowEstimate());
  }

  private getMetadataRowEstimate(): number {
    const innerWidth = this.getInnerWidth();
    return this.getMetadataLines(innerWidth).length;
  }
}

function buildProposalDiffLines(proposal: ReviewOverlayProposal): string[] {
  const lines: string[] = [];

  for (const change of proposal.fileChanges) {
    lines.push(`=== ${change.relativePath} ===`);
    lines.push(...buildDiffLines(change.originalContent ?? "", change.proposedContent));
    lines.push("");
  }

  return lines.length > 0 ? lines : ["@@", "  (no visible file changes)"];
}

function buildDiffLines(original: string, proposed: string): string[] {
  const patch = structuredPatch("current", "proposed", original, proposed, "", "", { context: REVIEW_DIFF_CONTEXT_LINES });
  const lines = ["--- current", "+++ proposed"];

  if (patch.hunks.length === 0) {
    return [...lines, "@@", "  (no visible line changes)"];
  }

  for (const hunk of patch.hunks) {
    lines.push(`@@ ${formatUnifiedRange("-", hunk.oldStart, hunk.oldLines)} ${formatUnifiedRange("+", hunk.newStart, hunk.newLines)} @@`);
    lines.push(...hunk.lines.map(formatDiffDisplayLine));
  }

  return lines;
}

function formatUnifiedRange(prefix: "-" | "+", start: number, count: number): string {
  if (count === 0) return `${prefix}${start},0`;
  if (count === 1) return `${prefix}${start}`;
  return `${prefix}${start},${count}`;
}

function formatDiffDisplayLine(line: string): string {
  if (line.startsWith("+")) return `+ ${line.slice(1)}`;
  if (line.startsWith("-")) return `- ${line.slice(1)}`;
  if (line.startsWith(" ")) return `  ${line.slice(1)}`;
  if (line.startsWith("\\")) return `  ${line}`;
  return line;
}
