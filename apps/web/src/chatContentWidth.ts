import type { ChatContentWidthPercent } from "@t3tools/contracts/settings";

/**
 * The conversation column's ceiling, shared by the timeline and the composer.
 * The 48rem floor is the column's old fixed width: the preference widens it on
 * large windows and never narrows it, so narrow clients (phones, small panes)
 * keep filling the pane exactly as before.
 */
export function chatContentMaxWidth(percent: ChatContentWidthPercent): string {
  return `max(48rem, ${percent}%)`;
}

/**
 * The percentage resolves against the containing block, so nesting the value
 * compounds it: an inner element inside an already-capped column would get a
 * share of that column instead of of the pane. Apply it once per column — the
 * composer stack wrapper in `ChatView` and the timeline row wrapper in
 * `MessagesTimeline` — and let everything inside them stay `w-full`.
 */
export function applyChatContentWidth(root: HTMLElement, percent: ChatContentWidthPercent): void {
  root.style.setProperty("--chat-content-max-width", chatContentMaxWidth(percent));
}
