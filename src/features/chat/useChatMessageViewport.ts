import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChatMessage as ChatMessageType } from "./chatTypes";

export interface ChatMessageViewportOptions {
  messages: readonly ChatMessageType[];
  isLoadingMessages: boolean;
  activeSessionId: string | null;
  isViewportActive: boolean;
}

/** Owns virtualized message measurement, stick-to-bottom behavior, and entrance animation state. */
export function useChatMessageViewport({
  messages,
  isLoadingMessages,
  activeSessionId,
  isViewportActive,
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
    // 非対象パネルの maximize 中も Chat DOM は keepalive されるが、親 cell は
    // 0px + visibility:hidden になる。その休眠 geometry を測ると行高 cache と
    // scroll anchor が壊れるため、表示中だけ scroll/ResizeObserver を接続する。
    // enabled=false は測定 cache 自体を消すので使わず、scroll element のみ外す。
    getScrollElement: () =>
      isViewportActive ? scrollContainerRef.current : null,
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
  const measureMessageElement = useCallback(
    (node: HTMLDivElement | null) => {
      // measureElement は scroll element が外れていても同期測定するため、
      // 休眠中に新しく mount した行だけは collapsed geometry を記録させない。
      // null は stale node の登録解除に必要なので常に転送する。
      if (node === null || isViewportActive) {
        virtualizer.measureElement(node);
      }
    },
    [isViewportActive, virtualizer],
  );
  const wasViewportActiveRef = useRef(isViewportActive);
  useLayoutEffect(() => {
    const wasActive = wasViewportActiveRef.current;
    wasViewportActiveRef.current = isViewportActive;
    if (!isViewportActive || wasActive) return;

    // useVirtualizer の layout effect が先に observer と offset を復元する。
    // その値へ方向判定を同期し、末尾追従中だけ即座に末尾へ戻す。
    const element = scrollContainerRef.current;
    if (!element) return;
    lastScrollTopRef.current = element.scrollTop;
    if (stickToBottomRef.current) scrollToBottom();
  }, [isViewportActive, scrollToBottom]);
  const handleListScroll = useCallback(() => {
    if (!isViewportActive) return;
    const element = scrollContainerRef.current;
    if (!element) return;
    const distance =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distance < 120) stickToBottomRef.current = true;
    else if (element.scrollTop < lastScrollTopRef.current)
      stickToBottomRef.current = false;
    lastScrollTopRef.current = element.scrollTop;
  }, [isViewportActive]);
  const totalSize = virtualizer.getTotalSize();
  useEffect(() => {
    if (!isViewportActive) return;
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
  }, [isViewportActive, totalSize, scrollToBottom]);

  const lastJumpedSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      activeSessionId !== lastJumpedSessionRef.current &&
      !isLoadingMessages
    ) {
      lastJumpedSessionRef.current = activeSessionId;
      stickToBottomRef.current = true;
      if (isViewportActive) scrollToBottom();
    }
  }, [activeSessionId, isLoadingMessages, isViewportActive, scrollToBottom]);

  return {
    bottomRef,
    scrollContainerRef,
    visibleMessages,
    virtualizer,
    entranceAnim,
    scrollToBottom,
    measureMessageElement,
    handleListScroll,
  };
}
