import type {
  StandardSchemaV1,
  StandardSchemaV1JsonSchema,
} from "@cordierite/shared";
import { describe, expect, test } from "bun:test";

import type { CordieriteConnectionState } from "../Cordierite.types";
import {
  createCordieriteClient,
  type CordieriteNativeModuleLike,
} from "../createCordieriteClient";

const createMockModule = (
  initialState: CordieriteConnectionState = "idle"
): CordieriteNativeModuleLike & {
  sentMessages: string[];
  listeners: Map<string, Set<(...args: any[]) => void>>;
  state: CordieriteConnectionState;
} => {
  const listeners = new Map<string, Set<(...args: any[]) => void>>();
  const sentMessages: string[] = [];

  return {
    sentMessages,
    listeners,
    state: initialState,
    async connect() {
      this.state = "connecting";
    },
    async send(message: string) {
      sentMessages.push(message);
    },
    async close() {
      this.state = "closed";
      listeners.get("close")?.forEach((listener) => listener({}));
    },
    getState() {
      return this.state;
    },
    addListener(eventName, listener) {
      const eventListeners = listeners.get(eventName) ?? new Set();
      eventListeners.add(listener as (...args: any[]) => void);
      listeners.set(eventName, eventListeners);
      return {
        remove() {
          eventListeners.delete(listener as (...args: any[]) => void);
        },
      };
    },
  };
};

const validExpiresAt = () => Math.floor(Date.now() / 1000) + 60;

const validBootstrap = () => ({
  ip: "192.168.1.42",
  port: 8443,
  sessionId: "session-123",
  token: "token-123",
  expiresAt: validExpiresAt(),
});

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const success = <T>(value: T): StandardSchemaV1.SuccessResult<T> => ({ value });

const failure = (
  message: string,
  path?: PropertyKey[]
): StandardSchemaV1.FailureResult => ({
  issues: [
    {
      message,
      path,
    },
  ],
});

const createStandardSchema = <Output>({
  validate,
  inputJsonSchema,
  outputJsonSchema,
}: {
  validate: (value: unknown) => StandardSchemaV1.Result<Output>;
  inputJsonSchema: Record<string, unknown>;
  outputJsonSchema?: Record<string, unknown>;
}): StandardSchemaV1JsonSchema<unknown, Output> => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate,
    jsonSchema: {
      input: () => inputJsonSchema,
      output: () => outputJsonSchema ?? inputJsonSchema,
    },
  },
});

const anyObjectDescriptor = {
  type: "object",
  additionalProperties: true,
};

const anyObjectSchema = createStandardSchema<Record<string, unknown>>({
  validate: (value) =>
    isRecord(value) ? success(value) : failure("Expected object input."),
  inputJsonSchema: anyObjectDescriptor,
});

const sumInputDescriptor = {
  type: "object",
  properties: {
    a: { type: "number" },
    b: { type: "number" },
  },
  required: ["a", "b"],
  additionalProperties: false,
};

const sumInputSchema = createStandardSchema<{ a: number; b: number }>({
  validate: (value) => {
    if (!isRecord(value)) {
      return failure("Expected an object input.");
    }

    if (typeof value.a !== "number") {
      return failure('Expected "a" to be a number.', ["a"]);
    }

    if (typeof value.b !== "number") {
      return failure('Expected "b" to be a number.', ["b"]);
    }

    return success({
      a: value.a,
      b: value.b,
    });
  },
  inputJsonSchema: sumInputDescriptor,
});

const sumOutputDescriptor = {
  type: "object",
  properties: {
    total: { type: "number" },
  },
  required: ["total"],
  additionalProperties: false,
};

const sumOutputSchema = createStandardSchema<{ total: number }>({
  validate: (value) => {
    if (!isRecord(value)) {
      return failure("Expected an object result.");
    }

    if (typeof value.total !== "number") {
      return failure('Expected "total" to be a number.', ["total"]);
    }

    return success({
      total: value.total,
    });
  },
  inputJsonSchema: sumOutputDescriptor,
});

const okResultSchema = createStandardSchema<{ ok: boolean }>({
  validate: (value) => {
    if (!isRecord(value)) {
      return failure("Expected an object result.");
    }

    if (typeof value.ok !== "boolean") {
      return failure('Expected "ok" to be a boolean.', ["ok"]);
    }

    return success({
      ok: value.ok,
    });
  },
  inputJsonSchema: {
    type: "object",
    properties: {
      ok: { type: "boolean" },
    },
    required: ["ok"],
    additionalProperties: false,
  },
});

