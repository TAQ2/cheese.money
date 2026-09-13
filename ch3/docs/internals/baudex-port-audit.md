# What the BauDex port left behind

CH3 was ported from a further-along fork of the same tree. Every gate that ran during
that port — typecheck, 6,800 tests, a blind QA pass — reads the diff that exists, and an
absent feature leaves no line in a diff. Three features were found missing only because
somebody asked about them by name: the Maple model catalogue, the Maple pricing colours,
and `spawn_model_agent`. This file exists so the next one is found by running a command.

Regenerate the raw lists with `node scripts/port-audit.ts` (add `--json` for machine
output). It compares against refs kept in this repository — `refs/port/base` (`23102fa`,
the common ancestor), `refs/port/baudex` (`fe4e12d`, the other fork) and
`refs/port/ch3-pre` (`e573b5d`, this fork before the port). They were fetched out of a
scratch clone in `/tmp` that would not have survived a reboot.

**Every line the script prints must appear below with a verdict.** A line that does not
is an unanswered question, not an omission.

## What this can and cannot see

Two axes, both mechanical:

- **Files** the other fork tracks that do not exist here.
- **Exported names**, for files both forks carry, that the other fork exports and this
  one does not. That is what catches a file taken in part — a component deleted from a
  module that was otherwise ported, which is exactly how the `spawn_model_agent` card
  went missing while the tool it renders was never brought over either.

Neither axis sees a behaviour deleted from inside a function whose name still exists.
That gap is real and nothing here closes it; what these guarantee is that no whole file
and no exported surface disappears unnoticed.

## Verdicts, as of 2026-09-13

| Verdict   | Files | Meaning                                                     |
| --------- | ----- | ----------------------------------------------------------- |
| Cockpit   | 48    | The orchestrator cockpit, deliberately unported             |
| Corporate | 102   | Belongs to the other fork's employer, deliberately stripped |
| Rejected  | 28    | Judged not worth having here, with a reason                 |
| Open      | 48    | No decision yet — the queue below                           |

The 48 open files are six features, not forty-eight decisions.

## Open questions

These are the only rows that could still turn into "you never ported X". Each is a
feature, with what it does and what it would cost.

### Maple runtime beyond the catalogue (24 files)

- `apps/server/src/provider/maple/MapleActivation.test.ts`
- `apps/server/src/provider/maple/MapleActivation.ts`
- `apps/server/src/provider/maple/MapleKeyVault.test.ts`
- `apps/server/src/provider/maple/MapleKeyVault.ts`
- `apps/server/src/provider/maple/MapleProxySupervisor.test.ts`
- `apps/server/src/provider/maple/MapleProxySupervisor.ts`
- `apps/server/src/provider/maple/README.md`
- `apps/server/src/provider/maple/mapleProxyState.ts`
- `apps/server/src/provider/maple/mapleUpstreamRejection.test.ts`
- `apps/server/src/provider/maple/mapleUpstreamRejection.ts`
- `apps/web/src/components/auth/MapleVaultUnlock.tsx`
- `apps/web/src/components/settings/MapleProviderStatus.logic.test.ts`
- `apps/web/src/components/settings/MapleProviderStatus.logic.ts`
- `apps/web/src/components/settings/MapleProviderStatus.tsx`
- `apps/web/src/state/maple.ts`
- `native/maple-proxy/Cargo.lock`
- `native/maple-proxy/Cargo.toml`
- `native/maple-proxy/src/main.rs`
- `packages/client-runtime/src/state/maple.ts`
- `packages/contracts/src/maple.ts`
- `packages/shared/src/mapleAccountFailover.test.ts`
- `packages/shared/src/mapleAccountFailover.ts`
- `packages/shared/src/mapleKeyVault.test.ts`
- `packages/shared/src/mapleKeyVault.ts`

### The MCP shelf (12 files)

- `apps/server/src/mcp/ClaudeMcpConfigChange.test.ts`
- `apps/server/src/mcp/ClaudeMcpConfigChange.ts`
- `apps/server/src/mcp/mcpListOutput.test.ts`
- `apps/server/src/mcp/mcpListOutput.ts`
- `apps/server/src/mcp/mcpLoginOutput.test.ts`
- `apps/server/src/mcp/mcpLoginOutput.ts`
- `apps/web/src/components/mcp/McpCatalog.test.tsx`
- `apps/web/src/components/mcp/McpCatalog.tsx`
- `apps/web/src/routes/_chat.mcp.tsx`
- `apps/web/src/state/mcpCatalog.ts`
- `packages/client-runtime/src/state/mcpCatalog.ts`
- `packages/contracts/src/mcpCatalog.ts`

