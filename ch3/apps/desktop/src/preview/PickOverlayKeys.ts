/**
 * Keeping the annotation overlay's keystrokes out of the page underneath.
 *
 * The overlay is injected into somebody else's document, and plenty of pages
 * bind their own shortcuts on `document`. The report this came from was a
 * slide deck: typing in "Describe the change…" and pressing space inserted
 * nothing and advanced the deck a slide, because the deck's own handler saw a
 * space that nothing had stopped.
 *
 * Lives in its own module, beside `PickLabelPosition`, for the reason that one
 * does: `PickPreload` imports `ipcRenderer`, so nothing in it can be reached
 * from a test.
 *
 * @module preview/PickOverlayKeys
 */

/** The key events a page can bind a shortcut to. */
export const OVERLAY_SEALED_KEY_EVENTS = ["keydown", "keypress", "keyup"] as const;

/** Just enough of an event for this to be testable without a DOM. */
export interface SealableKeyEvent {
  stopPropagation: () => void;
}

/** Just enough of an element. */
export interface SealableRoot {
  addEventListener: (type: string, handler: (event: SealableKeyEvent) => void) => void;
}

/**
 * Stop the overlay's key events at its own root, on the way out.
 *
 * Bubbling rather than capturing, and that is the whole subtlety: the preload
 * also has a `keydown` listener on `window` in the capture phase, and stopping
 * there would halt the event before it ever reached the textarea — taking the
 * ⌘/Ctrl+Enter that attaches an annotation with it. By the time an event
 * bubbles back out to this root, the overlay's own listeners have run and only
 * the page is left downstream.
 *
 * `preventDefault` is deliberately never called. Propagation and the default
 * action are independent: the character still has to be inserted.
 */
export function sealOverlayKeyEvents(root: SealableRoot): void {
  for (const type of OVERLAY_SEALED_KEY_EVENTS) {
    root.addEventListener(type, (event) => {
      event.stopPropagation();
    });
  }
}
