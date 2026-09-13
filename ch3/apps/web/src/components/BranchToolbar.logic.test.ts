import { EnvironmentId, type VcsRef } from "@ch3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  resolveEnvironmentOptionLabel,
  resolveBranchSelectionTarget,
  resolveCurrentWorkspaceLabel,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  resolveEnvModeLabel,
  resolveBranchTriggerLabel,
  resolveBranchToolbarPrBranch,
  resolveBranchToolbarValue,
  resolveLockedWorkspaceLabel,
  resolveLocalCheckoutBranchMismatch,
  buildRestylePrompt,
  formatOutputStyleLabel,
  HIDDEN_OUTPUT_STYLES,
  resolveDefaultOutputStyleOptions,
  resolveInitialOutputStyle,
  resolveOutputStyleChipState,
  resolveOutputStyleToSeed,
  resolvePreviousWorktreeLabel,
  resolvePreviousWorktreeSeed,
  shouldIncludeBranchPickerItem,
  shouldShowEnvironmentIndicator,
} from "./BranchToolbar.logic";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

describe("resolvePreviousWorktreeSeed", () => {
  it("picks the most recently updated worktree thread", () => {
    expect(
      resolvePreviousWorktreeSeed({
        threads: [
          {
            branch: "ch3/older",
            worktreePath: "/repo/.ch3/worktrees/older",
            updatedAt: "2026-07-20T00:00:00.000Z",
          },
          {
            branch: "ch3/newer",
            worktreePath: "/repo/.ch3/worktrees/newer",
            updatedAt: "2026-07-22T00:00:00.000Z",
          },
          { branch: "main", worktreePath: null, updatedAt: "2026-07-23T00:00:00.000Z" },
        ],
        currentWorktreePath: null,
      }),
    ).toEqual({ branch: "ch3/newer", worktreePath: "/repo/.ch3/worktrees/newer" });
  });

  it("skips the worktree the composer already points at", () => {
    expect(
      resolvePreviousWorktreeSeed({
        threads: [
          {
            branch: "ch3/current",
            worktreePath: "/repo/.ch3/worktrees/current",
            updatedAt: "2026-07-22T00:00:00.000Z",
          },
        ],
        currentWorktreePath: "/repo/.ch3/worktrees/current",
      }),
    ).toBeNull();
  });

  it("returns null when no thread has a worktree", () => {
    expect(
      resolvePreviousWorktreeSeed({
        threads: [{ branch: "main", worktreePath: null, updatedAt: "2026-07-22T00:00:00.000Z" }],
        currentWorktreePath: null,
      }),
    ).toBeNull();
  });

  it("ignores archived threads and threads with unparseable timestamps", () => {
    expect(
      resolvePreviousWorktreeSeed({
        threads: [
          {
            branch: "ch3/archived",
            worktreePath: "/repo/.ch3/worktrees/archived",
            updatedAt: "2026-07-23T00:00:00.000Z",
            archivedAt: "2026-07-23T01:00:00.000Z",
          },
          {
            branch: "ch3/garbage-timestamp",
            worktreePath: "/repo/.ch3/worktrees/garbage",
            updatedAt: "not-a-date",
          },
          {
            branch: "ch3/live",
            worktreePath: "/repo/.ch3/worktrees/live",
            updatedAt: "2026-07-21T00:00:00.000Z",
            archivedAt: null,
          },
        ],
        currentWorktreePath: null,
      }),
    ).toEqual({ branch: "ch3/live", worktreePath: "/repo/.ch3/worktrees/live" });
  });
});

describe("resolvePreviousWorktreeLabel", () => {
  it("includes the branch when known", () => {
    expect(resolvePreviousWorktreeLabel({ branch: "ch3/fix-thing", worktreePath: "/wt" })).toBe(
      "Previous worktree (ch3/fix-thing)",
    );
    expect(resolvePreviousWorktreeLabel({ branch: null, worktreePath: "/wt" })).toBe(
      "Previous worktree",
    );
  });
});