### The skills catalogue (5 files)

- `apps/server/src/skills/SkillCatalog.test.ts`
- `apps/server/src/skills/SkillCatalog.ts`
- `apps/web/src/state/skills.ts`
- `packages/client-runtime/src/state/skills.ts`
- `packages/contracts/src/skills.ts`

### CI workflow split (5 files)

- `.github/workflows/build-dmg.yml`
- `.github/workflows/ci-coverage.yml`
- `.github/workflows/ci-e2e-tests.yml`
- `.github/workflows/ci-pre-commit-checks.yml`
- `.github/workflows/ci-test.yml`

### OpenCode user guide and driver test (2 files)

- `apps/server/src/provider/Drivers/OpenCodeDriver.test.ts`
- `docs/user/providers-opencode.md`

### Recommendations

**Maple runtime.** `MapleKeyVault`, `mapleKeyVault` and `MapleVaultUnlock` are the sealed
1Password vault and stay out — a plain setting replaces them, and this machine already
supplies `MAPLE_API_KEY` from the environment. The rest is not corporate:
`MapleActivation` reports the three independent things that must be true before a Maple
request can work, `mapleUpstreamRejection` classifies an exhausted account out of an
upstream error, `MapleProxySupervisor` starts and watches the proxy, and
`MapleProviderStatus` is the panel that shows all of it. That panel's health check reads
the body of `/health` rather than its status code, which is the precise failure that
took an hour on 2026-09-13: a Docker container answering `200 {"service":"whapi-mock"}`
on port 8080 was indistinguishable from the real proxy to CH3, to `start-proxy.sh
--status`, and to me. **Recommend porting the activation, rejection and status surface,
minus the vault row.** `mapleAccountFailover` assumes two Maple subscriptions and is a
separate decision. `native/maple-proxy` is a 3-file MIT wrapper crate; the built binary
already lives at `~/Desktop/maple-stack/bin/maple-proxy`, so bringing the crate only
matters if the DMG should ship its own.

**The MCP shelf.** A catalogue UI at `/mcp` plus the plumbing that makes it work:
parsing `claude mcp list` and the authorization URL out of `claude mcp login
--no-browser`, and applying config changes. `BaubapMcpCatalog` is their server list and
stays out; the shelf itself is generic. The route was deleted from this fork, which is
why `routeTree.gen.ts` had to be regenerated in `dc692df`. **Recommend porting it with
an empty catalogue** — there is no other way to sign an MCP server in from inside CH3.

**The skills catalogue.** Reads and writes `~/.claude/skills`. Needs reading before a
verdict: if it is a browser over whatever skills exist, it is generic and worth having;
if it seeds a fixed list, it is theirs. **No recommendation yet.**

**CI workflow split.** Five workflows that split what `ci.yml` does here into
pre-commit checks, tests, coverage, e2e and a DMG build. `vite.config.ts` and
`docs/internals/scripts.md` in this fork referred to `ci-pre-commit-checks.yml` until
`6abd304` corrected them, which is the tell that the split was half-inherited.
**Low priority; matters only when CI runs on this repo.**

**OpenCode user guide.** `docs/user/providers-opencode.md` is linked from `README.md`
and does not exist here — one of the dangling links the QA pass reported.
**Recommend porting it, de-corporatised.** `OpenCodeDriver.test.ts` covers the account
failover wiring, so it follows the Maple failover decision.

## Cockpit — deliberately unported (48 files)

The orchestrator cockpit, roughly 11,000 lines: run panes, lead-agent RPCs, script
discovery pointed at a directory this machine does not have, and forms that read the
removed tier policy. `codingRunDraftStore` is the draft store for its New coding run
form, and `docs/internals/bizorch-mcp-preflight.md` documents its preflight.

