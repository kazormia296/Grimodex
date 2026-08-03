import { useCallback, useMemo, useState } from "react";
import {
  DndContext,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GRID_DND_MEASURING } from "./gridDndMeasuring";

const ROW_HEIGHT = 72;
const ROW_COUNT = 100;
const TARGET_INDEX = 60;

function VirtualRow({
  index,
  draggable,
}: {
  index: number;
  draggable: boolean;
}) {
  const id = `row-${index}`;
  const { isOver, setNodeRef: setDroppableNodeRef } = useDroppable({ id });
  const {
    attributes,
    listeners,
    setNodeRef: setDraggableNodeRef,
  } = useDraggable({ id, disabled: !draggable });
  const setNodeRef = useCallback(
    (node: HTMLElement | null) => {
      setDroppableNodeRef(node);
      setDraggableNodeRef(node);
    },
    [setDraggableNodeRef, setDroppableNodeRef],
  );
  return (
    <div
      ref={setNodeRef}
      data-testid={id}
      data-droppable={isOver ? "over" : "idle"}
      {...(draggable ? attributes : {})}
      {...(draggable ? listeners : {})}
      style={{
        position: "absolute",
        top: index * ROW_HEIGHT,
        left: 8,
        right: 8,
        height: ROW_HEIGHT - 8,
        border: "1px solid black",
        background: isOver ? "rgb(220, 240, 255)" : "white",
        touchAction: "none",
      }}
    >
      {id}
    </div>
  );
}

function VirtualDndLab() {
  const [windowStart, setWindowStart] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [droppedOn, setDroppedOn] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 2 } }),
  );
  const indexes = useMemo(() => {
    const next = Array.from(
      { length: 6 },
      (_, offset) => windowStart + offset,
    ).filter((index) => index < ROW_COUNT);
    if (activeId === "row-0" && !next.includes(0)) next.push(0);
    return next.sort((left, right) => left - right);
  }, [activeId, windowStart]);

  return (
    <DndContext
      sensors={sensors}
      measuring={GRID_DND_MEASURING}
      collisionDetection={pointerWithin}
      onDragStart={(event: DragStartEvent) => {
        setActiveId(String(event.active.id));
      }}
      onDragOver={(event: DragOverEvent) => {
        setOverId(event.over ? String(event.over.id) : null);
      }}
      onDragEnd={(event: DragEndEvent) => {
        setDroppedOn(event.over ? String(event.over.id) : null);
        setActiveId(null);
      }}
    >
      <div
        data-testid="virtual-dnd-scroller"
        onScroll={(event) => {
          setWindowStart(
            Math.max(0, Math.floor(event.currentTarget.scrollTop / ROW_HEIGHT)),
          );
        }}
        style={{
          position: "fixed",
          top: 20,
          left: 20,
          width: 360,
          height: 240,
          overflowY: "auto",
          border: "1px solid gray",
        }}
      >
        <div
          style={{
            position: "relative",
            height: ROW_COUNT * ROW_HEIGHT,
          }}
        >
          {indexes.map((index) => (
            <VirtualRow key={index} index={index} draggable={index === 0} />
          ))}
        </div>
      </div>
      <output data-testid="active-id">{activeId ?? ""}</output>
      <output data-testid="over-id">{overId ?? ""}</output>
      <output data-testid="dropped-on">{droppedOn ?? ""}</output>
    </DndContext>
  );
}

async function settleFrames(count = 2) {
  for (let index = 0; index < count; index += 1) {
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
  }
}

describe("Grid virtual DnD measuring (real Chromium)", () => {
  it("measures a droppable that mounts only after a long drag scroll", async () => {
    const { getByTestId, findByTestId } = render(<VirtualDndLab />);
    const source = getByTestId("row-0");
    const sourceRect = source.getBoundingClientRect();
    const pointerId = 11;
    fireEvent.pointerDown(source, {
      pointerId,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: sourceRect.left + 24,
      clientY: sourceRect.top + 24,
    });
    fireEvent.pointerMove(document, {
      pointerId,
      pointerType: "mouse",
      isPrimary: true,
      buttons: 1,
      clientX: sourceRect.left + 32,
      clientY: sourceRect.top + 32,
    });
    await waitFor(() => {
      expect(getByTestId("active-id").textContent).toBe("row-0");
    });

    const scroller = getByTestId("virtual-dnd-scroller");
    act(() => {
      scroller.scrollTop = (TARGET_INDEX - 1) * ROW_HEIGHT;
      fireEvent.scroll(scroller);
    });
    const target = await findByTestId(`row-${TARGET_INDEX}`);
    expect(document.querySelector('[data-testid="row-1"]')).toBeNull();
    await settleFrames(3);

    const targetRect = target.getBoundingClientRect();
    fireEvent.pointerMove(document, {
      pointerId,
      pointerType: "mouse",
      isPrimary: true,
      buttons: 1,
      clientX: targetRect.left + targetRect.width / 2,
      clientY: targetRect.top + targetRect.height / 2,
    });
    await waitFor(() => {
      expect(getByTestId("over-id").textContent).toBe(`row-${TARGET_INDEX}`);
    });
    fireEvent.pointerUp(document, {
      pointerId,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 0,
      clientX: targetRect.left + targetRect.width / 2,
      clientY: targetRect.top + targetRect.height / 2,
    });
    await waitFor(() => {
      expect(getByTestId("dropped-on").textContent).toBe(`row-${TARGET_INDEX}`);
    });
  });
});
