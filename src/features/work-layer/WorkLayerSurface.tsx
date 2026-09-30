import { BatchReview } from "./BatchReview";
import { AttentionArrivalGutter } from "./AttentionArrivalGutter";
import { ChangeReview } from "./ChangeReview";
import { DeepInspection } from "./DeepInspection";
import { ResolveLens } from "./ResolveLens";
import { ResolveProjection } from "./ResolveProjection";
import { ResolvedReceipt } from "./ResolvedReceipt";
import { SystemActivity } from "./SystemActivity";
import { SystemBlocked } from "./SystemBlocked";
import { SystemRunInspection } from "./SystemRunInspection";
import { TaskTray } from "./TaskTray";
import { WorkLedger } from "./WorkLedger";
import { useWorkLayer } from "./WorkLayerContext";
import { WorkLayerModalPortal } from "./WorkLayerModalPortal";

export function WorkLayerSurface() {
  const workLayer = useWorkLayer();
  if (workLayer == null) return null;
  if (workLayer.navigation.mode === "ambient") {
    return <AttentionArrivalGutter />;
  }

  let surface = null;
  switch (workLayer.navigation.mode) {
    case "tray-attention":
      surface = <TaskTray door="attention" />;
      break;
    case "tray-focus":
      surface = <TaskTray door="focus" />;
      break;
    case "tray-disposed":
      surface = <TaskTray door="attention" />;
      break;
    case "ledger":
      surface = <WorkLedger />;
      break;
    case "lens":
      surface = <ResolveLens />;
      break;
    case "portal":
      surface = <ResolveLens />;
      break;
    case "projection":
      surface = <ResolveProjection />;
      break;
    case "change-review":
      surface = <ChangeReview />;
      break;
    case "batch":
      surface = <BatchReview />;
      break;
    case "system-activity":
      surface = <SystemActivity />;
      break;
    case "system-blocked":
      surface = <SystemBlocked />;
      break;
    case "inspect":
      surface = workLayer.navigation.history.at(-1)?.startsWith("system-") ? (
        <SystemRunInspection />
      ) : (
        <DeepInspection />
      );
      break;
    case "resolved":
      surface = <ResolvedReceipt />;
      break;
  }

  return ["projection", "change-review", "batch", "inspect"].includes(
    workLayer.navigation.mode,
  ) ? (
    <WorkLayerModalPortal>{surface}</WorkLayerModalPortal>
  ) : (
    surface
  );
}