- `apps/server/src/orchestrator/Manager.test.ts`
- `apps/server/src/orchestrator/Manager.ts`
- `apps/server/src/orchestrator/README.md`
- `apps/server/src/orchestrator/RunLeaseDaemon.test.ts`
- `apps/server/src/orchestrator/RunLeaseDaemon.ts`
- `apps/server/src/orchestrator/leadAgent.test.ts`
- `apps/server/src/orchestrator/leadAgent.ts`
- `apps/server/src/orchestrator/transcript.test.ts`
- `apps/server/src/orchestrator/transcript.ts`
- `apps/server/src/orchestrator/watchDirectory.test.ts`
- `apps/server/src/orchestrator/watchDirectory.ts`
- `apps/web/src/codingRunDraftStore.test.ts`
- `apps/web/src/codingRunDraftStore.ts`
- `apps/web/src/components/orchestrator/CodingRunForm.tsx`
- `apps/web/src/components/orchestrator/LeadAgentAction.tsx`
- `apps/web/src/components/orchestrator/OrchestratorCheckpointPanel.tsx`
- `apps/web/src/components/orchestrator/OrchestratorConversation.tsx`
- `apps/web/src/components/orchestrator/OrchestratorMark.tsx`
- `apps/web/src/components/orchestrator/OrchestratorProblemForm.test.ts`
- `apps/web/src/components/orchestrator/OrchestratorProblemForm.tsx`
- `apps/web/src/components/orchestrator/OrchestratorRunSession.tsx`
- `apps/web/src/components/orchestrator/OrchestratorStageRail.tsx`
- `apps/web/src/components/orchestrator/OrchestratorThreadView.tsx`
- `apps/web/src/components/orchestrator/__fixtures__/run.happy-path.jsonl`
- `apps/web/src/components/orchestrator/__fixtures__/run.short-circuit.jsonl`
- `apps/web/src/components/orchestrator/codingRunRepositories.test.ts`
- `apps/web/src/components/orchestrator/codingRunRepositories.ts`
- `apps/web/src/components/orchestrator/leadAgentConversation.test.ts`
- `apps/web/src/components/orchestrator/leadAgentConversation.ts`
- `apps/web/src/components/orchestrator/orchestratorResumeFeedback.test.ts`
- `apps/web/src/components/orchestrator/orchestratorResumeFeedback.ts`
- `apps/web/src/components/orchestrator/orchestratorSession.test.ts`
- `apps/web/src/components/orchestrator/orchestratorSession.ts`
- `apps/web/src/components/orchestrator/orchestratorThreadStart.test.ts`
- `apps/web/src/components/orchestrator/orchestratorThreadStart.ts`
- `apps/web/src/components/orchestrator/orchestratorThreadView.logic.test.ts`
- `apps/web/src/components/orchestrator/orchestratorThreadView.logic.ts`
- `apps/web/src/components/orchestrator/useLeadAgentConversation.ts`
- `apps/web/src/components/orchestrator/useOrchestratorProject.ts`
- `apps/web/src/components/orchestrator/useOrchestratorThreadStart.ts`
- `apps/web/src/orchestratorPanesStore.ts`
- `apps/web/src/state/orchestrator.ts`
- `docs/internals/bizorch-mcp-preflight.md`
- `docs/internals/business-orchestrator-integration.md`
- `packages/client-runtime/src/state/orchestrator.ts`
- `packages/contracts/src/orchestrator.ts`
- `packages/shared/src/orchestratorModels.test.ts`
- `packages/shared/src/orchestratorModels.ts`

## Corporate — deliberately stripped (102 files)

The other fork's employer: Google Workspace sign-in with its sealed Gmail credential,
the 1Password sealing scripts and the secrets they unseal, the hard-coded account roster
with its shared Fable pool and hide-outside-Mexico rule, the model-access tiers and the
metering ledger, the seeded "superpower" default projects, private repository discovery
and the monogram table naming ~40 of their repos, the GitHub contribution toolkit that
files issues on their repo, and the user docs for onboarding their team.

