import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChatMessage as ChatMessageType } from "./chatTypes";

export interface ChatMessageViewportOptions {
  messages: readonly ChatMessageType[];
  isLoadingMessages: boolean;
  activeSessionId: string | null;
}

/** Owns virtualized message measurement, stick-to-bottom behavior, and entrance animation state. */
export function useChatMessageViewport({
  messages,
  isLoadingMessages,
  activeSessionId,
}: ChatMessageViewportOptions) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const visibleMessages = useMemo(
    () =>
      messages.filter(
        (message) => message.role !== "system" && !message.isSummarized,
      ),
    [messages],
  );
  const virtualizer = useVirtualizer({
    count: visibleMessages.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 120,
    overscan: 6,
    getItemKey: (index) => visibleMessages[index]?.id ?? index,
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (
    item,
    _delta,
    instance,
  ) =>
    !stickToBottomRef.current &&
    item.start < (instance.scrollOffset ?? 0) &&
    instance.scrollDirection !== "backward";

  const [entranceAnim, setEntranceAnim] = useState<{
    prevMessages: readonly ChatMessageType[] | null;
    prevLoading: boolean;
    animateIds: ReadonlySet<string>;
  }>({ prevMessages: null, prevLoading: true, animateIds: new Set() });
  if (
    entranceAnim.prevMessages !== visibleMessages ||
    entranceAnim.prevLoading !== isLoadingMessages
  ) {
    const previous = entranceAnim.prevMessages;
    const isPureDelta =
      previous !== null &&
      entranceAnim.prevLoading === isLoadingMessages &&
      previous.length === visibleMessages.length &&
      previous.length > 0 &&
      previous[0].id === visibleMessages[0].id &&
      previous[previous.length - 1].id ===
        visibleMessages[visibleMessages.length - 1].id;
    if (!isPureDelta) {
      const previousIds =
        previous !== null && !entranceAnim.prevLoading
          ? new Set(previous.map((message) => message.id))
          : null;
      setEntranceAnim({
        prevMessages: visibleMessages,
        prevLoading: isLoadingMessages,
        animateIds: previousIds
          ? new Set(
              visibleMessages
                .filter(
                  (message) =>
                    message.role === "user" && !previousIds.has(message.id),
                )
                .map((message) => message.id),
            )
          : new Set(),
      });
    }
  }

  const scrollToBottom = useCallback(() => {
    const node = bottomRef.current;
    if (node && typeof node.scrollIntoView === "function") {
      node.scrollIntoView({ behavior: "auto" });
    }
  }, []);
  const handleListScroll = useCallback(() => {
    const element = scrollContainerRef.current;
    if (!element) return;
    const distance =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distance < 120) stickToBottomRef.current = true;
    else if (element.scrollTop < lastScrollTopRef.current)
      stickToBottomRef.current = false;
    lastScrollTopRef.current = element.scrollTop;
  }, []);
  const totalSize = virtualizer.getTotalSize();
  useEffect(() => {
    if (!stickToBottomRef.current) {
      const element = scrollContainerRef.current;
      if (
        element &&
        element.scrollHeight - element.scrollTop - element.clientHeight < 120
      ) {
        stickToBottomRef.current = true;
      }
    }
    if (stickToBottomRef.current) scrollToBottom();
  }, [totalSize, scrollToBottom]);

  const lastJumpedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      activeSessionId !== lastJumpedSessionRef.current &&
      !isLoadingMessages
    ) {
      lastJumpedSessionRef.current = activeSessionId;
      stickToBottomRef.current = true;
      scrollToBottom();
    }
  }, [activeSessionId, isLoadingMessages, scrollToBottom]);

  return {
    bottomRef,
    scrollContainerRef,
    visibleMessages,
    virtualizer,
    entranceAnim,
    scrollToBottom,
    handleListScroll,
  };
}
