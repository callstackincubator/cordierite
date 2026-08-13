import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, test, vi } from "vitest";

import { createUseCordieriteTool } from "../useCordieriteTool";

/**
 * Exercises `createUseCordieriteTool`'s lifecycle behavior — mount, unmount, `deps` changes, and
 * the `enabled` option — against a fake `registerTool` so identity (not name) is what's asserted
 * on removal, matching the real registry's contract (see `client/registry.ts`).
 */

type FakeRegistration = { name: string; id: number; removed: boolean };

function createFakeRegistrar() {
  const active: FakeRegistration[] = [];
  let nextId = 0;

  const registerTool = vi.fn((definition: { name: string }) => {
    const registration: FakeRegistration = {
      name: definition.name,
      id: nextId++,
      removed: false,
    };
    active.push(registration);
    return {
      remove: () => {
        registration.removed = true;
        const index = active.indexOf(registration);
        if (index !== -1) {
          active.splice(index, 1);
        }
      },
      // exposed only for assertions
      __registration: registration,
    } as { remove: () => void; __registration: FakeRegistration };
  });

  return {
    registerTool,
    activeCount: () => active.length,
    activeNames: () => active.map((r) => r.name),
  };
}

function renderHookHost(
  useCordieriteTool: ReturnType<typeof createUseCordieriteTool>,
) {
  let latestProps: {
    name: string;
    deps?: unknown[];
    enabled?: boolean;
  } | null = null;

  function Host(props: { name: string; deps?: unknown[]; enabled?: boolean }) {
    latestProps = props;
    useCordieriteTool(
      { name: props.name, description: "d", handler: () => "result" },
      props.deps,
      props.enabled === undefined ? undefined : { enabled: props.enabled },
    );
    return null;
  }

  return { Host, getLatestProps: () => latestProps };
}

describe("createUseCordieriteTool: enabled option lifecycle", () => {
  test("defaults to enabled: registers on mount", () => {
    const fake = createFakeRegistrar();
    const useCordieriteTool = createUseCordieriteTool(fake.registerTool);
    const { Host } = renderHookHost(useCordieriteTool);

    act(() => {
      TestRenderer.create(createElement(Host, { name: "sum", deps: [] }));
    });

    expect(fake.activeCount()).toBe(1);
    expect(fake.activeNames()).toEqual(["sum"]);
  });

  test("enabled: false never registers", () => {
    const fake = createFakeRegistrar();
    const useCordieriteTool = createUseCordieriteTool(fake.registerTool);
    const { Host } = renderHookHost(useCordieriteTool);

    act(() => {
      TestRenderer.create(
        createElement(Host, { name: "sum", deps: [], enabled: false }),
      );
    });

    expect(fake.registerTool).not.toHaveBeenCalled();
    expect(fake.activeCount()).toBe(0);
  });

  test("true → false removes the registration", () => {
    const fake = createFakeRegistrar();
    const useCordieriteTool = createUseCordieriteTool(fake.registerTool);
    const { Host } = renderHookHost(useCordieriteTool);

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        createElement(Host, { name: "sum", deps: [], enabled: true }),
      );
    });
    expect(fake.activeCount()).toBe(1);

    act(() => {
      renderer.update(
        createElement(Host, { name: "sum", deps: [], enabled: false }),
      );
    });
    expect(fake.activeCount()).toBe(0);
  });

  test("false → true registers", () => {
    const fake = createFakeRegistrar();
    const useCordieriteTool = createUseCordieriteTool(fake.registerTool);
    const { Host } = renderHookHost(useCordieriteTool);

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        createElement(Host, { name: "sum", deps: [], enabled: false }),
      );
    });
    expect(fake.activeCount()).toBe(0);

    act(() => {
      renderer.update(
        createElement(Host, { name: "sum", deps: [], enabled: true }),
      );
    });
    expect(fake.activeCount()).toBe(1);
  });

  test("toggling twice (true → false → true) leaves exactly one registration, never leaking", () => {
    const fake = createFakeRegistrar();
    const useCordieriteTool = createUseCordieriteTool(fake.registerTool);
    const { Host } = renderHookHost(useCordieriteTool);

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        createElement(Host, { name: "sum", deps: [], enabled: true }),
      );
    });
    act(() => {
      renderer.update(
        createElement(Host, { name: "sum", deps: [], enabled: false }),
      );
    });
    act(() => {
      renderer.update(
        createElement(Host, { name: "sum", deps: [], enabled: true }),
      );
    });

    expect(fake.activeCount()).toBe(1);
    expect(fake.registerTool).toHaveBeenCalledTimes(2);
  });

  test("toggling one hook's tool never removes a different hook's tool registered under the same name (identity, not name)", () => {
    const fake = createFakeRegistrar();
    const useCordieriteTool = createUseCordieriteTool(fake.registerTool);
    const { Host: HostA } = renderHookHost(useCordieriteTool);
    const { Host: HostB } = renderHookHost(useCordieriteTool);

    function Parent(props: { bEnabled: boolean }) {
      return createElement(
        "root" as unknown as string,
        null,
        createElement(HostA, { name: "shared-name", deps: [] }),
        createElement(HostB, {
          name: "shared-name",
          deps: [],
          enabled: props.bEnabled,
        }),
      );
    }

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(createElement(Parent, { bEnabled: true }));
    });
    // Both hooks registered under the same name — two independent registrations.
    expect(fake.activeCount()).toBe(2);

    // Disabling B must remove only B's registration, not A's (identity-based removal).
    act(() => {
      renderer.update(createElement(Parent, { bEnabled: false }));
    });
    expect(fake.activeCount()).toBe(1);
    expect(fake.activeNames()).toEqual(["shared-name"]);

    act(() => {
      renderer.unmount();
    });
    expect(fake.activeCount()).toBe(0);
  });

  test("unmounting while enabled removes the registration (no leak)", () => {
    const fake = createFakeRegistrar();
    const useCordieriteTool = createUseCordieriteTool(fake.registerTool);
    const { Host } = renderHookHost(useCordieriteTool);

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        createElement(Host, { name: "sum", deps: [] }),
      );
    });
    expect(fake.activeCount()).toBe(1);

    act(() => {
      renderer.unmount();
    });
    expect(fake.activeCount()).toBe(0);
  });

  test("unmounting while disabled is a no-op (nothing to remove)", () => {
    const fake = createFakeRegistrar();
    const useCordieriteTool = createUseCordieriteTool(fake.registerTool);
    const { Host } = renderHookHost(useCordieriteTool);

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        createElement(Host, { name: "sum", deps: [], enabled: false }),
      );
    });
    expect(fake.activeCount()).toBe(0);

    act(() => {
      renderer.unmount();
    });
    expect(fake.activeCount()).toBe(0);
  });

  test("changing deps while enabled re-registers exactly once (no duplicate registration)", () => {
    const fake = createFakeRegistrar();
    const useCordieriteTool = createUseCordieriteTool(fake.registerTool);
    const { Host } = renderHookHost(useCordieriteTool);

    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        createElement(Host, { name: "sum", deps: [1] }),
      );
    });
    expect(fake.activeCount()).toBe(1);

    act(() => {
      renderer.update(createElement(Host, { name: "sum", deps: [2] }));
    });
    expect(fake.activeCount()).toBe(1);
    expect(fake.registerTool).toHaveBeenCalledTimes(2);
  });
});