describe("resolveDraftEnvModeAfterBranchChange", () => {
  it("switches to local mode when returning from an existing worktree to the main worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: "/repo/.ch3/worktrees/feature-a",
        effectiveEnvMode: "worktree",
      }),
    ).toBe("local");
  });

  it("keeps new-worktree mode when selecting a base ref before worktree creation", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: null,
        effectiveEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("uses worktree mode when selecting a ref already attached to a worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: "/repo/.ch3/worktrees/feature-a",
        currentWorktreePath: null,
        effectiveEnvMode: "local",
      }),
    ).toBe("worktree");
  });
});

describe("resolveBranchToolbarValue", () => {
  it("defaults new-worktree mode to current git ref when no explicit base ref is set", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadBranch: null,
        currentGitBranch: "main",
      }),
    ).toBe("main");
  });

  it("keeps an explicitly selected worktree base ref", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadBranch: "feature/base",
        currentGitBranch: "main",
      }),
    ).toBe("feature/base");
  });

  it("shows the actual checked-out ref when not selecting a new worktree base", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: "feature/base",
        currentGitBranch: "main",
      }),
    ).toBe("main");
  });
});

describe("resolveBranchTriggerLabel", () => {
  it("shows the origin ref when a new worktree will start from origin", () => {
    expect(
      resolveBranchTriggerLabel({
        activeWorktreePath: null,
        effectiveEnvMode: "worktree",
        resolvedActiveBranch: "main",
        resolvedActiveBranchIsRemote: false,
        startFromOrigin: true,
      }),
    ).toBe("From origin/main");
  });

  it("shows the origin ref for local branch names that contain slashes", () => {
    expect(
      resolveBranchTriggerLabel({
        activeWorktreePath: null,
        effectiveEnvMode: "worktree",
        resolvedActiveBranch: "feature/demo",
        resolvedActiveBranchIsRemote: false,
        startFromOrigin: true,
      }),
    ).toBe("From origin/feature/demo");
  });

  it("shows the local ref when start from origin is disabled", () => {
    expect(
      resolveBranchTriggerLabel({
        activeWorktreePath: null,
        effectiveEnvMode: "worktree",
        resolvedActiveBranch: "main",
        resolvedActiveBranchIsRemote: false,
        startFromOrigin: false,
      }),
    ).toBe("From main");
  });

  it("does not duplicate the origin prefix for an explicit remote ref", () => {
    expect(
      resolveBranchTriggerLabel({
        activeWorktreePath: null,
        effectiveEnvMode: "worktree",
        resolvedActiveBranch: "origin/feature/demo",
        resolvedActiveBranchIsRemote: true,
        startFromOrigin: true,
      }),
    ).toBe("From origin/feature/demo");
  });

  it("preserves an explicit ref from a non-origin remote", () => {
    expect(
      resolveBranchTriggerLabel({
        activeWorktreePath: null,
        effectiveEnvMode: "worktree",
        resolvedActiveBranch: "upstream/feature/demo",
        resolvedActiveBranchIsRemote: true,
        startFromOrigin: true,
      }),
    ).toBe("From upstream/feature/demo");
  });

  it("keeps current-checkout labels and empty state unchanged", () => {
    expect(
      resolveBranchTriggerLabel({
        activeWorktreePath: null,
        effectiveEnvMode: "local",
        resolvedActiveBranch: "main",
        resolvedActiveBranchIsRemote: false,
        startFromOrigin: true,
      }),
    ).toBe("main");
    expect(
      resolveBranchTriggerLabel({
        activeWorktreePath: null,
        effectiveEnvMode: "worktree",
        resolvedActiveBranch: null,
        resolvedActiveBranchIsRemote: null,
        startFromOrigin: true,
      }),
    ).toBe("Select ref");
  });

  it("does not fabricate an origin ref while branch metadata is loading", () => {
    expect(
      resolveBranchTriggerLabel({
        activeWorktreePath: null,
        effectiveEnvMode: "worktree",
        resolvedActiveBranch: "upstream/feature/demo",
        resolvedActiveBranchIsRemote: null,
        startFromOrigin: true,
      }),
    ).toBe("From upstream/feature/demo");
  });
});

