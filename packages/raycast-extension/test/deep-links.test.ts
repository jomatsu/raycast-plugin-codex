import { describe, expect, it, vi } from "vitest";

vi.mock("@raycast/api", () => ({
  getApplications: vi.fn(),
  getPreferenceValues: vi.fn(() => ({})),
  open: vi.fn(),
  showToast: vi.fn(),
  Toast: { Style: { Failure: "failure" } },
}));
vi.mock("@raycast/utils", () => ({
  executeSQL: vi.fn(),
}));

import { newTaskDeepLink, threadDeepLink } from "../src/lib/open-codex";

describe("Codex deep links", () => {
  it("encodes spaces and Japanese thread IDs", () => {
    expect(threadDeepLink("thread id 日本語")).toBe("codex://threads/thread%20id%20%E6%97%A5%E6%9C%AC%E8%AA%9E");
  });

  it("encodes a path target and preserves its decoded value", () => {
    const path = "/Users/test/日本語 project/with spaces";
    const link = newTaskDeepLink({ path });

    expect(link).toMatch(/^codex:\/\/new\?path=/);
    expect(link).toContain("%E6%97%A5%E6%9C%AC%E8%AA%9E");
    expect(link).toContain("+");
    expect(new URL(link).searchParams.get("path")).toBe(path);
  });

  it("supports an origin URL target independently of a path", () => {
    const originUrl = "https://github.com/example/日本語 repo";
    const link = newTaskDeepLink({ originUrl });

    expect(new URL(link).searchParams.get("originUrl")).toBe(originUrl);
  });

  it("includes both path and origin URL when supplied", () => {
    const link = newTaskDeepLink({ path: "/tmp/project", originUrl: "https://github.com/example/project" });
    const params = new URL(link).searchParams;

    expect(params.get("path")).toBe("/tmp/project");
    expect(params.get("originUrl")).toBe("https://github.com/example/project");
  });

  it("rejects a target with neither path nor origin URL", () => {
    expect(() => newTaskDeepLink({})).toThrow("A path or origin URL is required");
  });
});
