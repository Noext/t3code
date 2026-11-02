// @effect-diagnostics nodeBuiltinImport:off - pre-ready Electron setup reads settings, prepares the Linux desktop entry, and asks Hyprland for its version synchronously before app services are available.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";
import * as HostProcess from "@t3tools/shared/HostProcess";

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

const WSLG_SCALE_FACTOR_ENV = "T3CODE_DESKTOP_SCALE_FACTOR";

/**
 * WSLg is the only Linux session where the compositor's real output is smaller
 * than the X screen Xwayland reports: the RDP surface is the Windows work area
 * (the taskbar is excluded) while Xwayland keeps advertising the full panel.
 */
export function isWslgSession(env: Readonly<Record<string, string | undefined>>): boolean {
  return (
    (env.WAYLAND_DISPLAY?.trim() ?? "").length > 0 &&
    ((env.WSL_DISTRO_NAME?.trim() ?? "").length > 0 || (env.WSL_INTEROP?.trim() ?? "").length > 0)
  );
}

/**
 * Chromium derives no device scale factor from WSLg: Xwayland advertises the host panel while the
 * compositor draws the RDP surface in scaled space, so the UI renders undersized. Opt-in through the
 * env var, since only the user knows their host scale.
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

export const resolveEarlyLinuxElectronOptionsFromProcess = (
  homeDirectory: string,
): DesktopEarlyElectronStartup.EarlyLinuxElectronOptions =>
  DesktopEarlyElectronStartup.resolveEarlyLinuxElectronOptions({
    env: process.env,
    homeDirectory,
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

/** @public */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  return yield* Effect.sync((): DesktopPreReadyElectronOptions["Service"] => {
    const linuxPasswordStoreCommandLine =
      platform === "linux"
        ? readCommandLineSwitchValue(Electron.app.commandLine, "password-store")
        : null;
    const linux =
      platform === "linux" ? resolveEarlyLinuxElectronOptionsFromProcess(homeDirectory) : null;

    if (linux !== null) {
      DesktopEarlyElectronStartup.restoreEarlyLinuxDeviceScaleFactor({
        env: process.env,
        homeDirectory,
        joinPath: NodePath.posix.join,
        commandLine: Electron.app.commandLine,
        readFileString: (path) => NodeFS.readFileSync(path, "utf8"),
        writeFileString: (path, value) => {
          NodeFS.mkdirSync(NodePath.posix.dirname(path), { recursive: true });
          NodeFS.writeFileSync(path, value, "utf8");
        },
      });
      // The portal also requires a valid desktop entry. An AppImage update may
      // have removed the executable referenced by the previous launch's entry.
      try {
        const applicationsDir = NodePath.posix.join(
          process.env.XDG_DATA_HOME?.trim() ||
            NodePath.posix.join(homeDirectory, ".local", "share"),
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
          } catch {}
        }
        NodeFS.writeFileSync(
          NodePath.posix.join(applicationsDir, linux.linuxDesktopEntryName),
          renderUrlHandlerDesktopEntry({
            displayName: resolveDesktopAppBranding({
              isDevelopment: linux.isDevelopment,
              appVersion: Electron.app.getVersion(),
            }).displayName,
            execTarget:
              process.env.T3CODE_DESKTOP_LAUNCHER_PATH?.trim() ||
              process.env.APPIMAGE?.trim() ||
              process.execPath,
            scheme: ElectronProtocol.getDesktopScheme(linux.isDevelopment),
            ...(iconPath === undefined ? {} : { iconPath }),
          }),
          "utf8",
        );
      } catch {}
      // Chromium caches portal identity; set it before any asynchronous initialization.
      Electron.app.setDesktopName(linux.linuxDesktopEntryName);
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
      // Chromium keeps only the last --disable-features value, so pass the merged list.
      const disableFeatures = DesktopEarlyElectronStartup.resolveLinuxDisableFeaturesSwitch({
        env: process.env,
        ozonePlatform: readCommandLineSwitchValue(Electron.app.commandLine, "ozone-platform"),
        enableFeatures: readCommandLineSwitchValue(Electron.app.commandLine, "enable-features"),
        disableFeatures: readCommandLineSwitchValue(Electron.app.commandLine, "disable-features"),
        readHyprctlVersionJson: () =>
          NodeChildProcess.execFileSync("hyprctl", ["version", "-j"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 1000,
            maxBuffer: 64 * 1024,
          }),
      });
      if (disableFeatures !== null) {
        Electron.app.commandLine.appendSwitch("disable-features", disableFeatures);
      }
    }

    return { linux, linuxPasswordStoreCommandLine };
  });
}).pipe(Effect.withSpan("desktop.electron.configureBeforeReady"));

// Complete scheme privileges and switches before later layers can observe app readiness.
export const layer = Layer.mergeAll(
  ElectronProtocol.layerSchemePrivileges,
  Layer.effect(DesktopPreReadyElectronOptions, make),
);