describe("resolveBranchToolbarPrBranch", () => {
  it("uses the explicit thread branch when it matches the displayed branch", () => {
    expect(
      resolveBranchToolbarPrBranch({
        activeThreadBranch: "feature/current",
        resolvedActiveBranch: "feature/current",
      }),
    ).toBe("feature/current");
  });

  it("hides PR state while an optimistic branch switch is in flight", () => {
    expect(
      resolveBranchToolbarPrBranch({
        activeThreadBranch: "feature/current",
        resolvedActiveBranch: "feature/next",
      }),
    ).toBeNull();
  });

  it("does not infer PR state without an explicit thread branch", () => {
    expect(
      resolveBranchToolbarPrBranch({
        activeThreadBranch: null,
        resolvedActiveBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("resolveLocalCheckoutBranchMismatch", () => {
  it("detects when a local thread is associated with a different branch than the checkout", () => {
    expect(
      resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: "feature/thread",
        currentGitBranch: "feature/current",
      }),
    ).toEqual({
      threadBranch: "feature/thread",
      currentBranch: "feature/current",
    });
  });

  it("ignores matching local checkout state", () => {
    expect(
      resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: "feature/thread",
        currentGitBranch: "feature/thread",
      }),
    ).toBeNull();
  });

  it("ignores dedicated worktrees because their checkout is already thread-scoped", () => {
    expect(
      resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: "worktree",
        activeWorktreePath: "/repo/.ch3/worktrees/feature-thread",
        activeThreadBranch: "feature/thread",
        currentGitBranch: "feature/current",
      }),
    ).toBeNull();
  });

  it("ignores new-worktree base selection before a worktree exists", () => {
    expect(
      resolveLocalCheckoutBranchMismatch({
        effectiveEnvMode: "worktree",
        activeWorktreePath: null,
        activeThreadBranch: "feature/base",
        currentGitBranch: "main",
      }),
    ).toBeNull();
  });
});

describe("resolveEnvironmentOptionLabel", () => {
  it("prefers the primary environment's machine label", () => {
    expect(
      resolveEnvironmentOptionLabel({
        isPrimary: true,
        environmentId: localEnvironmentId,
        runtimeLabel: "Julius's Mac mini",
        savedLabel: "Local environment",
      }),
    ).toBe("Julius's Mac mini");
  });

  it("falls back to 'This device' for generic primary labels", () => {
    expect(
      resolveEnvironmentOptionLabel({
        isPrimary: true,
        environmentId: localEnvironmentId,
        runtimeLabel: "Local environment",
        savedLabel: "Local",
      }),
    ).toBe("This device");
  });

  it("keeps configured labels for non-primary environments", () => {
    expect(
      resolveEnvironmentOptionLabel({
        isPrimary: false,
        environmentId: remoteEnvironmentId,
        runtimeLabel: null,
        savedLabel: "Build box",
      }),
    ).toBe("Build box");
  });
});

describe("shouldShowEnvironmentIndicator", () => {
  it("shows the indicator whenever multiple environments are pickable", () => {
    expect(
      shouldShowEnvironmentIndicator({
        activeEnvironment: { isPrimary: true },
        canPickEnvironment: true,
      }),
    ).toBe(true);
  });

  it("shows a sole remote environment so the user knows where the project runs", () => {
    expect(
      shouldShowEnvironmentIndicator({
        activeEnvironment: { isPrimary: false },
        canPickEnvironment: false,
      }),
    ).toBe(true);
  });

  it("hides a sole primary (this-device) environment", () => {
    expect(
      shouldShowEnvironmentIndicator({
        activeEnvironment: { isPrimary: true },
        canPickEnvironment: false,
      }),
    ).toBe(false);
  });

  it("hides the indicator when the active environment is unknown", () => {
    expect(
      shouldShowEnvironmentIndicator({
        activeEnvironment: null,
        canPickEnvironment: false,
      }),
    ).toBe(false);
  });
});

describe("resolveEffectiveEnvMode", () => {
  it("treats draft threads already attached to a worktree as current-checkout mode", () => {
    expect(
      resolveEffectiveEnvMode({
        activeWorktreePath: "/repo/.ch3/worktrees/feature-a",
        hasServerThread: false,
        draftThreadEnvMode: "worktree",
      }),
    ).toBe("local");
  });

  it("keeps explicit new-worktree mode for draft threads without a worktree path", () => {
    expect(
      resolveEffectiveEnvMode({
        activeWorktreePath: null,
        hasServerThread: false,
        draftThreadEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });
});

describe("resolveEnvModeLabel", () => {
  it("uses explicit workspace labels", () => {
    expect(resolveEnvModeLabel("local")).toBe("Current checkout");
    expect(resolveEnvModeLabel("worktree")).toBe("New worktree");
  });
});

describe("resolveCurrentWorkspaceLabel", () => {
  it("describes the main repo checkout when no worktree path is active", () => {
    expect(resolveCurrentWorkspaceLabel(null)).toBe("Current checkout");
  });

  it("describes the active checkout as a worktree when one is attached", () => {
    expect(resolveCurrentWorkspaceLabel("/repo/.ch3/worktrees/feature-a")).toBe("Current worktree");
  });
});

describe("resolveLockedWorkspaceLabel", () => {
  it("uses a shorter label for the main repo checkout", () => {
    expect(resolveLockedWorkspaceLabel(null)).toBe("Local checkout");
  });

  it("uses a shorter label for an attached worktree", () => {
    expect(resolveLockedWorkspaceLabel("/repo/.ch3/worktrees/feature-a")).toBe("Worktree");
  });
});

describe("deriveLocalBranchNameFromRemoteRef", () => {
  it("strips the remote prefix from a remote ref", () => {
    expect(deriveLocalBranchNameFromRemoteRef("origin/feature/demo")).toBe("feature/demo");
  });

  it("supports remote names that contain slashes", () => {
    expect(deriveLocalBranchNameFromRemoteRef("my-org/upstream/feature/demo")).toBe(
      "upstream/feature/demo",
    );
  });

  it("returns the original name when ref is malformed", () => {
    expect(deriveLocalBranchNameFromRemoteRef("origin/")).toBe("origin/");
    expect(deriveLocalBranchNameFromRemoteRef("/feature/demo")).toBe("/feature/demo");
  });
});

describe("dedupeRemoteBranchesWithLocalMatches", () => {
  it("hides remote refs when the matching local ref exists", () => {
    const input: VcsRef[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/demo",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "feature/demo",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps all entries when no local match exists for a remote ref", () => {
    const input: VcsRef[] = [
      {
        name: "feature/local",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "feature/local",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps non-origin remote refs visible even when a matching local ref exists", () => {
    const input: VcsRef[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature/demo",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "feature/demo",
      "my-org/upstream/feature/demo",
    ]);
  });

  it("keeps non-origin remote refs visible when git tracks with first-slash local naming", () => {
    const input: VcsRef[] = [
      {
        name: "upstream/feature",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "upstream/feature",
      "my-org/upstream/feature",
    ]);
  });
});

describe("resolveBranchSelectionTarget", () => {
  it("reuses an existing secondary worktree for the selected ref", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.ch3/worktrees/feature-a",
        refName: {
          isDefault: false,
          worktreePath: "/repo/.ch3/worktrees/feature-b",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.ch3/worktrees/feature-b",
      nextWorktreePath: "/repo/.ch3/worktrees/feature-b",
      reuseExistingWorktree: true,
    });
  });

  it("switches back to the main repo when the ref already lives there", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.ch3/worktrees/feature-a",
        refName: {
          isDefault: true,
          worktreePath: "/repo",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: true,
    });
  });

  it("checks out the default ref in the main repo when leaving a secondary worktree", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.ch3/worktrees/feature-a",
        refName: {
          isDefault: true,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: false,
    });
  });

  it("keeps checkout in the current worktree for non-default refs", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.ch3/worktrees/feature-a",
        refName: {
          isDefault: false,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.ch3/worktrees/feature-a",
      nextWorktreePath: "/repo/.ch3/worktrees/feature-a",
      reuseExistingWorktree: false,
    });
  });
});