- `apps/desktop/scripts/workspace-sign-in-harness.cjs`
- `apps/desktop/src/auth/DesktopWorkspaceSession.ts`
- `apps/desktop/src/auth/GmailCredentialStore.test.ts`
- `apps/desktop/src/auth/GmailCredentialStore.ts`
- `apps/desktop/src/auth/GmailMailbox.ts`
- `apps/desktop/src/auth/GoogleWorkspaceAuth.test.ts`
- `apps/desktop/src/auth/GoogleWorkspaceAuth.ts`
- `apps/desktop/src/auth/README.md`
- `apps/desktop/src/auth/sealedGmailCredential.json`
- `apps/desktop/src/ipc/methods/workspaceAuth.test.ts`
- `apps/desktop/src/ipc/methods/workspaceAuth.ts`
- `apps/server/src/auth/README.md`
- `apps/server/src/auth/WorkspaceIdentity.test.ts`
- `apps/server/src/auth/WorkspaceIdentity.ts`
- `apps/server/src/contribution/GithubContributions.test.ts`
- `apps/server/src/contribution/GithubContributions.ts`
- `apps/server/src/github/GithubIdentity.test.ts`
- `apps/server/src/github/GithubIdentity.ts`
- `apps/server/src/github/gitCredentialEnvironment.test.ts`
- `apps/server/src/github/gitCredentialEnvironment.ts`
- `apps/server/src/mcp/BaubapMcpCatalog.test.ts`
- `apps/server/src/mcp/BaubapMcpCatalog.ts`
- `apps/server/src/mcp/toolkits/contribution/handlers.test.ts`
- `apps/server/src/mcp/toolkits/contribution/handlers.ts`
- `apps/server/src/mcp/toolkits/contribution/tools.ts`
- `apps/server/src/persistence/MeteredModelUse.test.ts`
- `apps/server/src/persistence/MeteredModelUse.ts`
- `apps/server/src/persistence/Migrations/037_MeteredModelUse.ts`
- `apps/server/src/project/BaubapRepositoryDiscovery.test.ts`
- `apps/server/src/project/BaubapRepositoryDiscovery.ts`
- `apps/server/src/project/DefaultProjectLocator.ts`
- `apps/server/src/project/DefaultProjectSites.test.ts`
- `apps/server/src/project/DefaultProjectSites.ts`
- `apps/server/src/project/DefaultProjects.test.ts`
- `apps/server/src/project/DefaultProjects.ts`
- `apps/server/src/project/DefaultProjectsSeed.ts`
- `apps/server/src/project/ManagedClones.test.ts`
- `apps/server/src/project/ManagedClones.ts`
- `apps/server/src/project/defaultProjectsPresence.test.ts`
- `apps/server/src/provider/maple/sealedMapleKeys.json`
- `apps/server/src/secrets/BundleDecryptKey.test.ts`
- `apps/server/src/secrets/BundleDecryptKey.ts`
- `apps/server/src/secrets/GithubTokenVault.test.ts`
- `apps/server/src/secrets/GithubTokenVault.ts`
- `apps/server/src/secrets/sealedGithubToken.json`
- `apps/web/src/components/DiscoverProjectsDialog.tsx`
- `apps/web/src/components/ProjectFavicon.test.tsx`
- `apps/web/src/components/RepositoryMonogram.test.tsx`
- `apps/web/src/components/RepositoryMonogram.tsx`
- `apps/web/src/components/auth/SealedContentUnlock.tsx`
- `apps/web/src/components/auth/VpnRecommendationDialog.tsx`
- `apps/web/src/components/auth/WorkspaceAccessGate.tsx`
- `apps/web/src/components/auth/sealedContentGate.logic.test.ts`
- `apps/web/src/components/auth/sealedContentGate.logic.ts`
- `apps/web/src/components/chat/MeteredModelDialog.logic.test.ts`
- `apps/web/src/components/chat/MeteredModelDialog.logic.ts`
- `apps/web/src/components/chat/MeteredModelDialog.tsx`
- `apps/web/src/components/defaultProjects/DefaultProjectsRail.tsx`
- `apps/web/src/components/defaultProjects/ProjectLauncher.tsx`
- `apps/web/src/components/defaultProjects/SkillsCatalog.test.tsx`
- `apps/web/src/components/defaultProjects/SkillsCatalog.tsx`
- `apps/web/src/components/defaultProjects/launchActions.test.ts`
- `apps/web/src/components/defaultProjects/launchActions.ts`
- `apps/web/src/components/defaultProjects/requiredModel.logic.test.ts`
- `apps/web/src/components/defaultProjects/requiredModel.logic.ts`
- `apps/web/src/components/defaultProjects/skillSections.logic.test.ts`
- `apps/web/src/components/defaultProjects/skillSections.logic.ts`
- `apps/web/src/components/defaultProjects/useDefaultProjectKind.ts`
- `apps/web/src/components/defaultProjects/useProjectLaunch.ts`
- `apps/web/src/components/mcp/mcpShelfMonogram.ts`
- `apps/web/src/defaultProjectsStore.test.ts`
- `apps/web/src/defaultProjectsStore.ts`
- `apps/web/src/state/meteringAccount.ts`
- `apps/web/src/state/modelAccess.ts`
- `apps/web/src/state/sealedContent.ts`
- `docs/internals/github-repository-access.md`
- `docs/operations/ch3-keyring-setup.md`
- `docs/security/fork-provenance-audit.md`
- `docs/user/baubap-projects.md`
- `docs/user/discover-baubap-projects.md`
- `docs/user/model-access.md`
- `docs/user/onboarding-baubap-team.md`
- `packages/contracts/src/workspaceAccess.ts`
- `packages/shared/src/baubapMcp.test.ts`
- `packages/shared/src/baubapMcp.ts`
- `packages/shared/src/claudeAccountRoster.test.ts`
- `packages/shared/src/claudeAccountRoster.ts`
- `packages/shared/src/defaultProjects.test.ts`
- `packages/shared/src/defaultProjects.ts`
- `packages/shared/src/githubTokenVault.test.ts`
- `packages/shared/src/githubTokenVault.ts`
- `packages/shared/src/gmailCredentialVault.test.ts`
- `packages/shared/src/gmailCredentialVault.ts`
- `packages/shared/src/modelAccess.test.ts`
- `packages/shared/src/modelAccess.ts`
- `packages/shared/src/workspaceAccess.test.ts`
- `packages/shared/src/workspaceAccess.ts`
- `scripts/lib/one-password.ts`
- `scripts/seal-github-token.ts`
- `scripts/seal-gmail-credential.ts`
- `scripts/seal-maple-keys.ts`
- `scripts/verify-github-token.ts`

