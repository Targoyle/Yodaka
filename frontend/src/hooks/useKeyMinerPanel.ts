import { useEffect, useState, type RefObject } from "react";
import {
  disposeWebGpuMinerRuntime,
  prewarmWebGpuMiner,
} from "../lib/miner/webgpu";
import {
  buildKeyMinerOpenLocation,
  resolveKeyMinerLaunchFromLocation,
  stripKeyMinerLaunchFromLocation,
  type KeyMinerLaunchConfig,
} from "../lib/miner/launch";

const KEY_MINER_PREWARM_IDLE_TIMEOUT_MS = 1_500;
const KEY_MINER_PREWARM_FALLBACK_DELAY_MS = 800;

type IdleDeadlineLike = {
  didTimeout: boolean;
  timeRemaining: () => number;
};

type WindowWithIdleCallback = Window & {
  requestIdleCallback?: (
    callback: (deadline: IdleDeadlineLike) => void,
    options?: { timeout?: number },
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

type UseKeyMinerPanelArgs = {
  settingsMenuRef: RefObject<HTMLDetailsElement | null>;
};

export function useKeyMinerPanel(args: UseKeyMinerPanelArgs) {
  const [keyMinerLaunchConfig, setKeyMinerLaunchConfig] = useState<KeyMinerLaunchConfig>(() =>
    resolveKeyMinerLaunchFromLocation(),
  );
  const [keyMinerOpen, setKeyMinerOpen] = useState(() => keyMinerLaunchConfig.open);
  const [relayBootstrapDeferred, setRelayBootstrapDeferred] = useState(
    () => keyMinerLaunchConfig.open,
  );

  useEffect(() => {
    if (typeof window === "undefined" || !keyMinerOpen) {
      return;
    }

    const idleWindow = window as WindowWithIdleCallback;
    let cancelled = false;
    let timeoutId: number | null = null;
    let idleId: number | null = null;
    const runPrewarm = () => {
      if (cancelled) {
        return;
      }

      prewarmWebGpuMiner();
    };

    if (typeof idleWindow.requestIdleCallback === "function") {
      idleId = idleWindow.requestIdleCallback(
        () => {
          runPrewarm();
        },
        {
          timeout: KEY_MINER_PREWARM_IDLE_TIMEOUT_MS,
        },
      );
    } else {
      timeoutId = window.setTimeout(runPrewarm, KEY_MINER_PREWARM_FALLBACK_DELAY_MS);
    }

    return () => {
      cancelled = true;

      if (idleId !== null && typeof idleWindow.cancelIdleCallback === "function") {
        idleWindow.cancelIdleCallback(idleId);
      }

      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }

      disposeWebGpuMinerRuntime();
    };
  }, [keyMinerOpen]);

  useEffect(() => {
    return () => {
      disposeWebGpuMinerRuntime();
    };
  }, []);

  useEffect(() => {
    if (!keyMinerOpen) {
      setRelayBootstrapDeferred(false);
    }
  }, [keyMinerOpen]);

  function handleKeyMinerToggle() {
    const next = !keyMinerOpen;

    if (next) {
      args.settingsMenuRef.current?.removeAttribute("open");
      const nextUrl = buildKeyMinerOpenLocation();

      if (typeof window !== "undefined" && nextUrl) {
        window.history.replaceState(null, "", nextUrl);
      }

      setKeyMinerLaunchConfig({
        open: true,
        prefix: "",
        suffix: "",
      });
    } else {
      const nextUrl = stripKeyMinerLaunchFromLocation();

      if (typeof window !== "undefined" && nextUrl) {
        window.history.replaceState(null, "", nextUrl);
      }

      setKeyMinerLaunchConfig({
        open: false,
        prefix: "",
        suffix: "",
      });
    }

    setKeyMinerOpen(next);
  }

  return {
    handleKeyMinerToggle,
    keyMinerLaunchConfig,
    keyMinerOpen,
    relayBootstrapDeferred,
  };
}