describe("shouldIncludeBranchPickerItem", () => {
  it("keeps the synthetic checkout PR item visible for gh pr checkout input", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "__checkout_pull_request__:1359",
        normalizedQuery: "gh pr checkout 1359",
        createBranchItemValue: "__create_new_branch__:gh pr checkout 1359",
        checkoutPullRequestItemValue: "__checkout_pull_request__:1359",
      }),
    ).toBe(true);
  });

  it("keeps the synthetic create-ref item visible for arbitrary ref input", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "__create_new_branch__:feature/demo",
        normalizedQuery: "feature/demo",
        createBranchItemValue: "__create_new_branch__:feature/demo",
        checkoutPullRequestItemValue: null,
      }),
    ).toBe(true);
  });

  it("still filters ordinary ref items by query text", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "main",
        normalizedQuery: "gh pr checkout 1359",
        createBranchItemValue: "__create_new_branch__:gh pr checkout 1359",
        checkoutPullRequestItemValue: "__checkout_pull_request__:1359",
      }),
    ).toBe(false);
  });
});

describe("resolveOutputStyleChipState", () => {
  it("hides the chip when the driver reports no styles", () => {
    expect(
      resolveOutputStyleChipState({
        availableStyles: undefined,
        activeStyle: undefined,
        pickedStyle: null,
      }),
    ).toBeNull();
    expect(
      resolveOutputStyleChipState({
        availableStyles: [],
        activeStyle: "Caveman",
        pickedStyle: "Caveman",
      }),
    ).toBeNull();
  });

  it("labels an unpicked chip with the style the driver actually resolved", () => {
    expect(
      resolveOutputStyleChipState({
        availableStyles: ["default", "Zoom", "Caveman"],
        activeStyle: "Caveman",
        pickedStyle: null,
      }),
    ).toEqual({
      styles: ["default", "Caveman", "Zoom"],
      selectedStyle: "Caveman",
      label: "Caveman",
    });
  });

  it("leads with None, then the shipped styles, then the rest alphabetically", () => {
    expect(
      resolveOutputStyleChipState({
        availableStyles: ["default", "Receipts", "Caveman", "mission control", "I'm Tired", "Zoom"],
        activeStyle: "default",
        pickedStyle: null,
      })?.styles,
      // Caveman first because every conversation starts on it, "I'm Tired"
      // second as the deliberate way out, then None, then whatever else the
      // driver reports — in the order given, not the order it arrived in.
    ).toEqual(["default", "Caveman", "I'm Tired", "mission control", "Receipts", "Zoom"]);
  });

  it("drops the built-in styles on the hidden list", () => {
    // The CLI compiles these in and offers no way to hide them, so the picker
    // filters them out itself.
    expect(HIDDEN_OUTPUT_STYLES).toEqual(["Proactive", "Explanatory", "Learning"]);
    expect(
      resolveOutputStyleChipState({
        availableStyles: ["default", "Proactive", "Explanatory", "Learning", "Caveman", "Receipts"],
        activeStyle: "default",
        pickedStyle: null,
      })?.styles,
    ).toEqual(["default", "Caveman", "Receipts"]);
  });

  it("matches the hidden list without regard to case", () => {
    expect(
      resolveOutputStyleChipState({
        availableStyles: ["default", "explanatory", "LEARNING", "Caveman"],
        activeStyle: "default",
        pickedStyle: null,
      })?.styles,
    ).toEqual(["default", "Caveman"]);
  });

  it("still lists a hidden style while it is the one in force", () => {
    // Otherwise the menu could not show what the thread is running under, and
    // a Select whose value matches no item renders empty.
    expect(
      resolveOutputStyleChipState({
        availableStyles: ["default", "Explanatory", "Caveman"],
        activeStyle: "default",
        pickedStyle: "Explanatory",
      }),
    ).toEqual({
      styles: ["default", "Caveman", "Explanatory"],
      selectedStyle: "Explanatory",
      label: "Explanatory",
    });
  });

  it("falls back to the first reported style when no active style is named", () => {
    expect(
      resolveOutputStyleChipState({
        availableStyles: ["default", "Zoom"],
        activeStyle: undefined,
        pickedStyle: null,
      })?.selectedStyle,
    ).toBe("default");
  });

  it("prefers the thread's own pick over the driver's resolved style", () => {
    expect(
      resolveOutputStyleChipState({
        availableStyles: ["default", "Caveman"],
        activeStyle: "Caveman",
        pickedStyle: "default",
      })?.selectedStyle,
    ).toBe("default");
  });

  it("keeps a picked style that the driver no longer reports", () => {
    // A custom style file renamed or deleted since the probe ran: the thread
    // still runs under it, so it stays visible and selectable.
    expect(
      resolveOutputStyleChipState({
        availableStyles: ["default", "Zoom"],
        activeStyle: "default",
        pickedStyle: "Retired Style",
      }),
    ).toEqual({
      styles: ["default", "Retired Style", "Zoom"],
      selectedStyle: "Retired Style",
      label: "Retired Style",
    });
  });

  it("still falls back to the driver's first reported style, not the first alphabetically", () => {
    // Sorting is a display concern; the fallback has to stay the CLI's own
    // default, which it reports first.
    expect(
      resolveOutputStyleChipState({
        // No shipped default in this list — that path has its own test; this
        // one is about which fallback wins when nothing else applies.
        availableStyles: ["default", "Zoom"],
        activeStyle: undefined,
        pickedStyle: null,
      })?.selectedStyle,
    ).toBe("default");
  });

  it("puts the no-style option first and calls it None", () => {
    const chip = resolveOutputStyleChipState({
      availableStyles: ["Caveman", "Zoom", "default", "Ladder"],
      activeStyle: "default",
      // Picked explicitly: this test is about the display order and the label,
      // and leaving it unpicked would now select the shipped default instead.
      pickedStyle: "default",
    });

    // Pinned above the alphabetical run rather than sorted into the N's — it
    // is the way out of every other style — but below the styles CH3 ships
    // and recommends.
    expect(chip?.styles).toEqual(["default", "Caveman", "Ladder", "Zoom"]);
    // The wire value stays "default"; only the display name changes.
    expect(chip?.selectedStyle).toBe("default");
    expect(chip?.label).toBe("None");
  });

  it("renames only the no-style option", () => {
    expect(formatOutputStyleLabel("default")).toBe("None");
    expect(formatOutputStyleLabel("Default")).toBe("None");
    expect(formatOutputStyleLabel("Caveman")).toBe("Caveman");
  });

  it("treats a blank pick as no pick at all", () => {
    expect(
      resolveOutputStyleChipState({
        availableStyles: ["default", "Caveman"],
        activeStyle: "Caveman",
        pickedStyle: "   ",
      }),
    ).toEqual({
      styles: ["default", "Caveman"],
      selectedStyle: "Caveman",
      label: "Caveman",
    });
  });
});

