import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ChatOpenAI } from "@langchain/openai";
import { createEntraTokenProvider } from "../../src/agent/entra-auth.ts";
import { createModel } from "../../src/agent/index.ts";

const { getToken, credentialConstructor } = vi.hoisted(() => ({
  getToken: vi.fn(),
  credentialConstructor: vi.fn(),
}));

vi.mock("@azure/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@azure/identity")>();
  return {
    ...actual,
    DefaultAzureCredential: class {
      constructor() {
        credentialConstructor();
      }
      getToken = getToken;
    },
  };
});

const BASE_URL = "https://gateway.example.com/openai/v1";
const SCOPE = "api://gateway/.default";
const TOKEN_LIFETIME = 90 * 60 * 1000;
let now: number;

beforeEach(() => {
  // Streaming invoke estimates token counts using a remote tokenizer. Keep
  // this test focused on gateway transport and auth, without that download.
  vi.spyOn(ChatOpenAI.prototype, "getNumTokens").mockResolvedValue(1);
  now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  getToken.mockReset();
  credentialConstructor.mockClear();
  getToken.mockImplementation(() =>
    Promise.resolve({
      token: `fake-token-${getToken.mock.calls.length}`,
      expiresOnTimestamp: now + TOKEN_LIFETIME,
    }),
  );
  vi.stubEnv("OPENAI_COMPATIBLE_AUTH", "entra-id");
  vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", BASE_URL);
  vi.stubEnv("OPENAI_COMPATIBLE_ENTRA_SCOPE", SCOPE);
  vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", undefined);
  vi.stubEnv("OPENWIKI_OPENAI_COMPATIBLE_STREAMING", undefined);
  vi.stubEnv("OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API", undefined);
  vi.stubEnv("OPENWIKI_REASONING_EFFORT", undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Entra token provider", () => {
  test("initializes lazily, coalesces concurrent acquisition, caches and refreshes", async () => {
    const token = createEntraTokenProvider(BASE_URL, SCOPE);
    expect(credentialConstructor).not.toHaveBeenCalled();
    expect(await Promise.all([token(), token(), token()])).toEqual([
      "fake-token-1",
      "fake-token-1",
      "fake-token-1",
    ]);
    expect(getToken).toHaveBeenCalledTimes(1);
    expect(getToken.mock.calls[0][0]).toEqual([SCOPE]);
    now += TOKEN_LIFETIME + 1;
    expect(await token()).toBe("fake-token-2");
    expect(credentialConstructor).toHaveBeenCalledTimes(1);
  });

  test.each([
    undefined,
    "not-a-url",
    "http://gateway.example/v1",
    "https://user:password@gateway.example/v1",
  ])("rejects unsafe endpoint %s before credential acquisition", (baseURL) => {
    expect(() => createEntraTokenProvider(baseURL, SCOPE)).toThrow(/HTTPS/u);
    expect(credentialConstructor).not.toHaveBeenCalled();
  });

  test("does not expose identity errors and allows retry after acquisition failure", async () => {
    getToken.mockRejectedValueOnce(new Error("private-identity-response"));
    const token = createEntraTokenProvider(BASE_URL, SCOPE);
    const error = await token().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Unable to obtain a Microsoft Entra ID access token",
    );
    expect((error as Error).message).not.toContain("private-identity-response");
    expect((error as Error).cause).toBeUndefined();
    expect(await token()).toBe("fake-token-2");
  });
});

