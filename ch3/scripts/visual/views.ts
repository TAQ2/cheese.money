/**
 * The catalogue of captured surfaces.
 *
 * Everything a view needs is data: where to go, what to do once there, and what
 * must be on screen for the capture to count. Adding a surface is one entry —
 * no runner changes. See README.md ("Adding a view").
 */

export interface ViewContext {
  readonly environmentId: string;
  readonly threadId: string;
  readonly seeded: boolean;
}

export type ViewStep =
  | { readonly kind: "click"; readonly selector: string }
  /**
   * Click `selector` until `until` matches, then confirm it still matches a
   * beat later.
   *
   * This exists because "click it if it needs clicking" cannot be expressed as
   * a one-shot presence test against a React app. Two races make that wrong,
   * and both were observed here:
   *
   * 1. Straight after `domcontentloaded` nothing has mounted, so a presence
   *    test finds no button, silently skips the click, and the run then waits
   *    out its whole timeout for a state nothing ever asked for.
   * 2. Client settings hydrate asynchronously, and the sidebar renders its
   *    pre-hydration default first. A test that reads the toggle in that
   *    window sees a mode that is about to be replaced.
   *
   * Converging on the state — retry, then re-check — is immune to both.
   */
  | { readonly kind: "clickUntil"; readonly selector: string; readonly until: string }
  | { readonly kind: "waitFor"; readonly selector: string }
  | { readonly kind: "waitForAbsent"; readonly selector: string }
  | { readonly kind: "settle"; readonly millis: number };

export interface ViewCheck {
  readonly label: string;
  readonly selector: string;
  /** Minimum number of matches required for the view to pass. */
  readonly minimum: number;
}

export interface ViewSpec {
  readonly id: string;
  readonly summary: string;
  readonly path: (context: ViewContext) => string;
  /** Overrides the run-wide viewport (the board needs the extra width). */
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Skipped with a logged reason when fixtures were not seeded. */
  readonly requiresFixtures?: boolean;
  readonly steps?: ReadonlyArray<ViewStep>;
  readonly checks: ReadonlyArray<ViewCheck>;
}

/**
 * The sidebar mode is a persisted client setting, so a view that depends on it
 * sets it rather than inheriting whatever the previous view left behind.
 *
 * Waiting for the toggle group first means the click is only attempted once the
 * app has actually mounted; `clickUntil` then converges on the mode regardless
 * of how long settings hydration takes. Clicking a button that is already
 * pressed is never needed — `until` is checked before every attempt — so this
 * stays idempotent.
 */
const useSidebarMode = (mode: "inbox" | "projects"): ReadonlyArray<ViewStep> => [
  { kind: "waitFor", selector: '[data-testid="sidebar-mode-toggle"]' },
  {
    kind: "clickUntil",
    selector: `[data-testid="sidebar-mode-toggle-${mode}"][aria-pressed="false"]`,
    until: `[data-testid="sidebar-mode-toggle-${mode}"][aria-pressed="true"]`,
  },
];

/** Transient overlays that must be gone before a frame is worth comparing. */
export const VOLATILE_SELECTORS: ReadonlyArray<string> = ["text=Reconnect this environment"];