describe("resolveDefaultOutputStyleOptions", () => {
  it("falls back to Caveman and None when the driver has not answered yet", () => {
    expect(resolveDefaultOutputStyleOptions(undefined)).toEqual(["Caveman", "default"]);
    expect(resolveDefaultOutputStyleOptions([])).toEqual(["Caveman", "default"]);
  });

  it("pins Caveman first, then everything else alphabetically, including None", () => {
    expect(
      resolveDefaultOutputStyleOptions(["default", "Zoom", "Caveman", "Ladder", "I'm Tired"]),
    ).toEqual(["Caveman", "default", "I'm Tired", "Ladder", "Zoom"]);
  });

  it("adds Caveman even when the driver does not report it", () => {
    // Bundled at install time, so this should not happen — but the picker
    // still needs a first-item recommendation if the file was ever deleted.
    expect(resolveDefaultOutputStyleOptions(["default", "Zoom"])).toEqual([
      "Caveman",
      "default",
      "Zoom",
    ]);
  });

  it("drops the built-in styles on the hidden list", () => {
    expect(
      resolveDefaultOutputStyleOptions([
        "default",
        "Caveman",
        "Proactive",
        "Explanatory",
        "Learning",
      ]),
    ).toEqual(["Caveman", "default"]);
  });
});