function gatewayResponse(responsesApi: boolean, streaming: boolean): Response {
  const toolCall = {
    id: "call-1",
    type: "function",
    function: { name: "lookup", arguments: '{"path":"README.md"}' },
  };
  if (streaming && !responsesApi) {
    const chunks = [
      {
        index: 0,
        delta: { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] },
        finish_reason: null,
      },
      { index: 0, delta: {}, finish_reason: "tool_calls" },
    ]
      .map(
        (choice) =>
          `data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 0, model: "gateway-model", choices: [choice] })}\n\n`,
      )
      .join("");
    return new Response(`${chunks}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  }
  const response = {
    id: "resp-1",
    object: "response",
    created_at: 0,
    status: "completed",
    model: "gateway-model",
    output: [
      {
        type: "function_call",
        id: "fc-1",
        call_id: "call-1",
        name: "lookup",
        arguments: '{"path":"README.md"}',
        status: "completed",
      },
    ],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  if (streaming) {
    const events = [
      {
        type: "response.created",
        response: { ...response, status: "in_progress", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...response.output[0], arguments: "", status: "in_progress" },
      },
      {
        type: "response.function_call_arguments.delta",
        item_id: "fc-1",
        output_index: 0,
        delta: '{"path":"README.md"}',
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: response.output[0],
      },
      { type: "response.completed", response },
    ];
    return new Response(
      events
        .map(
          (event, i) =>
            `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: i })}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  return new Response(
    JSON.stringify(
      responsesApi
        ? response
        : {
            id: "chat-1",
            object: "chat.completion",
            created: 0,
            model: "gateway-model",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [toolCall],
                },
                finish_reason: "tool_calls",
              },
            ],
          },
    ),
    { headers: { "content-type": "application/json" } },
  );
}

describe("Entra gateway transport", () => {
  test.each([
    { responsesApi: false, streaming: false },
    { responsesApi: false, streaming: true },
    { responsesApi: true, streaming: false },
    { responsesApi: true, streaming: true },
  ])(
    "refreshes an existing model with tool calls ($responsesApi Responses, $streaming SSE)",
    async ({ responsesApi, streaming }) => {
      vi.stubEnv(
        "OPENWIKI_OPENAI_COMPATIBLE_USE_RESPONSES_API",
        String(responsesApi),
      );
      vi.stubEnv("OPENWIKI_OPENAI_COMPATIBLE_STREAMING", String(streaming));
      // Entra mode must take precedence over stale API-key configuration.
      vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "ignored-static-key");
      const requests: {
        url: string;
        authorization: string | null;
        body: Record<string, unknown>;
      }[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((input: string | URL | Request, init?: RequestInit) => {
          if (typeof init?.body !== "string") {
            throw new Error("Expected a JSON request body");
          }
          requests.push({
            url: input instanceof Request ? input.url : input.toString(),
            authorization: new Headers(init?.headers).get("Authorization"),
            body: JSON.parse(init.body) as Record<string, unknown>,
          });
          return Promise.resolve(gatewayResponse(responsesApi, streaming));
        }),
      );
      const model = (
        createModel("openai-compatible", "gateway-model", 0) as ChatOpenAI
      ).bindTools([
        {
          type: "function",
          function: {
            name: "lookup",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
          },
        },
      ]);
      const invoke = async (message: string) => {
        if (!streaming) {
          return model.invoke(message);
        }

        const chunks = [];
        for await (const chunk of await model.stream(message)) {
          chunks.push(chunk);
        }
        const [first, ...rest] = chunks;
        if (!first) {
          throw new Error("Expected the gateway to return at least one chunk");
        }
        return rest.reduce((combined, chunk) => combined.concat(chunk), first);
      };

      const first = await invoke("Look up README.md");
      now += TOKEN_LIFETIME + 1;
      const second = await invoke("Look up README.md again");
      for (const result of [first, second]) {
        expect(result.tool_calls).toMatchObject([
          { name: "lookup", args: { path: "README.md" }, id: "call-1" },
        ]);
      }
      expect(requests.map((request) => request.authorization)).toEqual([
        "Bearer fake-token-1",
        "Bearer fake-token-2",
      ]);
      expect(requests.map((request) => request.url)).toEqual(
        Array(2).fill(
          `${BASE_URL}/${responsesApi ? "responses" : "chat/completions"}`,
        ),
      );
      expect(requests[0].body.tools).toHaveLength(1);
      expect(requests[0].body.stream ?? false).toBe(streaming);
      expect(getToken).toHaveBeenCalledTimes(2);
      expect(credentialConstructor).toHaveBeenCalledTimes(1);
    },
  );

  test("fails without sending a gateway request or falling back to an API key", async () => {
    vi.stubEnv("OPENAI_COMPATIBLE_API_KEY", "ignored-static-key");
    getToken.mockRejectedValue(new Error("private-identity-response"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const model = createModel(
      "openai-compatible",
      "gateway-model",
      0,
    ) as ChatOpenAI;
    await expect(model.invoke("hello")).rejects.toThrow(
      /Unable to obtain a Microsoft Entra ID access token/u,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
