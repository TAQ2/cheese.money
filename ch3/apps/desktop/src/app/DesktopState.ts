import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export class DesktopState extends Context.Service<
  DesktopState,
  {
    readonly backendReady: Ref.Ref<boolean>;
    readonly quitting: Ref.Ref<boolean>;
    /**
     * install.sh is running and will quit this app itself. Its quit must not
     * meet the "an agent is working" dialog: nobody is there to answer it,
     * and the script gives up after ninety seconds and installs nothing.
     */
    readonly installingUpdate: Ref.Ref<boolean>;
  }
>()("@ch3tools/desktop/app/DesktopState") {}

const make = Effect.all({
  backendReady: Ref.make(false),
  quitting: Ref.make(false),
  installingUpdate: Ref.make(false),
});

export const layer = Layer.effect(DesktopState, make);