describe("buildRestylePrompt", () => {
  it("names the style without restating its rules", () => {
    const prompt = buildRestylePrompt("Executive Brief");

    expect(prompt).toContain("Executive Brief response style");
    expect(prompt).toContain("Same content — only the form changes.");
    expect(prompt).toContain("re-adaptation of what you just said");
  });

  it("strips the previous style of any authority over the new one", () => {
    // The rewrite's real failure mode is blending: the previous reply sits in
    // the transcript as the model's own latest output, so without this it
    // imitates the style it is supposed to be replacing.
    const prompt = buildRestylePrompt("Caveman");

    expect(prompt).toContain("no longer in force");
    expect(prompt).toContain("Do not blend the two styles");
    expect(prompt).toContain("it wins without exception");
  });

  it("permits the process a style requires before answering", () => {
    // Styles that demand evidence for every claim, or a freshly verified
    // state strip, cannot be applied honestly if the rewrite forbids tool
    // use — the model would have to fake the verification or refuse.
    const prompt = buildRestylePrompt("Receipts");

    expect(prompt).toContain("go ahead and do it");
    expect(prompt).not.toContain("Do not redo any work");
    expect(prompt).not.toContain("re-run any command");
  });

  it("describes the no-style option in words the model can act on", () => {
    expect(buildRestylePrompt("default")).toContain("default response style (no style)");
  });
});

