import { describe, expect, it, vi } from "vite-plus/test";

import { applyChatContentWidth, chatContentMaxWidth } from "./chatContentWidth";

describe("applyChatContentWidth", () => {
  it("widens the conversation column past its floor", () => {
    const setProperty = vi.fn();

    applyChatContentWidth({ style: { setProperty } } as unknown as HTMLElement, 80);

    expect(setProperty).toHaveBeenCalledWith("--chat-content-max-width", "max(48rem, 80%)");
  });

  it("keeps the column's floor at the narrowest share", () => {
    expect(chatContentMaxWidth(20)).toBe("max(48rem, 20%)");
  });
});