export const VISUAL_VIEWS: ReadonlyArray<ViewSpec> = [
  {
    id: "draft-landing",
    summary: "Empty draft thread with the composer and the inbox sidebar.",
    path: () => "/",
    steps: [...useSidebarMode("inbox"), { kind: "settle", millis: 750 }],
    checks: [
      { label: "composer", selector: '[data-testid="composer-editor"]', minimum: 1 },
      { label: "sidebar mode toggle", selector: '[data-testid="sidebar-mode-toggle"]', minimum: 1 },
      {
        label: "command palette trigger",
        selector: '[data-testid="command-palette-trigger"]',
        minimum: 1,
      },
    ],
  },
  {
    id: "sidebar-inbox",
    summary: "Inbox-mode sidebar: seeded threads, snoozed and settled shelves.",
    path: () => "/",
    requiresFixtures: true,
    steps: [...useSidebarMode("inbox"), { kind: "settle", millis: 750 }],
    checks: [
      { label: "thread cards", selector: '[data-testid="sidebar-v2-row-card"]', minimum: 3 },
      {
        label: "settled shelf",
        selector: '[data-testid="sidebar-v2-settled-shelf-toggle"]',
        minimum: 1,
      },
      {
        label: "snoozed shelf",
        selector: '[data-testid="sidebar-v2-snoozed-shelf-toggle"]',
        minimum: 1,
      },
    ],
  },
  {
    id: "sidebar-projects",
    summary: "Projects-mode sidebar: threads grouped under their project.",
    path: () => "/",
    requiresFixtures: true,
    steps: [...useSidebarMode("projects"), { kind: "settle", millis: 750 }],
    checks: [
      { label: "project thread rows", selector: '[data-testid^="thread-row-"]', minimum: 3 },
      {
        label: "add project trigger",
        selector: '[data-testid="sidebar-add-project-trigger"]',
        minimum: 1,
      },
    ],
  },
  {
    id: "thread-chat",
    summary: "A seeded conversation: user request, assistant answer, composer.",
    path: (context) => `/${context.environmentId}/${context.threadId}`,
    requiresFixtures: true,
    steps: [...useSidebarMode("inbox"), { kind: "settle", millis: 1_000 }],
    checks: [
      { label: "composer", selector: '[data-testid="composer-editor"]', minimum: 1 },
      { label: "assistant answer", selector: "text=612 tests passed", minimum: 1 },
    ],
  },
  {
    id: "settings-general",
    summary: "Settings shell on the General panel.",
    path: () => "/settings/general",
    steps: [{ kind: "settle", millis: 750 }],
    checks: [
      { label: "settings panel", selector: '[data-testid="settings-panel"]', minimum: 1 },
      { label: "settings nav", selector: '[data-testid="settings-nav"]', minimum: 1 },
    ],
  },
  {
    id: "kanban-board",
    summary: "Kanban board: seven columns, cards in both lanes, WIP dropdowns.",
    path: () => "/kanban",
    viewport: { width: 1800, height: 1000 },
    requiresFixtures: true,
    steps: [
      { kind: "waitFor", selector: '[data-testid="kanban-card"]' },
      { kind: "settle", millis: 1_000 },
    ],
    checks: [
      { label: "board", selector: '[data-testid="kanban-board"]', minimum: 1 },
      { label: "columns", selector: '[data-testid^="kanban-column-"]', minimum: 7 },
      { label: "cards", selector: '[data-testid="kanban-card"]', minimum: 5 },
      // The two horizontal bands: one labelled gutter each, and an agent-lane
      // cell under every column whether or not an agent is working there.
      { label: "lane gutters", selector: '[data-testid^="kanban-lane-"]', minimum: 2 },
      { label: "agent lane cells", selector: '[data-testid^="kanban-agent-"]', minimum: 7 },
      // Five, not seven: `snoozed` and `settled` are lifecycle lanes, and
      // KanbanBoardView deliberately renders no WIP control for them.
      { label: "WIP dropdowns", selector: '[aria-label^="WIP limit for"]', minimum: 5 },
    ],
  },
  {
    id: "kanban-metrics",
    summary: "Kanban board with the flow-metrics side panel open.",
    path: () => "/kanban",
    viewport: { width: 1800, height: 1000 },
    requiresFixtures: true,
    steps: [
      { kind: "waitFor", selector: '[data-testid="kanban-card"]' },
      { kind: "click", selector: '[data-testid="kanban-metrics-toggle"]' },
      { kind: "waitFor", selector: '[data-testid="kanban-metrics-panel"]' },
      { kind: "settle", millis: 750 },
    ],
    checks: [
      { label: "metrics panel", selector: '[data-testid="kanban-metrics-panel"]', minimum: 1 },
      { label: "columns", selector: '[data-testid^="kanban-column-"]', minimum: 7 },
    ],
  },
];