## Rejected with a reason (28 files)

- **Automated Claude sign-in** (`claudeAutoSignIn*`, `claudeSignInAutomation*`,
  `claudeMagicLink*`, the sign-in harness): needs a special token for hard-coded
  accounts, and was refused outright when the port was specified.
- **Private release channel** (`CH3Installer*`, `githubUpdateToken*`, `installScript*`,
  `install.sh`): downloads a release from a private repository with a sealed token.
- **`migrateLegacyStorageKeys.ts`**: provably a no-op here — both its prefixes are the
  same string after the brand rename, so its loop always continues. Deleted in `6abd304`.
- **`scripts/mobile-showcase-environment.ts`**: byte-identical duplicate of
  `showcase-environment.ts`, collapsed into one seeder in `6abd304`.
- **Their repository furniture**: `CLAUDE.md`, `CH3-SYNC.md`, `.plans/`, their agent
  documents, CODEOWNERS, PR template and the PR-description workflow.

- `.github/CODEOWNERS`
- `.github/pull_request_template.md`
- `.github/workflows/ci.yaml`
- `.github/workflows/pr-description.yml`
- `.plans/stability-macos-audit.md`
- `.plans/subtractive-pass.md`
- `CH3-SYNC.md`
- `CLAUDE.md`
- `LLM coding agent documents/CH3 Brain Agent.md`
- `LLM coding agent documents/CH3 Coding Agent.md`
- `LLM coding agent documents/STACKED_PR_MERGE_PLAYBOOK.md`
- `LLM coding agent documents/TEST_DOCUMENTATION.md`
- `apps/desktop/scripts/claude-sign-in-flow-harness.cjs`
- `apps/desktop/src/auth/claudeMagicLink.test.ts`
- `apps/desktop/src/auth/claudeMagicLink.ts`
- `apps/desktop/src/updates/CH3Installer.test.ts`
- `apps/desktop/src/updates/CH3Installer.ts`
- `apps/desktop/src/updates/githubUpdateToken.test.ts`
- `apps/desktop/src/updates/githubUpdateToken.ts`
- `apps/desktop/src/updates/installScript.test.ts`
- `apps/desktop/src/window/claudeAutoSignIn.test.ts`
- `apps/desktop/src/window/claudeAutoSignIn.ts`
- `apps/desktop/src/window/claudeAutoSignInPort.ts`
- `apps/desktop/src/window/claudeSignInAutomation.test.ts`
- `apps/desktop/src/window/claudeSignInAutomation.ts`
- `apps/web/src/migrateLegacyStorageKeys.ts`
- `install.sh`
- `scripts/mobile-showcase-environment.ts`

## Exported names absent from files both forks carry (61 across 19 files)

All 61 are accounted for by the verdicts above, with three exceptions worth stating:

- `CH3_MCP_TOOL_TIMEOUT_MS` and `CH3_CODEX_LAUNCH_ARGS_ENV` are **renames**, not
  absences: this fork uses the `CH3CODE_` namespace for its own runtime variables, and
  conflating the two namespaces is what leaked the server's whole environment into every
  terminal until `24109eb`. Likewise `MINIMUM_CLAUDE_FABLE_5_1_VERSION` is
  `MINIMUM_CLAUDE_FABLE_VERSION` here.