describe("createCordieriteClient", () => {
  test("connect rejects expired payloads before native connect", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    await expect(
      client.connect({
        ip: "192.168.1.42",
        port: 8443,
        sessionId: "session-123",
        token: "token-123",
        expiresAt: 1,
      })
    ).rejects.toThrow("Invalid or expired Cordierite bootstrap payload.");
  });

  test("send injects the active session_id into outbound objects", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    await client.connect({
      ip: "192.168.1.42",
      port: 8443,
      sessionId: "session-123",
      token: "token-123",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });

    nativeModule.state = "active";

    await client.send({
      type: "tool_call",
      id: "call-1",
      name: "ping",
      args: {},
    });

    expect(nativeModule.sentMessages).toEqual([
      JSON.stringify({
        type: "tool_call",
        id: "call-1",
        name: "ping",
        args: {},
        session_id: "session-123",
      }),
    ]);
  });

  test("send rejects when the socket is not active", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    await expect(
      client.send(JSON.stringify({ type: "tool_call" }))
    ).rejects.toThrow("Cordierite session is not active.");
  });

  test("registerTool syncs a snapshot when the session becomes active", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    client.registerTool(
      {
        name: "echo",
        description: "Echo tool",
        inputSchema: anyObjectSchema,
        outputSchema: anyObjectSchema,
        handler: (args) => args,
      }
    );

    await client.connect({
      ip: "192.168.1.42",
      port: 8443,
      sessionId: "session-123",
      token: "token-123",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });

    nativeModule.state = "active";
    nativeModule.listeners
      .get("stateChange")
      ?.forEach((listener) => listener({ state: "active" }));

    expect(nativeModule.sentMessages).toContain(
      JSON.stringify({
        type: "tool_registry_snapshot",
        session_id: "session-123",
        tools: [
          {
            name: "echo",
            description: "Echo tool",
            input_schema: anyObjectDescriptor,
            output_schema: anyObjectDescriptor,
          },
        ],
      })
    );
  });

  test("incoming tool_call returns tool_result for async handlers", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    client.registerTool(
      {
        name: "sum",
        description: "Sum values",
        inputSchema: sumInputSchema,
        outputSchema: sumOutputSchema,
        handler: async (args) => ({
          total: args.a + args.b,
        }),
      }
    );

    await client.connect({
      ip: "192.168.1.42",
      port: 8443,
      sessionId: "session-123",
      token: "token-123",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });

    nativeModule.state = "active";
    nativeModule.listeners.get("message")?.forEach((listener) =>
      listener({
        message: {
          type: "tool_call",
          session_id: "session-123",
          id: "call-1",
          name: "sum",
          args: {
            a: 1,
            b: 2,
          },
        },
        rawMessage: "",
      })
    );

    await flushMicrotasks();

    expect(nativeModule.sentMessages).toContain(
      JSON.stringify({
        type: "tool_result",
        session_id: "session-123",
        id: "call-1",
        result: {
          total: 3,
        },
      })
    );
  });

  test("incoming tool_call returns tool_error for missing tools", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    await client.connect({
      ip: "192.168.1.42",
      port: 8443,
      sessionId: "session-123",
      token: "token-123",
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });

    nativeModule.state = "active";
    nativeModule.listeners.get("message")?.forEach((listener) =>
      listener({
        message: {
          type: "tool_call",
          session_id: "session-123",
          id: "call-1",
          name: "missing",
          args: {},
        },
        rawMessage: "",
      })
    );

    await flushMicrotasks();

    expect(nativeModule.sentMessages).toContain(
      JSON.stringify({
        type: "tool_error",
        session_id: "session-123",
        id: "call-1",
        error: {
          type: "tool_not_found",
          message: 'Tool "missing" is not registered in the app.',
        },
      })
    );
  });

  test("connect clears JS session when native connect throws", async () => {
    const nativeModule = createMockModule();
    nativeModule.connect = async () => {
      throw new Error("native connect failed");
    };
    const client = createCordieriteClient(nativeModule);

    client.registerTool(
      {
        name: "echo",
        description: "Echo tool",
        inputSchema: anyObjectSchema,
        outputSchema: okResultSchema,
        handler: () => ({ ok: true }),
      }
    );

    await expect(client.connect(validBootstrap())).rejects.toThrow(
      "native connect failed"
    );

    nativeModule.state = "active";
    nativeModule.listeners.get("message")?.forEach((listener) =>
      listener({
        message: {
          type: "tool_call",
          session_id: "session-123",
          id: "call-1",
          name: "echo",
          args: {},
        },
        rawMessage: "",
      })
    );
    await flushMicrotasks();

    expect(nativeModule.sentMessages).toEqual([]);
  });

  test("second connect succeeds after native connect failure", async () => {
    let calls = 0;
    const nativeModule = createMockModule();
    const baseConnect = nativeModule.connect.bind(nativeModule);
    nativeModule.connect = async function () {
      calls += 1;
      if (calls === 1) {
        throw new Error("temporary native failure");
      }
      return baseConnect();
    };
    const client = createCordieriteClient(nativeModule);

    await expect(client.connect(validBootstrap())).rejects.toThrow(
      "temporary native failure"
    );
    await client.connect(validBootstrap());
    expect(calls).toBe(2);
    expect(nativeModule.state).toBe("connecting");
  });

  test("incoming tool_call returns tool_error when result is not JSON-serializable", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    client.registerTool(
      {
        name: "bad",
        description: "Returns circular structure",
        inputSchema: anyObjectSchema,
        outputSchema: anyObjectSchema,
        handler: () => circular,
      }
    );

    await client.connect(validBootstrap());
    nativeModule.state = "active";
    nativeModule.listeners.get("message")?.forEach((listener) =>
      listener({
        message: {
          type: "tool_call",
          session_id: "session-123",
          id: "call-ser",
          name: "bad",
          args: {},
        },
        rawMessage: "",
      })
    );
    await flushMicrotasks();

    const serializationError = nativeModule.sentMessages.find((m) =>
      m.includes("tool_serialization_error")
    );
    expect(serializationError).toBeDefined();
    expect(serializationError).toContain("call-ser");
  });

  test("registerTool sends registry delta when session is already active", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    await client.connect(validBootstrap());
    nativeModule.state = "active";
    nativeModule.listeners
      .get("stateChange")
      ?.forEach((listener) => listener({ state: "active" }));
    nativeModule.sentMessages.length = 0;

    client.registerTool(
      {
        name: "late",
        description: "Registered after active",
        inputSchema: anyObjectSchema,
        outputSchema: anyObjectSchema,
        handler: () => ({}),
      }
    );
    await flushMicrotasks();

    expect(nativeModule.sentMessages).toContain(
      JSON.stringify({
        type: "tool_registry_delta",
        session_id: "session-123",
        operation: "upsert",
        tool: {
          name: "late",
          description: "Registered after active",
          input_schema: anyObjectDescriptor,
          output_schema: anyObjectDescriptor,
        },
      })
    );
  });

  test("after close, incoming tool_call does not send responses", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    client.registerTool(
      {
        name: "echo",
        description: "Echo tool",
        inputSchema: anyObjectSchema,
        outputSchema: okResultSchema,
        handler: () => ({ ok: true }),
      }
    );

    await client.connect(validBootstrap());
    nativeModule.state = "active";
    await client.close();
    nativeModule.sentMessages.length = 0;
    nativeModule.state = "active";

    nativeModule.listeners.get("message")?.forEach((listener) =>
      listener({
        message: {
          type: "tool_call",
          session_id: "session-123",
          id: "call-x",
          name: "echo",
          args: {},
        },
        rawMessage: "",
      })
    );
    await flushMicrotasks();

    expect(nativeModule.sentMessages).toEqual([]);
  });

  test("incoming tool_call returns tool_error when input validation fails", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    client.registerTool(
      {
        name: "sum",
        description: "Sum values",
        inputSchema: sumInputSchema,
        outputSchema: sumOutputSchema,
        handler: async (args) => ({
          total: args.a + args.b,
        }),
      }
    );

    await client.connect(validBootstrap());
    nativeModule.state = "active";
    nativeModule.listeners.get("message")?.forEach((listener) =>
      listener({
        message: {
          type: "tool_call",
          session_id: "session-123",
          id: "call-invalid-input",
          name: "sum",
          args: {
            a: 1,
          },
        },
        rawMessage: "",
      })
    );

    await flushMicrotasks();

    expect(nativeModule.sentMessages).toContain(
      JSON.stringify({
        type: "tool_error",
        session_id: "session-123",
        id: "call-invalid-input",
        error: {
          type: "tool_input_validation_error",
          message: 'Tool "sum" rejected the provided input.',
          details: {
            issues: [
              {
                message: 'Expected "b" to be a number.',
                path: ["b"],
              },
            ],
          },
        },
      })
    );
  });

  test("incoming tool_call returns tool_error when output validation fails", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    client.registerTool(
      {
        name: "wrong-total",
        description: "Returns an invalid output payload",
        inputSchema: anyObjectSchema,
        outputSchema: sumOutputSchema,
        handler: async () => ({
          total: "bad",
        }),
      }
    );

    await client.connect(validBootstrap());
    nativeModule.state = "active";
    nativeModule.listeners.get("message")?.forEach((listener) =>
      listener({
        message: {
          type: "tool_call",
          session_id: "session-123",
          id: "call-invalid-output",
          name: "wrong-total",
          args: {},
        },
        rawMessage: "",
      })
    );

    await flushMicrotasks();

    expect(nativeModule.sentMessages).toContain(
      JSON.stringify({
        type: "tool_error",
        session_id: "session-123",
        id: "call-invalid-output",
        error: {
          type: "tool_output_validation_error",
          message:
            'Tool "wrong-total" returned a result that does not match outputSchema.',
          details: {
            issues: [
              {
                message: 'Expected "total" to be a number.',
                path: ["total"],
              },
            ],
          },
        },
      })
    );
  });

  test("registerTool allows omitted schemas and exports empty descriptors", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    client.registerTool({
      name: "no-schema",
      description: "No input or output schema",
      handler: () => {},
    });

    await client.connect(validBootstrap());
    nativeModule.state = "active";
    nativeModule.listeners
      .get("stateChange")
      ?.forEach((listener) => listener({ state: "active" }));

    expect(nativeModule.sentMessages).toContain(
      JSON.stringify({
        type: "tool_registry_snapshot",
        session_id: "session-123",
        tools: [
          {
            name: "no-schema",
            description: "No input or output schema",
            input_schema: {},
            output_schema: {},
          },
        ],
      })
    );
  });

  test("incoming tool_call passes undefined to handlers without inputSchema", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    let receivedArgs: unknown = Symbol("unset");

    client.registerTool({
      name: "no-input",
      description: "No input schema",
      outputSchema: okResultSchema,
      handler: (args) => {
        receivedArgs = args;
        return { ok: true };
      },
    });

    await client.connect(validBootstrap());
    nativeModule.state = "active";
    nativeModule.listeners.get("message")?.forEach((listener) =>
      listener({
        message: {
          type: "tool_call",
          session_id: "session-123",
          id: "call-no-input",
          name: "no-input",
          args: {},
        },
        rawMessage: "",
      })
    );

    await flushMicrotasks();

    expect(receivedArgs).toBeUndefined();
    expect(nativeModule.sentMessages).toContain(
      JSON.stringify({
        type: "tool_result",
        session_id: "session-123",
        id: "call-no-input",
        result: {
          ok: true,
        },
      })
    );
  });

  test("incoming tool_call rejects non-empty args when inputSchema is omitted", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    client.registerTool({
      name: "no-input",
      description: "No input schema",
      handler: () => {},
    });

    await client.connect(validBootstrap());
    nativeModule.state = "active";
    nativeModule.listeners.get("message")?.forEach((listener) =>
      listener({
        message: {
          type: "tool_call",
          session_id: "session-123",
          id: "call-extra-args",
          name: "no-input",
          args: {
            unexpected: true,
          },
        },
        rawMessage: "",
      })
    );

    await flushMicrotasks();

    expect(nativeModule.sentMessages).toContain(
      JSON.stringify({
        type: "tool_error",
        session_id: "session-123",
        id: "call-extra-args",
        error: {
          type: "tool_input_validation_error",
          message: 'Tool "no-input" rejected the provided input.',
          details: {
            issues: [
              {
                message: 'Tool "no-input" does not accept input arguments.',
              },
            ],
          },
        },
      })
    );
  });

  test("incoming tool_call allows void results when outputSchema is omitted", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    client.registerTool({
      name: "no-output",
      description: "No output schema",
      inputSchema: anyObjectSchema,
      handler: () => {},
    });

    await client.connect(validBootstrap());
    nativeModule.state = "active";
    nativeModule.listeners.get("message")?.forEach((listener) =>
      listener({
        message: {
          type: "tool_call",
          session_id: "session-123",
          id: "call-no-output",
          name: "no-output",
          args: {},
        },
        rawMessage: "",
      })
    );

    await flushMicrotasks();

    expect(nativeModule.sentMessages).toContain(
      JSON.stringify({
        type: "tool_result",
        session_id: "session-123",
        id: "call-no-output",
        result: null,
      })
    );
  });

  test("incoming tool_call rejects returned values when outputSchema is omitted", async () => {
    const nativeModule = createMockModule();
    const client = createCordieriteClient(nativeModule);

    client.registerTool({
      name: "no-output",
      description: "No output schema",
      handler: () => ({ ok: true }),
    });

    await client.connect(validBootstrap());
    nativeModule.state = "active";
    nativeModule.listeners.get("message")?.forEach((listener) =>
      listener({
        message: {
          type: "tool_call",
          session_id: "session-123",
          id: "call-unexpected-output",
          name: "no-output",
          args: {},
        },
        rawMessage: "",
      })
    );

    await flushMicrotasks();

    expect(nativeModule.sentMessages).toContain(
      JSON.stringify({
        type: "tool_error",
        session_id: "session-123",
        id: "call-unexpected-output",
        error: {
          type: "tool_output_validation_error",
          message:
            'Tool "no-output" returned a result that does not match outputSchema.',
          details: {
            issues: [
              {
                message:
                  'Tool "no-output" must not return a result when outputSchema is omitted.',
              },
            ],
          },
        },
      })
    );
  });
});
