import { describe, expect, it, vi } from "vitest";

import {
  configureLinuxGraphics,
  resolveLinuxGraphicsPolicy,
  type LinuxGraphicsPolicyOptions,
} from "./linuxGraphics.js";

const linuxWaylandOptions: LinuxGraphicsPolicyOptions = {
  platform: "linux",
  ozonePlatform: undefined,
  xdgSessionType: "wayland",
  hasWebGpuAdapterOverride: false,
};

describe("resolveLinuxGraphicsPolicy", () => {
  it.each([
    {
      name: "an explicit Wayland Ozone platform",
      options: {
        ...linuxWaylandOptions,
        ozonePlatform: "wayland",
        xdgSessionType: "x11",
      },
    },
    {
      name: "automatic Ozone selection in a Wayland session",
      options: {
        ...linuxWaylandOptions,
        ozonePlatform: "auto",
      },
    },
    {
      name: "an unspecified Ozone platform in a Wayland session",
      options: linuxWaylandOptions,
    },
  ])("selects OpenGL ES for $name", ({ options }) => {
    expect(resolveLinuxGraphicsPolicy(options)).toEqual({
      webGpuAdapter: "opengles",
    });
  });

  it.each([
    {
      name: "an explicit X11 Ozone platform",
      options: {
        ...linuxWaylandOptions,
        ozonePlatform: "x11",
      },
    },
    {
      name: "an X11 session",
      options: {
        ...linuxWaylandOptions,
        xdgSessionType: "x11",
      },
    },
    {
      name: "another operating system",
      options: {
        ...linuxWaylandOptions,
        platform: "darwin" as const,
        ozonePlatform: "wayland",
      },
    },
    {
      name: "an existing WebGPU adapter override",
      options: {
        ...linuxWaylandOptions,
        hasWebGpuAdapterOverride: true,
      },
    },
  ])("does not override $name", ({ options }) => {
    expect(resolveLinuxGraphicsPolicy(options)).toBeUndefined();
  });
});

describe("configureLinuxGraphics", () => {
  it("appends the OpenGL ES adapter before startup on native Wayland", () => {
    const commandLine = {
      hasSwitch: vi.fn(() => false),
      getSwitchValue: vi.fn(() => ""),
      appendSwitch: vi.fn(),
    };

    configureLinuxGraphics(
      { commandLine },
      {
        platform: "linux",
        env: { XDG_SESSION_TYPE: "wayland" },
      },
    );

    expect(commandLine.appendSwitch).toHaveBeenCalledOnce();
    expect(commandLine.appendSwitch).toHaveBeenCalledWith(
      "use-webgpu-adapter",
      "opengles",
    );
  });

  it("preserves an existing user-selected WebGPU adapter", () => {
    const commandLine = {
      hasSwitch: vi.fn((name: string) => name === "use-webgpu-adapter"),
      getSwitchValue: vi.fn(() => ""),
      appendSwitch: vi.fn(),
    };

    configureLinuxGraphics(
      { commandLine },
      {
        platform: "linux",
        env: { XDG_SESSION_TYPE: "wayland" },
      },
    );

    expect(commandLine.appendSwitch).not.toHaveBeenCalled();
  });
});
