import { git as realGit, type GitFn } from "../repo/git.js";

/** Pathspecs excluded when reviewing *code*: spec artefacts and agent scaffolding are reviewed elsewhere. */
export const NON_CODE = [":(exclude)specs", ":(exclude).specify", ":(exclude).claude"];

export async function changedFiles(wt: string, base: string, opts: { code?: boolean } = {}, git: GitFn = realGit): Promise<string[]> {
  const out = await git(wt, ["diff", "--name-only", "-z", `${base}...HEAD`, "--", ".", ...(opts.code ? NON_CODE : [])]);
  return out.split("\0").filter(Boolean).sort();
}

export interface DiffText { text: string; files: string[]; truncated: boolean; stat: string }

/** The implementation's diff (code only) bounded for use in a prompt. */
export async function codeDiff(wt: string, base: string, maxChars = 60_000, git: GitFn = realGit): Promise<DiffText> {
  const files = await changedFiles(wt, base, { code: true }, git);
  const stat = files.length ? await git(wt, ["diff", "--stat", `${base}...HEAD`, "--", ".", ...NON_CODE]) : "";
  const full = files.length ? await git(wt, ["diff", "--no-color", "--unified=4", `${base}...HEAD`, "--", ".", ...NON_CODE], { timeoutMs: 120_000 }) : "";
  return { text: full.length > maxChars ? `${full.slice(0, maxChars)}\n…[diff truncated: ${full.length - maxChars} more chars; see the files directly]` : full, files, truncated: full.length > maxChars, stat };
}

/** Added lines only (what a secret scanner should look at). */
export const addedLines = (diff: string): string[] => diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));

/** Added lines with the file each belongs to (from the `+++ b/<path>` headers), so a scanner can treat test files differently. */
export const addedLinesByFile = (diff: string): { file: string; line: string }[] => {
  const out: { file: string; line: string }[] = [];
  let file = "";
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) file = l.startsWith("+++ b/") ? l.slice(6).replace(/\t.*$/, "") : "";
    else if (l.startsWith("+")) out.push({ file, line: l.slice(1) });
  }
  return out;
};

/**
 * Added lines across EVERY commit on the branch (not just the net diff). A secret committed and then deleted in a
 * later commit is still in history and would be published with the branch, so history is what must be clean.
 */
export async function historyAddedLines(wt: string, base: string, git: GitFn = realGit): Promise<{ file: string; line: string }[]> {
  const log = await git(wt, ["log", "-p", "--no-color", "--format=", `${base}..HEAD`, "--", ".", ":(exclude)specs"], { timeoutMs: 120_000 });
  return addedLinesByFile(log);
}
