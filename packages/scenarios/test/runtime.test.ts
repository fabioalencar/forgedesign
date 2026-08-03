import { describe, expect, it } from "vitest";
import {
  activeScenarioId,
  createScenarioRuntime,
  type ScenarioBundle,
  scenarioRuntimeFrom,
} from "../src/index.js";

const BUNDLE: ScenarioBundle = {
  scenarios: [
    {
      id: "SCENARIO-001",
      title: "Manager approving",
      role: "ROLE-002",
      permissions: ["orders.view", "orders.approve"],
      flags: { newCheckout: true, tier: "pro" },
      routes: { hidden: ["/admin/**", "/billing/*"], redirect: { "/": "/dashboard" } },
      dataset: "orders-busy-week",
      route: "/orders?f=pending",
      flow: [{ id: "s1", label: "Open pending orders", route: "/orders" }],
      data: { orders: [{ id: 1 }] },
    },
    {
      id: "SCENARIO-002",
      title: "Read-only viewer",
      role: null,
      permissions: ["orders.view"],
      flags: {},
      routes: { hidden: [], redirect: {} },
      dataset: null,
      route: null,
      flow: [],
      data: {},
    },
  ],
};

describe("createScenarioRuntime", () => {
  it("answers can/flag/data from the active scenario", () => {
    const runtime = createScenarioRuntime(BUNDLE, "SCENARIO-001");

    expect(runtime.active?.title).toBe("Manager approving");
    expect(runtime.can("orders.approve")).toBe(true);
    expect(runtime.can("orders.delete")).toBe(false);
    expect(runtime.flag("newCheckout")).toBe(true);
    expect(runtime.flag("tier")).toBe("pro");
    expect(runtime.flag("missing")).toBeUndefined();
    expect(runtime.data("orders")).toEqual([{ id: 1 }]);
  });

  it("denies everything and allows every route with no scenario selected", () => {
    // An unscoped visit sees the prototype's own defaults, not a half-applied
    // role — which would be worse than no scenario at all.
    const runtime = createScenarioRuntime(BUNDLE, null);
    expect(runtime.active).toBeNull();
    expect(runtime.can("orders.view")).toBe(false);
    expect(runtime.resolveRoute("/admin/users")).toBe("/admin/users");
  });

  it("treats an unknown scenario id as none rather than throwing", () => {
    expect(createScenarioRuntime(BUNDLE, "SCENARIO-404").active).toBeNull();
  });

  it("still lists every scenario, so a selector can offer them", () => {
    expect(createScenarioRuntime(BUNDLE, null).all.map((s) => s.id)).toEqual([
      "SCENARIO-001",
      "SCENARIO-002",
    ]);
  });
});

describe("resolveRoute", () => {
  const runtime = createScenarioRuntime(BUNDLE, "SCENARIO-001");

  it("redirects a declared path", () => {
    expect(runtime.resolveRoute("/")).toBe("/dashboard");
  });

  it("hides a path matching a ** pattern, across segments", () => {
    expect(runtime.resolveRoute("/admin/users")).toBeNull();
    expect(runtime.resolveRoute("/admin/users/42")).toBeNull();
  });

  it("hides a single segment for a * pattern but not a deeper one", () => {
    expect(runtime.resolveRoute("/billing/invoices")).toBeNull();
    expect(runtime.resolveRoute("/billing/invoices/42")).toBe("/billing/invoices/42");
  });

  it("passes an allowed path through unchanged", () => {
    expect(runtime.resolveRoute("/orders")).toBe("/orders");
  });

  it("compares a pattern with no wildcard literally", () => {
    const literal = createScenarioRuntime(
      { scenarios: [{ ...BUNDLE.scenarios[0]!, routes: { hidden: ["/admin"], redirect: {} } }] },
      "SCENARIO-001",
    );
    expect(literal.resolveRoute("/admin")).toBeNull();
    expect(literal.resolveRoute("/administration")).toBe("/administration");
  });
});

describe("activeScenarioId", () => {
  it("reads the query parameter", () => {
    expect(activeScenarioId("?scenario=SCENARIO-007")).toBe("SCENARIO-007");
    expect(activeScenarioId("?other=1")).toBeNull();
    expect(activeScenarioId("?scenario=")).toBeNull();
  });

  it("wires straight through to a runtime", () => {
    expect(scenarioRuntimeFrom(BUNDLE, "?scenario=SCENARIO-002").active?.title).toBe(
      "Read-only viewer",
    );
  });
});
