import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { listAuditEvents } from "./audit-event-store.js";
import type { AuditEventInput } from "./audit-event-types.js";
import { createAuditEventWriter } from "./audit-event-writer.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function input(): AuditEventInput {
  return {
    sourceId: "run-1:1:started",
    sourceSequence: 1,
    occurredAt: Date.now(),
    kind: "agent_run",
    action: "agent.run.started",
    status: "started",
    actorType: "agent",
    actorId: "main",
    agentId: "main",
    runId: "run-1",
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("audit event worker", () => {
  it("returns immediately under SQLite contention and flushes before stop", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const errors: string[] = [];
    const writer = createAuditEventWriter({ stateDir, onError: (error) => errors.push(error) });
    await writer.ready;
    const { db } = openOpenClawStateDatabase(database);
    db.exec("BEGIN IMMEDIATE");
    const startedAt = performance.now();
    expect(writer.record(input())).toBe(true);
    expect(performance.now() - startedAt).toBeLessThan(250);
    db.exec("ROLLBACK");

    await writer.stop();
    expect(errors).toEqual([]);
    expect(listAuditEvents({ database, limit: 10 }).events).toHaveLength(1);
  });

  it("accepts bounded final records after the live queue fills", async () => {
    const stateDir = tempDirs.make("openclaw-audit-writer-final-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const errors: string[] = [];
    const writer = createAuditEventWriter({
      stateDir,
      maxPending: 1,
      onError: (error) => errors.push(error),
    });
    await writer.ready;
    const { db } = openOpenClawStateDatabase(database);
    const finalInput = input();
    finalInput.sourceId = "run-2:2:started";
    finalInput.sourceSequence = 2;
    finalInput.runId = "run-2";
    db.exec("BEGIN IMMEDIATE");
    expect(writer.record(input())).toBe(true);
    expect(writer.record(finalInput)).toBe(false);
    const stopped = writer.stop([finalInput]);
    db.exec("ROLLBACK");

    await stopped;
    expect(errors).toEqual(["audit event queue is full (1); dropping metadata"]);
    expect(listAuditEvents({ database, limit: 10 }).events).toHaveLength(2);
  });
});