- `PACKAGED_BUILD_INPUTS`, `describePackagedBuildConfig`, `PackagedBuildConfigReport` and
  `IncompletePackagedBuildConfigError` were **deleted on purpose**: the gate only makes
  sense for an artifact carrying mandatory baked secrets, and this one carries none.
- `getAutoUpdateDisabledReason` belongs to the private release channel above.

- `packages/contracts/src/rpc.ts` — MeteredModelUseRecord, WsMapleUnlockRpc, WsOrchestratorAbortRunRpc, WsOrchestratorAnswerCheckpointRpc, WsOrchestratorLeadAgentRpc, WsOrchestratorListRunsRpc, WsOrchestratorReadFileRpc, WsOrchestratorRepositoryBranchesRpc, WsOrchestratorResumeRunRpc, WsOrchestratorStartRunRpc, WsOrchestratorStatusRpc, WsProjectsDiscoverBaubapRepositoriesRpc, WsServerRecordMeteredModelUseRpc, WsSkillsInstallRpc, WsSkillsListRpc, WsSkillsRemoveRpc, WsSubscribeOrchestratorEventsRpc, WsSubscribeOrchestratorTranscriptRpc, WsWorkspaceGithubIdentityRpc, WsWorkspaceListDefaultProjectsRpc, WsWorkspaceMcpCatalogRpc, WsWorkspaceMcpInstallRpc, WsWorkspaceMcpRemoveRpc, WsWorkspaceMcpServerActionRpc, WsWorkspaceProbeKeyEndpointRpc, WsWorkspaceRefreshDefaultProjectsRpc, WsWorkspaceUnlockSealedContentRpc
- `apps/desktop/src/ipc/channels.ts` — CLAUDE_SIGN_IN_HANDOFF_CHANNEL, CLAUDE_SIGN_IN_MAILBOX_STATUS_CHANNEL, WORKSPACE_SESSION_RESTORE_CHANNEL, WORKSPACE_SIGN_IN_CHANNEL
- `packages/contracts/src/project.ts` — BaubapRepositoryCandidate, ProjectDiscoverBaubapRepositoriesError, ProjectDiscoverBaubapRepositoriesInput, ProjectDiscoverBaubapRepositoriesResult
- `apps/desktop/src/window/claudeSignInFlow.ts` — CLAUDE_AUTO_SIGN_IN_HANDOFF_MS, CLAUDE_AUTO_SIGN_IN_HANDOFF_TIMEOUT_DETAIL, CLAUDE_OAUTH_AUTOMATED_CLOSE_DELAY_MS
- `apps/web/src/components/settings/ClaudeAccountSwitcher.logic.ts` — fablePoolRowLock, withReclaimedRosterSlots, withoutDuplicateRosterSlots
- `apps/web/src/state/projects.ts` — projectDiscoverBaubapRepositories, workspaceDefaultProjects, workspaceDefaultProjectsRefresh
- `scripts/lib/public-config.ts` — PACKAGED_BUILD_INPUTS, PackagedBuildConfigReport, describePackagedBuildConfig
- `apps/web/src/components/Icons.tsx` — BaubapIcon, MapleIcon
- `packages/contracts/src/claudeAccounts.ts` — ClaudeSignInHandoff, ClaudeSignInMailboxStatus
- `apps/desktop/src/ipc/methods/claudeSignIn.ts` — claudeSignInMailboxStatus
- `apps/desktop/src/updates/DesktopUpdates.ts` — getAutoUpdateDisabledReason
- `apps/server/src/config.ts` — GoogleWorkspaceClient
- `apps/server/src/mcp/McpHttpServer.ts` — ContributionToolkitRegistrationLive
- `apps/server/src/mcp/McpProviderSession.ts` — CH3_MCP_TOOL_TIMEOUT_MS
- `apps/server/src/provider/Layers/ClaudeProvider.ts` — MINIMUM_CLAUDE_FABLE_5_1_VERSION
- `apps/server/src/provider/Layers/codexLaunchArgs.ts` — CH3_CODEX_LAUNCH_ARGS_ENV
- `apps/server/src/ws.ts` — unlockSealedContent
- `packages/shared/src/git.ts` — isBaubapRepositoryCanonicalKey
- `scripts/build-desktop-artifact.ts` — IncompletePackagedBuildConfigError

## Keeping this true

Run `node scripts/port-audit.ts` after any port work. Anything it prints that is not in
this file is undecided; anything decided moves to the section that matches, with the
reason written in the same sentence. When a feature is ported, its rows leave this file
entirely — the script stops printing them.
