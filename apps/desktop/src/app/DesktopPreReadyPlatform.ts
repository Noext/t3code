// @effect-diagnostics nodeBuiltinImport:off - pre-ready Electron setup reads settings and prepares the Linux desktop entry synchronously before app services are available.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as DesktopEarlyElectronStartup from "./DesktopEarlyElectronStartup.ts";
import { resolveDesktopAppBranding } from "./DesktopEnvironment.ts";
import { renderUrlHandlerDesktopEntry } from "./DesktopLinuxUrlHandler.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";

export interface DesktopPreReadyCommandLineReader {
  readonly hasSwitch: (switchName: string) => boolean;
  readonly getSwitchValue: (switchName: string) => string;
}

function readCommandLineSwitchValue(
  commandLine: DesktopPreReadyCommandLineReader,
  switchName: string,
): string | null {
  if (!commandLine.hasSwitch(switchName)) {
    return null;
  }

  const value = commandLine.getSwitchValue(switchName).trim();
  return value.length > 0 ? value : null;
}

export const WSLG_SCALE_FACTOR_ENV = "T3CODE_DESKTOP_SCALE_FACTOR";

/**
 * WSLg is the only Linux session where the compositor's real output is smaller
 * than the X screen Xwayland reports: the RDP surface is the Windows work area
 * (the taskbar is excluded) while Xwayland keeps advertising the full panel.
 */
export function isWslgSession(env: Readonly<Record<string, string | undefined>>): boolean {
  return (
    (env.WAYLAND_DISPLAY?.trim() ?? "").length > 0 &&
    ((env.WSL_DISTRO_NAME?.trim() ?? "").length > 0 ||
      (env.WSL_INTEROP?.trim() ?? "").length > 0)
  );
}

/**
 * Chromium derives no device scale factor from WSLg: Xwayland advertises the host
 * panel in physical pixels while the compositor draws the RDP surface in the
 * host's scaled logical space, so a 125% Windows display yields a 2560x1440
 * surface rendered with `devicePixelRatio: 1`. The UI comes out 20% smaller than
 * native, which makes click targets feel offset. Pinning the scale factor restores
 * native sizing. Opt-in through the env var because only the user knows their host
 * scale, and a wrong guess would oversize the UI.
 */
export function resolveWslgDeviceScaleFactor(input: {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly hasSwitch: (switchName: string) => boolean;
}): string | null {
  if (input.platform !== "linux") return null;
  if (!isWslgSession(input.env) || input.hasSwitch("force-device-scale-factor")) return null;
  const requested = Number(input.env[WSLG_SCALE_FACTOR_ENV]?.trim() ?? "");
  if (!Number.isFinite(requested) || requested <= 0 || requested > 4) return null;
  return String(requested);
}

export const resolveEarlyLinuxElectronOptionsFromProcess =
  (): DesktopEarlyElectronStartup.EarlyLinuxElectronOptions =>
    DesktopEarlyElectronStartup.resolveEarlyLinuxElectronOptions({
      env: process.env,
      homeDirectory: NodeOS.homedir(),
      joinPath: NodePath.posix.join,
      readFileString: (path) => NodeFS.readFileSync(path, "utf8"),
    });

export class DesktopPreReadyElectronOptions extends Context.Service<
  DesktopPreReadyElectronOptions,
  {
    readonly linux: DesktopEarlyElectronStartup.EarlyLinuxElectronOptions | null;
    readonly linuxPasswordStoreCommandLine: string | null;
  }
>()("@t3tools/desktop/app/DesktopPreReadyPlatform/DesktopPreReadyElectronOptions") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  return yield* Effect.sync((): DesktopPreReadyElectronOptions["Service"] => {
    const linuxPasswordStoreCommandLine =
      platform === "linux"
        ? readCommandLineSwitchValue(Electron.app.commandLine, "password-store")
        : null;
    const linux = platform === "linux" ? resolveEarlyLinuxElectronOptionsFromProcess() : null;

    if (linux !== null) {
      // The portal also requires a valid desktop entry. An AppImage update may
      // have removed the executable referenced by the previous launch's entry.
      try {
        const applicationsDir = NodePath.posix.join(
          process.env.XDG_DATA_HOME?.trim() ||
            NodePath.posix.join(NodeOS.homedir(), ".local", "share"),
          "applications",
        );
        NodeFS.mkdirSync(applicationsDir, { recursive: true });
        const iconPath = Electron.app.isPackaged
          ? NodePath.posix.join(
              applicationsDir,
              "..",
              "icons",
              `${linux.linuxDesktopEntryName}.png`,
            )
          : undefined;
        if (iconPath !== undefined) {
          try {
            NodeFS.mkdirSync(NodePath.posix.dirname(iconPath), { recursive: true });
            NodeFS.copyFileSync(
              NodePath.posix.join(
                Electron.app.getAppPath(),
                "apps/desktop/prod-resources/icon.png",
              ),
              iconPath,
            );
          } catch {
            // Icon installation is optional; registration retries after readiness.
          }
        }
        NodeFS.writeFileSync(
          NodePath.posix.join(applicationsDir, linux.linuxDesktopEntryName),
          renderUrlHandlerDesktopEntry({
            displayName: resolveDesktopAppBranding({
              isDevelopment: linux.isDevelopment,
              appVersion: Electron.app.getVersion(),
            }).displayName,
            execTarget: process.env.APPIMAGE?.trim() || process.execPath,
            scheme: ElectronProtocol.getDesktopScheme(linux.isDevelopment),
            ...(iconPath === undefined ? {} : { iconPath }),
          }),
          "utf8",
        );
      } catch {
        // The URL handler retries with the full environment and logs failures.
      }
      // Chromium caches its portal registration during startup. Set the identity
      // before any asynchronous work can initialize it with Electron's default.
      Electron.app.setDesktopName(linux.linuxDesktopEntryName);
      Electron.app.commandLine.appendSwitch("class", linux.linuxWmClass);
      if (linux.passwordStore !== null && linuxPasswordStoreCommandLine === null) {
        Electron.app.commandLine.appendSwitch("password-store", linux.passwordStore);
      }
      const wslgScaleFactor = resolveWslgDeviceScaleFactor({
        platform,
        env: process.env,
        hasSwitch: (switchName) => Electron.app.commandLine.hasSwitch(switchName),
      });
      if (wslgScaleFactor !== null) {
        Electron.app.commandLine.appendSwitch("force-device-scale-factor", wslgScaleFactor);
      }
    }

    return { linux, linuxPasswordStoreCommandLine };
  });
}).pipe(Effect.withSpan("desktop.electron.configureBeforeReady"));

// Keep Electron's strict pre-ready setup isolated so later runtime layers cannot
// observe app readiness before scheme privileges and command-line switches exist.
export const layer = Layer.mergeAll(
  ElectronProtocol.layerSchemePrivileges,
  Layer.effect(DesktopPreReadyElectronOptions, make),
);
