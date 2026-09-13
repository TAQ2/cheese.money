import type { GitRunStackedActionResult, VcsStatusResult } from "@ch3tools/contracts";
import { WORKTREE_BRANCH_PREFIX } from "@ch3tools/shared/git";
import { describe, expect, it } from "@effect/vitest";

import {
  buildGitActionProgressStages,
  buildMenuItems,
  getGitActionDisabledReason,
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  resolveLiveThreadBranchUpdate,
  resolveQuickAction,
  resolveThreadBranchUpdate,
  type GitActionMenuItem,
} from "./gitActions.ts";

const temporaryBranch = `${WORKTREE_BRANCH_PREFIX}/deadbeef`;

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/x",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

const openPr = {
  number: 12,
  title: "Add a thing",
  url: "https://github.com/ch3/ch3/pull/12",
  baseRef: "main",
  headRef: "feature/x",
  state: "open",
} as const;

const mergedPr = { ...openPr, state: "merged" } as const;

function menuItem(id: GitActionMenuItem["id"], disabled = true): GitActionMenuItem {
  return { id, label: id, disabled, icon: "commit", kind: "open_dialog" };
}

function stackedResult(
  overrides: Partial<GitRunStackedActionResult> = {},
): GitRunStackedActionResult {
  return {
    action: "commit",
    branch: { status: "skipped_not_requested" },
    commit: { status: "created" },
    push: { status: "skipped_not_requested" },
    pr: { status: "skipped_not_requested" },
    toast: { kind: "none", title: "Committed" },
    ...overrides,
  } as GitRunStackedActionResult;
}

describe("buildGitActionProgressStages", () => {
  it("shows only the push stage for a bare push, named after the resolved target", () => {
    expect(
      buildGitActionProgressStages({
        action: "push",
        hasCustomCommitMessage: false,
        hasWorkingTreeChanges: true,
        pushTarget: "origin/feature/x",
      }),
    ).toEqual(["Pushing to origin/feature/x..."]);
  });

  it("falls back to an unqualified push stage when no target is known", () => {
    expect(
      buildGitActionProgressStages({
        action: "push",
        hasCustomCommitMessage: false,
        hasWorkingTreeChanges: false,
      }),
    ).toEqual(["Pushing..."]);
  });

  it("omits the push stage from create_pr when the branch is already published", () => {
    expect(
      buildGitActionProgressStages({
        action: "create_pr",
        hasCustomCommitMessage: false,
        hasWorkingTreeChanges: false,
        pushTarget: "origin/feature/x",
        shouldPushBeforePr: false,
      }),
    ).toEqual(["Preparing PR...", "Generating PR content...", "Creating GitHub pull request..."]);
  });

  it("prepends the push stage to create_pr when the branch must be published first", () => {
    expect(
      buildGitActionProgressStages({
        action: "create_pr",
        hasCustomCommitMessage: false,
        hasWorkingTreeChanges: false,
        pushTarget: "origin/feature/x",
        shouldPushBeforePr: true,
      }),
    ).toEqual([
      "Pushing to origin/feature/x...",
      "Preparing PR...",
      "Generating PR content...",
      "Creating GitHub pull request...",
    ]);
  });

  it("drops the message-generation stage when the user supplied a commit message", () => {
    expect(
      buildGitActionProgressStages({
        action: "commit",
        hasCustomCommitMessage: true,
        hasWorkingTreeChanges: true,
      }),
    ).toEqual(["Committing..."]);
  });

  it("keeps the commit stages for an explicit commit even with a clean worktree", () => {
    expect(
      buildGitActionProgressStages({
        action: "commit",
        hasCustomCommitMessage: false,
        hasWorkingTreeChanges: false,
      }),
    ).toEqual(["Generating commit message...", "Committing..."]);
  });

  it("prefixes the feature-branch stage when a branch will be created", () => {
    expect(
      buildGitActionProgressStages({
        action: "commit",
        hasCustomCommitMessage: true,
        hasWorkingTreeChanges: true,
        featureBranch: true,
      }),
    ).toEqual(["Preparing feature branch...", "Committing..."]);
  });

  it("skips the commit stages of commit_push when there is nothing to commit", () => {
    expect(
      buildGitActionProgressStages({
        action: "commit_push",
        hasCustomCommitMessage: false,
        hasWorkingTreeChanges: false,
        pushTarget: "origin/feature/x",
      }),
    ).toEqual(["Pushing to origin/feature/x..."]);
  });

  it("lists branch, commit, push and PR stages in order for commit_push_pr", () => {
    expect(
      buildGitActionProgressStages({
        action: "commit_push_pr",
        hasCustomCommitMessage: false,
        hasWorkingTreeChanges: true,
        pushTarget: "origin/feature/x",
        featureBranch: true,
      }),
    ).toEqual([
      "Preparing feature branch...",
      "Generating commit message...",
      "Committing...",
      "Pushing to origin/feature/x...",
      "Preparing PR...",
      "Generating PR content...",
      "Creating GitHub pull request...",
    ]);
  });
});

