import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Electron from "electron";

export interface ElectronNotificationInput {
  readonly title: string;
  readonly body: string;
}

/**
 * A macOS/Windows notification from the main process.
 *
 * One use so far, and it is the reason this exists: the in-app update quits
 * CH3 partway through. A dialog, a toast, a banner in the window — all die
 * with the app, and what the person sees is CH3 closing with no word about
 * what comes next. A notification lives in Notification Center after the
 * process is gone, so it can say "it reopens by itself, leave it". Best
 * effort: an unsupported platform or a refused permission shows nothing and
 * fails nothing.
 */
export class ElectronNotification extends Context.Service<
  ElectronNotification,
  {
    readonly show: (input: ElectronNotificationInput) => Effect.Effect<void>;
  }
>()("@ch3tools/desktop/electron/ElectronNotification") {}

export const layer = Layer.succeed(
  ElectronNotification,
  ElectronNotification.of({
    show: (input) =>
      Effect.try(() => {
        if (!Electron.Notification.isSupported()) return;
        new Electron.Notification({ title: input.title, body: input.body }).show();
      }).pipe(Effect.orElseSucceed(() => undefined)),
  }),
);

/** Records what would have been shown. */
export const layerTest = (
  shown: Array<ElectronNotificationInput> = [],
): Layer.Layer<ElectronNotification> =>
  Layer.succeed(
    ElectronNotification,
    ElectronNotification.of({
      show: (input) =>
        Effect.sync(() => {
          shown.push(input);
        }),
    }),
  );
