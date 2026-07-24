export type OneBot11JsonObject = Record<string, unknown>;

export type OneBot11Action = OneBot11JsonObject & {
  readonly action: string;
  readonly params: OneBot11JsonObject;
  readonly echo: string;
};

export function parseOneBot11JsonFrame(raw: string): OneBot11JsonObject {
  let frame: unknown;
  try {
    frame = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      "Invalid OneBot 11 JSON frame: " + normalizeError(error).message,
    );
  }

  const object = asObject(frame);
  if (object === undefined) {
    throw new Error("Invalid OneBot 11 frame: expected an object");
  }
  return object;
}

export function createOneBot11SendGroupTextAction(
  conversationId: string,
  text: string,
  echo: string,
): OneBot11Action {
  const groupId = parseOutgoingGroupId(conversationId);
  if (groupId === undefined) {
    throw new Error("OneBot 11 group ID must be a safe positive integer string");
  }
  if (typeof echo !== "string" || echo.length === 0) {
    throw new Error("OneBot 11 action echo must be a non-empty string");
  }

  return {
    action: "send_group_msg",
    params: {
      group_id: groupId,
      message: [{ type: "text", data: { text } }],
    },
    echo,
  };
}

function parseOutgoingGroupId(input: string): number | undefined {
  if (!/^[1-9]\d*$/u.test(input)) {
    return undefined;
  }
  const parsed = Number(input);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function asObject(input: unknown): OneBot11JsonObject | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as OneBot11JsonObject)
    : undefined;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