describe("buildMenuItems", () => {
  it("returns no items at all when git status has not loaded", () => {
    expect(buildMenuItems(null, false)).toEqual([]);
  });

  it("disables every item while a git action is running", () => {
    const items = buildMenuItems(
      status({ hasWorkingTreeChanges: true, aheadCount: 2, pr: openPr }),
      true,
    );

    expect(items.map((item) => ({ id: item.id, disabled: item.disabled }))).toEqual([
      { id: "commit", disabled: true },
      { id: "push", disabled: true },
      { id: "pr", disabled: true },
    ]);
  });

  it("enables commit and blocks push while the worktree is dirty", () => {
    const items = buildMenuItems(status({ hasWorkingTreeChanges: true, aheadCount: 1 }), false);

    expect(items[0]).toEqual({
      id: "commit",
      label: "Commit",
      disabled: false,
      icon: "commit",
      kind: "open_dialog",
      dialogAction: "commit",
    });
    expect(items[1]?.disabled).toBe(true);
  });

  it("blocks push and PR when the branch is behind upstream", () => {
    const items = buildMenuItems(status({ aheadCount: 3, behindCount: 1 }), false);

    expect(items[1]?.disabled).toBe(true);
    expect(items[2]?.disabled).toBe(true);
  });

  it("blocks push when the branch has no upstream and there is no origin remote", () => {
    const items = buildMenuItems(status({ hasUpstream: false, aheadCount: 1 }), false, false);

    expect(items[1]?.disabled).toBe(true);
    expect(items[2]?.disabled).toBe(true);
  });

  it("allows the first push of an unpublished branch when origin exists", () => {
    const items = buildMenuItems(status({ hasUpstream: false, aheadCount: 1 }), false, true);

    expect(items[1]?.disabled).toBe(false);
    expect(items[2]?.disabled).toBe(false);
  });

  it("swaps Create PR for a View PR link once a PR is open", () => {
    const items = buildMenuItems(status({ aheadCount: 1, pr: openPr }), false);

    expect(items[2]).toEqual({
      id: "pr",
      label: "View PR",
      disabled: false,
      icon: "pr",
      kind: "open_pr",
    });
  });

  it("keeps offering Create PR when the only PR on the branch is already merged", () => {
    const items = buildMenuItems(status({ aheadCount: 1, pr: mergedPr }), false);

    expect(items[2]).toEqual({
      id: "pr",
      label: "Create PR",
      disabled: false,
      icon: "pr",
      kind: "open_dialog",
      dialogAction: "create_pr",
    });
  });

  it("blocks push and PR on a detached HEAD", () => {
    const items = buildMenuItems(status({ refName: null, aheadCount: 1 }), false);

    expect(items[1]?.disabled).toBe(true);
    expect(items[2]?.disabled).toBe(true);
  });
});

