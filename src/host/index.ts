import type { LoadedConfig, ProjectConfig } from "../config/schema.js";
import { bbStore, gitEnv as bbGitEnv, resolveCredential } from "../bitbucket/auth.js";
import { createBitbucketClient, type BitbucketClient } from "../bitbucket/client.js";
import type { SecretStore } from "../jira/auth.js";
import { createGhClient, type GitHubClient } from "../github/client.js";
import { gitAuthEnv } from "../repo/gh.js";
import { git as realGit, type GitFn } from "../repo/git.js";
import { checkBranchProtection, createGhApi, parseRemote, type Protection } from "../repo/inspect.js";

export type HostKind = "github" | "bitbucket";
export const hostName = (k: HostKind) => (k === "bitbucket" ? "Bitbucket" : "GitHub");

/**
 * Where a project's code is hosted, and everything the factory does there: clone and push (git over HTTPS with the right credentials), open
 * and watch pull requests, and read branch protection. Each project chooses GitHub or Bitbucket, so a home project and a work project can
 * differ. GitHub goes through the gh CLI as the project's account; Bitbucket through its REST API with a token from the keychain.
 * Nothing here merges anything.
 */
export interface Hosts {
  kind(p: ProjectConfig): HostKind;
  /** owner/name (GitHub) or workspace/slug (Bitbucket): from config for a managed clone, else from the checkout's origin remote. */
  slug(p: ProjectConfig, git?: GitFn): Promise<string>;
  cloneUrl(p: ProjectConfig): string;
  gitAuth(p: ProjectConfig): Promise<NodeJS.ProcessEnv | undefined>;
  pr(p: ProjectConfig): GitHubClient;
  protection(p: ProjectConfig, slug: string): Promise<Protection>;
}

export const configuredSlug = (p: ProjectConfig): string | undefined => (p.host === "bitbucket" ? p.bitbucket.repo : p.github.repo);

export function createHosts(config: Pick<LoadedConfig, "bitbucket">, deps: { store?: SecretStore; fetch?: typeof fetch; bbApiBase?: string; gh?: (p: ProjectConfig) => GitHubClient } = {}): Hosts {
  const store = deps.store ?? bbStore(config.bitbucket.keychainService);
  const bb = new Map<string, BitbucketClient>();
  const bbClient = (p: ProjectConfig): BitbucketClient => {
    const name = p.bitbucket.credential;
    const credential = resolveCredential(config, name, store); // read every time, so a replaced token takes effect on the next call
    const key = `${name}|${credential.kind}|${credential.email ?? ""}|${credential.token}`;
    const hit = bb.get(key);
    if (hit) return hit;
    const c = createBitbucketClient({ credential, fetch: deps.fetch, apiBase: deps.bbApiBase });
    bb.clear(); bb.set(key, c);
    return c;
  };
  return {
    kind: (p) => p.host,
    async slug(p, git = realGit) {
      const configured = configuredSlug(p);
      if (configured) return configured;
      const parsed = parseRemote(await git(p.repository, ["remote", "get-url", "origin"]));
      const s = p.host === "bitbucket" ? parsed.bitbucket : parsed.github;
      if (!s) throw new Error(`cannot determine the ${hostName(p.host)} repository for ${p.id} from its origin remote`);
      return `${s.owner}/${s.repo}`;
    },
    cloneUrl: (p) => `https://${p.host === "bitbucket" ? "bitbucket.org" : "github.com"}/${configuredSlug(p)}.git`,
    async gitAuth(p) {
      if (p.host === "bitbucket") return bbGitEnv(resolveCredential(config, p.bitbucket.credential, store));
      return gitAuthEnv(p.github.account);
    },
    pr: (p) => (p.host === "bitbucket" ? bbClient(p) : deps.gh ? deps.gh(p) : createGhClient({ account: p.github.account })),
    async protection(p, slug) {
      if (p.host === "bitbucket") return bbClient(p).protection(slug, p.defaultBranch);
      const [owner, repo] = slug.split("/") as [string, string];
      return checkBranchProtection({ owner, repo }, p.defaultBranch, createGhApi(p.github.account));
    },
  };
}
