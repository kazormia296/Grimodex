import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { ipcMain } from "electron";

// Transparent test observation only. Never retain args, result values or error text.
// The actual production main installs and owns every handler and authority check.
globalThis.nir1IpcTrace = { calls: [] };
const originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) =>
  originalHandle(
    channel,
    channel === "grim:invoke"
      ? async (event, ...args) => {
          const record = {
            command: typeof args[0] === "string" ? args[0] : "invalid-command",
            completed: false,
            ok: false,
          };
          globalThis.nir1IpcTrace.calls.push(record);
          try {
            const envelope = await listener(event, ...args);
            record.completed = true;
            record.ok = envelope?.ok === true;
            return envelope;
          } catch (error) {
            record.completed = true;
            throw error;
          }
        }
      : listener,
  );

const main = process.env.GRIMODEX_NIR1_PRODUCTION_MAIN;
assert.ok(
  main && path.isAbsolute(main),
  "[precheck] absolute production main path required",
);
await import(pathToFileURL(main).href);
