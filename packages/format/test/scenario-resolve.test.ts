import { describe, expect, it } from "vitest";
import { parseConcept } from "../src/concepts.js";
import { composePermissions, resolveScenario } from "../src/scenario-resolve.js";

const role = (id: string, permissions: string[]) =>
  parseConcept(
    `roles/${id}.md`,
    `---\ntype: Role\nid: ${id}\ntitle: Manager\npermissions: [${permissions.join(", ")}]\n---\n`,
  );

const scenario = (frontmatter: string, body = "") =>
  parseConcept(
    "scenarios/SCENARIO-001.md",
    `---\ntype: Scenario\nid: SCENARIO-001\ntitle: A review\n${frontmatter}\n---\n${body}`,
  );

describe("composePermissions", () => {
  it("adds the scenario's grants to the role's", () => {
    expect(composePermissions(["orders.view"], ["orders.export"])).toEqual([
      "orders.export",
      "orders.view",
    ]);
  });

  it("removes one the scenario prefixes with `-`", () => {
    // The point of the rule: review a degraded state without restating the role.
    expect(composePermissions(["orders.view", "orders.approve"], ["-orders.approve"])).toEqual([
      "orders.view",
    ]);
  });

  it("reports removing something the role never granted", () => {
    const problems: string[] = [];
    expect(composePermissions(["orders.view"], ["-orders.approve"], problems)).toEqual([
      "orders.view",
    ]);
    // Usually means the role changed underneath the scenario; doing nothing
    // silently would hide that.
    expect(problems.join()).toMatch(/does not grant/);
  });

  it("de-duplicates and sorts, so the effective set is stable", () => {
    expect(composePermissions(["b", "a"], ["a", "c"])).toEqual(["a", "b", "c"]);
  });
});

describe("resolveScenario", () => {
  it("composes permissions through the named role", () => {
    const resolved = resolveScenario(
      scenario("role: ROLE-002\npermissions: [orders.export, -orders.approve]"),
      [role("ROLE-002", ["orders.view", "orders.approve"])],
    );
    expect(resolved.role).toBe("ROLE-002");
    expect(resolved.permissions).toEqual(["orders.export", "orders.view"]);
    expect(resolved.problems).toEqual([]);
  });

  it("reports a role reference that does not resolve", () => {
    const resolved = resolveScenario(scenario("role: ROLE-404"), []);
    expect(resolved.problems.join()).toMatch(/ROLE-404 is not a role/);
    expect(resolved.permissions).toEqual([]);
  });

  it("works with no role at all — the scenario's own grants stand alone", () => {
    const resolved = resolveScenario(scenario("permissions: [orders.view]"), []);
    expect(resolved.role).toBeNull();
    expect(resolved.permissions).toEqual(["orders.view"]);
  });

  it("reads flags and route rules", () => {
    const resolved = resolveScenario(
      scenario(
        'flags: { newCheckout: true, tier: pro }\nroutes:\n  hidden: ["/admin/**"]\n  redirect: { "/": "/dashboard" }',
      ),
      [],
    );
    expect(resolved.flags).toEqual({ newCheckout: true, tier: "pro" });
    expect(resolved.routes).toEqual({ hidden: ["/admin/**"], redirect: { "/": "/dashboard" } });
  });

  it("reads flow steps from the body's Flow section only", () => {
    const resolved = resolveScenario(
      scenario(
        "role: ROLE-002",
        "## Purpose\n\n- not · a · step\n\n## Flow\n\n- s1 · Open pending orders · /orders?f=pending\n- s2 · Approve the flagged one\n",
      ),
      [role("ROLE-002", [])],
    );
    expect(resolved.flow).toEqual([
      { id: "s1", label: "Open pending orders", route: "/orders?f=pending" },
      { id: "s2", label: "Approve the flagged one", route: null },
    ]);
  });

  it("has no flow when the body declares none", () => {
    expect(resolveScenario(scenario("role: ROLE-002"), []).flow).toEqual([]);
  });
});