describe("resolveQuickAction", () => {
  it("reports the in-progress action instead of offering a new one", () => {
    expect(resolveQuickAction(status({ hasWorkingTreeChanges: true }), true)).toEqual({
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Git action in progress.",
    });
  });

  it("explains that status is unavailable when it has not loaded", () => {
    expect(resolveQuickAction(null, false)).toEqual({
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Git status is unavailable.",
    });
  });

  it("asks for a branch before anything else on a detached HEAD", () => {
    expect(
      resolveQuickAction(status({ refName: null, hasWorkingTreeChanges: true }), false),
    ).toEqual({
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Create and checkout a branch before pushing or opening a PR.",
    });
  });

  it("offers a local-only commit when there is nowhere to push to", () => {
    expect(
      resolveQuickAction(
        status({ hasWorkingTreeChanges: true, hasUpstream: false }),
        false,
        false,
        false,
      ),
    ).toEqual({ label: "Commit", disabled: false, kind: "run_action", action: "commit" });
  });

  it("stops at commit & push for a dirty branch that already has an open PR", () => {
    expect(resolveQuickAction(status({ hasWorkingTreeChanges: true, pr: openPr }), false)).toEqual({
      label: "Commit & push",
      disabled: false,
      kind: "run_action",
      action: "commit_push",
    });
  });

  it("never offers to open a PR from the default branch", () => {
    expect(resolveQuickAction(status({ hasWorkingTreeChanges: true }), false, true)).toEqual({
      label: "Commit & push",
      disabled: false,
      kind: "run_action",
      action: "commit_push",
    });
  });

  it("chains commit, push and PR for a dirty feature branch with no PR", () => {
    expect(resolveQuickAction(status({ hasWorkingTreeChanges: true }), false)).toEqual({
      label: "Commit, push & PR",
      disabled: false,
      kind: "run_action",
      action: "commit_push_pr",
    });
  });

  it("asks for an origin remote when the branch is unpublished and origin is missing", () => {
    expect(
      resolveQuickAction(status({ hasUpstream: false, aheadCount: 2 }), false, false, false),
    ).toEqual({
      label: "Push",
      disabled: true,
      kind: "show_hint",
      hint: 'Add an "origin" remote before pushing or creating a PR.',
    });
  });

  it("falls back to viewing the PR when origin is missing but a PR is already open", () => {
    expect(
      resolveQuickAction(status({ hasUpstream: false, pr: openPr }), false, false, false),
    ).toEqual({ label: "View PR", disabled: false, kind: "open_pr" });
  });

  it("says there is nothing to push on a clean unpublished branch with no commits", () => {
    expect(resolveQuickAction(status({ hasUpstream: false }), false)).toEqual({
      label: "Push",
      disabled: true,
      kind: "show_hint",
      hint: "No local commits to push.",
    });
  });

  it("offers View PR on an unpublished branch that already carries an open PR", () => {
    expect(resolveQuickAction(status({ hasUpstream: false, pr: openPr }), false)).toEqual({
      label: "View PR",
      disabled: false,
      kind: "open_pr",
    });
  });

  it("publishes an unpublished branch with a plain push when its PR is open", () => {
    expect(
      resolveQuickAction(status({ hasUpstream: false, aheadCount: 1, pr: openPr }), false),
    ).toEqual({ label: "Push", disabled: false, kind: "run_action", action: "push" });
  });

  it("routes the default branch through commit_push even with a clean worktree", () => {
    expect(resolveQuickAction(status({ hasUpstream: false, aheadCount: 1 }), false, true)).toEqual({
      label: "Push",
      disabled: false,
      kind: "run_action",
      action: "commit_push",
    });
  });

  it("offers push & create PR for an unpublished feature branch with commits", () => {
    expect(resolveQuickAction(status({ hasUpstream: false, aheadCount: 1 }), false)).toEqual({
      label: "Push & create PR",
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    });
  });

  it("refuses to act on a diverged branch and names the fix", () => {
    expect(resolveQuickAction(status({ aheadCount: 1, behindCount: 1 }), false)).toEqual({
      label: "Sync branch",
      disabled: true,
      kind: "show_hint",
      hint: "Branch has diverged from upstream. Rebase/merge first.",
    });
  });

  it("offers a pull when the branch is only behind", () => {
    expect(resolveQuickAction(status({ behindCount: 2 }), false)).toEqual({
      label: "Pull",
      disabled: false,
      kind: "run_pull",
    });
  });

  it("pushes rather than opening a second PR when the branch is ahead with an open PR", () => {
    expect(resolveQuickAction(status({ aheadCount: 1, pr: openPr }), false)).toEqual({
      label: "Push",
      disabled: false,
      kind: "run_action",
      action: "push",
    });
  });

  it("keeps the published default branch on commit_push so a dirty tree is swept in", () => {
    expect(resolveQuickAction(status({ aheadCount: 1 }), false, true)).toEqual({
      label: "Push",
      disabled: false,
      kind: "run_action",
      action: "commit_push",
    });
  });

  it("offers push & create PR for a published feature branch that is ahead", () => {
    expect(resolveQuickAction(status({ aheadCount: 1 }), false)).toEqual({
      label: "Push & create PR",
      disabled: false,
      kind: "run_action",
      action: "create_pr",
    });
  });

  it("shows View PR for a fully synced branch with an open PR", () => {
    expect(resolveQuickAction(status({ pr: openPr }), false)).toEqual({
      label: "View PR",
      disabled: false,
      kind: "open_pr",
    });
  });

  it("says no action is needed for a branch that is fully in sync", () => {
    expect(resolveQuickAction(status(), false)).toEqual({
      label: "Commit",
      disabled: true,
      kind: "show_hint",
      hint: "Branch is up to date. No action needed.",
    });
  });
});

