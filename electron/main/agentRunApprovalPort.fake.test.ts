import { describeAgentRunApprovalPortContract } from "./agentRunApprovalPort.contract.js";
import { FakeAgentRunApprovalPort } from "./agentRunApprovalPort.fake.js";

describeAgentRunApprovalPortContract("FakeAgentRunApprovalPort", () => {
  const port = new FakeAgentRunApprovalPort();
  return {
    port,
    createRunningRun: (runId, rootRunId) =>
      port.createRunningRun(runId, rootRunId),
    readRun: (runId) => port.readRun(runId),
    stopRun: (runId) => port.stopRun(runId),
    interrupt: (runId, expectedVersion) =>
      port.interruptForApprovalTimeout({ runId, expectedVersion }),
    readInteraction: (interactionId) => port.readInteraction(interactionId),
    readToolCall: (runId, key) => port.readToolCall(runId, key),
  };
});
