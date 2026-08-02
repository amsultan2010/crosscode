import { describe, expect, it } from "vitest";
import { riskMix, riskMixEntries, rollUpProjects, summarizeValidations, UNASSIGNED_PROJECT_NAME } from "./analytics.js";
import { fixtureProjects, fullSnapshot, operation, presence, project, validation } from "./test-fixtures.js";

describe("rollUpProjects", () => {
  it("attributes edits and online replicas to the project that produced them", () => {
    const snapshot = fullSnapshot();
    const rollups = rollUpProjects(fixtureProjects(), snapshot.operations, snapshot.presence);

    const byId = new Map(rollups.map((rollup) => [rollup.projectId, rollup]));
    expect(byId.get("proj-1")).toMatchObject({ name: "crosscode", editCount: 2, activeReplicas: 1 });
    expect(byId.get("proj-2")).toMatchObject({ name: "website", editCount: 1, activeReplicas: 1 });
    // A project with no activity still gets a card.
    expect(byId.get("proj-3")).toMatchObject({ name: "scratch", editCount: 0, activeReplicas: 0, lastActivityAt: null });
  });

  it("groups null-project operations and replicas under Unassigned", () => {
    const snapshot = fullSnapshot();
    const rollups = rollUpProjects(fixtureProjects(), snapshot.operations, snapshot.presence);
    const unassigned = rollups.find((rollup) => rollup.projectId === null);

    expect(unassigned).toMatchObject({
      name: UNASSIGNED_PROJECT_NAME,
      editCount: 1,
      activeReplicas: 1,
      lastActivityAt: "2026-07-29T10:00:00.000Z"
    });
    // The leftovers bucket always sorts last.
    expect(rollups.at(-1)).toBe(unassigned);
  });

  it("omits the Unassigned bucket when nothing is unattributed", () => {
    const rollups = rollUpProjects(
      [project({ id: "proj-1", name: "crosscode" })],
      [operation({ id: "op-1", serverSequence: 1, projectId: "proj-1" })],
      [presence({ replicaId: "replica-a", projectId: "proj-1" })]
    );
    expect(rollups.map((rollup) => rollup.projectId)).toEqual(["proj-1"]);
  });

  it("counts only online replicas as active", () => {
    const rollups = rollUpProjects(
      [project({ id: "proj-1", name: "crosscode" })],
      [],
      [
        presence({ replicaId: "replica-a", projectId: "proj-1" }),
        presence({ replicaId: "replica-b", projectId: "proj-1", status: "offline" })
      ]
    );
    expect(rollups[0]!.activeReplicas).toBe(1);
  });

  it("prefers the newest of the server timestamp and streamed operations", () => {
    const rollups = rollUpProjects(
      [project({ id: "proj-1", name: "crosscode", lastActivityAt: "2026-07-30T08:00:00.000Z" })],
      [operation({ id: "op-1", serverSequence: 1, projectId: "proj-1", createdAt: "2026-07-30T11:00:00.000Z" })],
      []
    );
    expect(rollups[0]!.lastActivityAt).toBe("2026-07-30T11:00:00.000Z");
  });

  it("keeps activity for a project id the projects endpoint did not return", () => {
    const rollups = rollUpProjects([], [operation({ id: "op-1", serverSequence: 1, projectId: "proj-9" })], []);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({ projectId: "proj-9", editCount: 1 });
  });

  it("orders projects by newest activity first, undated last", () => {
    const snapshot = fullSnapshot();
    const rollups = rollUpProjects(fixtureProjects(), snapshot.operations, snapshot.presence);
    expect(rollups.map((rollup) => rollup.projectId)).toEqual(["proj-1", "proj-2", "proj-3", null]);
  });
});

describe("summarizeValidations", () => {
  it("computes the pass rate from exit codes", () => {
    const summary = summarizeValidations(fullSnapshot().validations);
    expect(summary).toEqual({ total: 3, passing: 2, passRate: 67 });
  });

  it("reports a null pass rate when nothing has been validated", () => {
    expect(summarizeValidations([])).toEqual({ total: 0, passing: 0, passRate: null });
  });

  it("reports 0% rather than null when every run failed", () => {
    expect(summarizeValidations([validation({ eventId: "v1", exitCode: 1 })])).toEqual({ total: 1, passing: 0, passRate: 0 });
  });
});

describe("riskMix", () => {
  it("counts every risk level from transaction.safety.risk", () => {
    const mix = riskMix(fullSnapshot().operations);
    expect(mix).toEqual({ total: 4, counts: { low: 1, medium: 1, high: 1, critical: 1 } });
    expect(riskMixEntries(mix)).toEqual([
      { risk: "low", count: 1, percent: 25 },
      { risk: "medium", count: 1, percent: 25 },
      { risk: "high", count: 1, percent: 25 },
      { risk: "critical", count: 1, percent: 25 }
    ]);
  });

  it("returns zeroed counts and zero percentages for the empty case", () => {
    const mix = riskMix([]);
    expect(mix).toEqual({ total: 0, counts: { low: 0, medium: 0, high: 0, critical: 0 } });
    expect(riskMixEntries(mix).every((entry) => entry.count === 0 && entry.percent === 0)).toBe(true);
  });
});
