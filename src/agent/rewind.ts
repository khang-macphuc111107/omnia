import type { FileRestoreReport } from "./types";

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** One-paragraph, honest summary of a file restore for the transcript. */
export function summarizeRestore(report: FileRestoreReport): string {
  const parts: string[] = [];
  if (report.restored.length) parts.push(`restored ${count(report.restored.length, "file")}`);
  if (report.deleted.length) parts.push(`deleted ${count(report.deleted.length, "file")} created in the rewound turns`);
  if (report.skippedTooLarge.length) parts.push(`${count(report.skippedTooLarge.length, "file")} too large to restore`);
  if (report.failed.length) parts.push(`${count(report.failed.length, "file")} failed to restore`);
  const head = parts.length ? `Rewound conversation and files: ${parts.join(", ")}.` : "Rewound conversation; no tracked file changes to restore.";
  return `${head} ${report.untrackedNote}`.trim();
}