describe("the shipped response style", () => {
  it("starts a conversation on Caveman when the CLI advertises it", () => {
    const chip = resolveOutputStyleChipState({
      availableStyles: ["default", "Caveman", "Whiteboard"],
      activeStyle: "default",
      pickedStyle: null,
    });
    // Beats the driver's own resolved style: CH3 ships Caveman as the
    // starting point for every conversation.
    expect(chip?.selectedStyle).toBe("Caveman");
  });

  it("honours a pick, including the pick that means none", () => {
    const pick = (pickedStyle: string) =>
      resolveOutputStyleChipState({
        availableStyles: ["default", "Caveman", "Whiteboard"],
        activeStyle: "default",
        pickedStyle,
      })?.selectedStyle;
    expect(pick("Whiteboard")).toBe("Whiteboard");
    // Moving away is a real selection and must not be overridden back.
    expect(pick("default")).toBe("default");
  });

  it("starts a conversation on None when the defaultOutputStyle setting says so", () => {
    const chip = resolveOutputStyleChipState({
      availableStyles: ["default", "Caveman", "Whiteboard"],
      activeStyle: "Caveman",
      pickedStyle: null,
      preferredStyle: "default",
    });
    expect(chip?.selectedStyle).toBe("default");
  });

  it("falls back to the driver's own style when Caveman is not installed", () => {
    // The file lives in the user's home and can be deleted. Naming a style the
    // CLI does not know is a broken session, not a missing preference.
    const chip = resolveOutputStyleChipState({
      availableStyles: ["default", "Whiteboard"],
      activeStyle: "Whiteboard",
      pickedStyle: null,
    });
    expect(chip?.selectedStyle).toBe("Whiteboard");
  });

  it("puts None first without changing what a conversation starts on", () => {
    // The two are separate questions and this is the one place they could be
    // confused: None leads the MENU, Caveman is still what a new conversation
    // runs under. Reordering the list must not become a change of default.
    const chip = resolveOutputStyleChipState({
      availableStyles: ["default", "Caveman", "I'm Tired", "Zoom"],
      pickedStyle: null,
      activeStyle: undefined,
    });

    expect(chip?.styles[0]).toBe("default");
    expect(chip?.selectedStyle).toBe("Caveman");
    expect(resolveInitialOutputStyle(["default", "Caveman", "I'm Tired", "Zoom"])).toBe("Caveman");
  });

  it("resolveInitialOutputStyle answers null rather than guessing", () => {
    expect(resolveInitialOutputStyle(["default", "Caveman"])).toBe("Caveman");
    expect(resolveInitialOutputStyle(["default"])).toBeNull();
    expect(resolveInitialOutputStyle(undefined)).toBeNull();
  });

  it("resolveInitialOutputStyle honors a preferredStyle override (the defaultOutputStyle setting)", () => {
    // "None" for every new conversation is stored as the CLI's own no-style
    // sentinel, "default" — always in the advertised list, so this never falls
    // through to the missing-file case.
    expect(resolveInitialOutputStyle(["default", "Caveman", "Whiteboard"], "default")).toBe(
      "default",
    );
    expect(resolveInitialOutputStyle(["default", "Caveman", "Whiteboard"], "Whiteboard")).toBe(
      "Whiteboard",
    );
    // A preference naming a style this machine does not advertise degrades the
    // same way the shipped Caveman default does: null, not a guess.
    expect(resolveInitialOutputStyle(["default", "Caveman"], "Whiteboard")).toBeNull();
  });
});