describe("getGitActionDisabledReason", () => {
  it("gives no reason for an item that is enabled", () => {
    expect(
      getGitActionDisabledReason({
        item: menuItem("commit", false),
        gitStatus: status(),
        isBusy: true,
        hasOriginRemote: true,
      }),
    ).toBeNull();
  });

  it("blames the running action before inspecting git state", () => {
    expect(
      getGitActionDisabledReason({
        item: menuItem("push"),
        gitStatus: null,
        isBusy: true,
        hasOriginRemote: true,
      }),
    ).toBe("Git action in progress.");
  });

  it("blames missing status when nothing has loaded", () => {
    expect(
      getGitActionDisabledReason({
        item: menuItem("push"),
        gitStatus: null,
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("Git status is unavailable.");
  });

  it("tells the user to make changes when commit is blocked by a clean worktree", () => {
    expect(
      getGitActionDisabledReason({
        item: menuItem("commit"),
        gitStatus: status(),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("Worktree is clean. Make changes before committing.");
  });

  it("falls back to a generic commit reason when the worktree is dirty yet commit is disabled", () => {
    expect(
      getGitActionDisabledReason({
        item: menuItem("commit"),
        gitStatus: status({ hasWorkingTreeChanges: true }),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("Commit is currently unavailable.");
  });

  it("names the detached HEAD as the reason push is blocked", () => {
    expect(
      getGitActionDisabledReason({
        item: menuItem("push"),
        gitStatus: status({ refName: null, hasWorkingTreeChanges: true, behindCount: 3 }),
        isBusy: false,
        hasOriginRemote: false,
      }),
    ).toBe("Detached HEAD: checkout a branch before pushing.");
  });

  it("asks for the worktree to be committed or stashed before pushing", () => {
    expect(
      getGitActionDisabledReason({
        item: menuItem("push"),
        gitStatus: status({ hasWorkingTreeChanges: true, behindCount: 1 }),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("Commit or stash local changes before pushing.");
  });

  it("asks for a pull before pushing a branch that is behind", () => {
    expect(
      getGitActionDisabledReason({
        item: menuItem("push"),
        gitStatus: status({ behindCount: 1, aheadCount: 1 }),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("Branch is behind upstream. Pull/rebase before pushing.");
  });

  it("asks for an origin remote before pushing an unpublished branch", () => {
    expect(
      getGitActionDisabledReason({
        item: menuItem("push"),
        gitStatus: status({ hasUpstream: false, aheadCount: 1 }),
        isBusy: false,
        hasOriginRemote: false,
      }),
    ).toBe('Add an "origin" remote before pushing.');
  });

  it("says there is nothing to push when the branch is level with upstream", () => {
    expect(
      getGitActionDisabledReason({
        item: menuItem("push"),
        gitStatus: status(),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("No local commits to push.");
  });

  it("falls back to a generic push reason when every specific check passes", () => {
    expect(
      getGitActionDisabledReason({
        item: menuItem("push"),
        gitStatus: status({ aheadCount: 1 }),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("Push is currently unavailable.");
  });

  it("reports the disabled View PR link rather than a PR-creation reason", () => {
    expect(
      getGitActionDisabledReason({
        item: menuItem("pr"),
        gitStatus: status({ refName: null, hasWorkingTreeChanges: true, pr: openPr }),
        isBusy: false,
        hasOriginRemote: false,
      }),
    ).toBe("View PR is currently unavailable.");
  });

  it("names the detached HEAD as the reason a PR cannot be created", () => {
    expect(
      getGitActionDisabledReason({
        item: menuItem("pr"),
        gitStatus: status({ refName: null }),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("Detached HEAD: checkout a branch before creating a PR.");
  });

  it("asks for local changes to be committed before creating a PR", () => {
    expect(
      getGitActionDisabledReason({
        item: menuItem("pr"),
        gitStatus: status({ hasWorkingTreeChanges: true }),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("Commit local changes before creating a PR.");
  });

  it("asks for an origin remote before creating a PR", () => {
    expect(
      getGitActionDisabledReason({
        item: menuItem("pr"),
        gitStatus: status({ hasUpstream: false, aheadCount: 1 }),
        isBusy: false,
        hasOriginRemote: false,
      }),
    ).toBe('Add an "origin" remote before creating a PR.');
  });

  it("says there is nothing to include when the branch has no commits", () => {
    expect(
      getGitActionDisabledReason({
        item: menuItem("pr"),
        gitStatus: status(),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("No local commits to include in a PR.");
  });

  it("asks for a rebase before creating a PR from a branch that is behind", () => {
    expect(
      getGitActionDisabledReason({
        item: menuItem("pr"),
        gitStatus: status({ aheadCount: 1, behindCount: 1 }),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("Branch is behind upstream. Pull/rebase before creating a PR.");
  });

  it("falls back to a generic PR reason when every specific check passes", () => {
    expect(
      getGitActionDisabledReason({
        item: menuItem("pr"),
        gitStatus: status({ aheadCount: 1 }),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe("Create PR is currently unavailable.");
  });
});

describe("requiresDefaultBranchConfirmation", () => {
  it("never confirms off the default branch, whatever the action", () => {
    expect(requiresDefaultBranchConfirmation("commit_push_pr", false)).toBe(false);
    expect(requiresDefaultBranchConfirmation("push", false)).toBe(false);
  });

  it("does not confirm a local-only commit on the default branch", () => {
    expect(requiresDefaultBranchConfirmation("commit", true)).toBe(false);
  });

  it("confirms every action that publishes from the default branch", () => {
    expect(requiresDefaultBranchConfirmation("push", true)).toBe(true);
    expect(requiresDefaultBranchConfirmation("create_pr", true)).toBe(true);
    expect(requiresDefaultBranchConfirmation("commit_push", true)).toBe(true);
    expect(requiresDefaultBranchConfirmation("commit_push_pr", true)).toBe(true);
  });
});

describe("resolveDefaultBranchActionDialogCopy", () => {
  it("says push only when the action carries no commit", () => {
    expect(
      resolveDefaultBranchActionDialogCopy({
        action: "push",
        branchName: "main",
        includesCommit: false,
      }),
    ).toEqual({
      title: "Push to default branch?",
      description:
        'This action will push local commits on "main". You can continue on this branch or create a feature branch and run the same action there.',
      continueLabel: "Push to main",
    });
  });

  it("upgrades commit_push copy to mention the commit when one is included", () => {
    expect(
      resolveDefaultBranchActionDialogCopy({
        action: "commit_push",
        branchName: "develop",
        includesCommit: true,
      }),
    ).toEqual({
      title: "Commit & push to default branch?",
      description:
        'This action will commit and push changes on "develop". You can continue on this branch or create a feature branch and run the same action there.',
      continueLabel: "Commit & push to develop",
    });
  });

  it("keeps the push-only copy for commit_push when there is nothing to commit", () => {
    expect(
      resolveDefaultBranchActionDialogCopy({
        action: "commit_push",
        branchName: "main",
        includesCommit: false,
      }),
    ).toEqual({
      title: "Push to default branch?",
      description:
        'This action will push local commits on "main". You can continue on this branch or create a feature branch and run the same action there.',
      continueLabel: "Push to main",
    });
  });

  it("describes create_pr without a commit as push & create PR", () => {
    expect(
      resolveDefaultBranchActionDialogCopy({
        action: "create_pr",
        branchName: "main",
        includesCommit: false,
      }),
    ).toEqual({
      title: "Push & create PR from default branch?",
      description:
        'This action will push local commits and create a PR on "main". You can continue on this branch or create a feature branch and run the same action there.',
      continueLabel: "Push & create PR",
    });
  });

  it("describes commit_push_pr as the full three-step action", () => {
    expect(
      resolveDefaultBranchActionDialogCopy({
        action: "commit_push_pr",
        branchName: "main",
        includesCommit: true,
      }),
    ).toEqual({
      title: "Commit, push & create PR from default branch?",
      description:
        'This action will commit, push, and create a PR on "main". You can continue on this branch or create a feature branch and run the same action there.',
      continueLabel: "Commit, push & create PR",
    });
  });
});

describe("resolveThreadBranchUpdate", () => {
  it("moves the thread onto a newly created branch", () => {
    expect(
      resolveThreadBranchUpdate(
        stackedResult({ branch: { status: "created", name: "feature/new" } }),
      ),
    ).toEqual({ branch: "feature/new" });
  });

  it("leaves the thread alone when no branch was created", () => {
    expect(
      resolveThreadBranchUpdate(stackedResult({ branch: { status: "skipped_not_requested" } })),
    ).toBeNull();
  });

  it("leaves the thread alone when a created branch came back without a name", () => {
    expect(resolveThreadBranchUpdate(stackedResult({ branch: { status: "created" } }))).toBeNull();
  });
});

describe("resolveLiveThreadBranchUpdate", () => {
  it("does nothing while git status is unknown", () => {
    expect(
      resolveLiveThreadBranchUpdate({ threadBranch: "feature/x", gitStatus: null }),
    ).toBeNull();
  });

  it("keeps the recorded branch when HEAD goes detached", () => {
    expect(
      resolveLiveThreadBranchUpdate({
        threadBranch: "feature/x",
        gitStatus: status({ refName: null }),
      }),
    ).toBeNull();
  });

  it("does nothing when the thread already records the checked-out branch", () => {
    expect(
      resolveLiveThreadBranchUpdate({
        threadBranch: "feature/x",
        gitStatus: status({ refName: "feature/x" }),
      }),
    ).toBeNull();
  });

  it("refuses to overwrite a real branch with a temporary worktree branch", () => {
    expect(
      resolveLiveThreadBranchUpdate({
        threadBranch: "feature/x",
        gitStatus: status({ refName: temporaryBranch }),
      }),
    ).toBeNull();
  });

  it("adopts a real branch that replaced a temporary worktree branch", () => {
    expect(
      resolveLiveThreadBranchUpdate({
        threadBranch: temporaryBranch,
        gitStatus: status({ refName: "feature/x" }),
      }),
    ).toEqual({ branch: "feature/x" });
  });

  it("records the branch for a thread that had none", () => {
    expect(
      resolveLiveThreadBranchUpdate({
        threadBranch: null,
        gitStatus: status({ refName: "feature/x" }),
      }),
    ).toEqual({ branch: "feature/x" });
  });

  it("issues no update for a branchless thread on a detached HEAD", () => {
    expect(
      resolveLiveThreadBranchUpdate({ threadBranch: null, gitStatus: status({ refName: null }) }),
    ).toBeNull();
  });

  it("follows a checkout from one real branch to another", () => {
    expect(
      resolveLiveThreadBranchUpdate({
        threadBranch: "feature/x",
        gitStatus: status({ refName: "feature/y" }),
      }),
    ).toEqual({ branch: "feature/y" });
  });
});