describe("resolveOutputStyleToSeed", () => {
  it("seeds Caveman into a conversation that has picked nothing", () => {
    // The reported bug, at its source: nothing had picked a style, and the
    // guard that was supposed to notice compared the reading against `null`
    // while it answers `undefined` — so it matched on every render, wrote
    // nothing, and the turn ran under whatever the CLI resolved on its own.
    expect(
      resolveOutputStyleToSeed({
        pickedStyle: undefined,
        availableStyles: ["default", "Caveman", "Whiteboard"],
      }),
    ).toBe("Caveman");
    expect(
      resolveOutputStyleToSeed({
        pickedStyle: null,
        availableStyles: ["default", "Caveman", "Whiteboard"],
      }),
    ).toBe("Caveman");
    expect(
      resolveOutputStyleToSeed({
        pickedStyle: "   ",
        availableStyles: ["default", "Caveman", "Whiteboard"],
      }),
    ).toBe("Caveman");
  });

  it("leaves a conversation that has picked one alone, None included", () => {
    // Picking None is a selection. Seeding over it would make the shipped
    // default un-leaveable rather than merely the starting point.
    const styles = ["default", "Caveman", "Whiteboard"];
    expect(
      resolveOutputStyleToSeed({ pickedStyle: "default", availableStyles: styles }),
    ).toBeNull();
    expect(
      resolveOutputStyleToSeed({ pickedStyle: "Whiteboard", availableStyles: styles }),
    ).toBeNull();
    expect(
      resolveOutputStyleToSeed({ pickedStyle: "Caveman", availableStyles: styles }),
    ).toBeNull();
  });

  it("writes nothing when the CLI does not advertise Caveman", () => {
    // Naming a style the CLI does not know breaks the session. The chip falls
    // back to the driver's own resolved style instead, and nothing is written.
    expect(
      resolveOutputStyleToSeed({ pickedStyle: null, availableStyles: ["default", "Whiteboard"] }),
    ).toBeNull();
    expect(resolveOutputStyleToSeed({ pickedStyle: null, availableStyles: undefined })).toBeNull();
  });

  it("seeds None instead of Caveman when defaultOutputStyle is set to None", () => {
    expect(
      resolveOutputStyleToSeed({
        pickedStyle: null,
        availableStyles: ["default", "Caveman", "Whiteboard"],
        preferredStyle: "default",
      }),
    ).toBe("default");
  });
});
