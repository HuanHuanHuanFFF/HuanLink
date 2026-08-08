import type {
  OneBot11Action,
  OneBot11ActionContext,
  OneBot11EventListener,
  OneBot11JsonObject,
  OneBot11Transport,
} from "../src/index.js";
import { OneBot11Operations } from "../src/index.js";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vitest";

class RecordingTransport implements OneBot11Transport {
  readonly start = vi.fn(async () => undefined);
  readonly close = vi.fn(async () => undefined);
  readonly actions: OneBot11Action[] = [];

  onEvent(_listener: OneBot11EventListener): () => void {
    return () => undefined;
  }

  async sendAction(
    action: OneBot11Action,
    _context: OneBot11ActionContext,
  ): Promise<OneBot11JsonObject> {
    this.actions.push(action);
    return { status: "ok", retcode: 0, data: null, echo: action.echo };
  }
}

function createOperations(transport = new RecordingTransport()): {
  operations: OneBot11Operations;
  transport: RecordingTransport;
} {
  return {
    operations: new OneBot11Operations({
      channelId: "qq-main",
      transport,
      fileUpload: {
        createUploadGroupFileAction: (input, echo) => ({
          action: "upload_group_file",
          params: { group_id: input.groupId, file: input.path },
          echo,
        }),
      },
      forwardMessages: { protocol: "go-cqhttp-compatible" },
    }),
    transport,
  };
}

function call(operation: () => Promise<unknown>): Promise<unknown> {
  return Promise.resolve().then(operation);
}

describe("OneBot11Operations validation", () => {
  test.each(["0", "01", "-1", " 1", "1.5", "abc"])(
    "rejects invalid positive ID %s before transport dispatch",
    async (groupId) => {
      const { operations, transport } = createOperations();

      await expect(
        call(() => operations.standard.getGroupInfo({ groupId })),
      ).rejects.toThrow("positive integer string");
      expect(transport.actions).toEqual([]);
    },
  );

  test("keeps an integer ID larger than Number.MAX_SAFE_INTEGER as a string", async () => {
    const { operations, transport } = createOperations();
    const groupId = "9223372036854775807";

    await operations.standard.getGroupInfo({ groupId });

    expect(transport.actions[0]?.params.group_id).toBe(groupId);
  });

  test("rejects non-integer message IDs", async () => {
    const { operations, transport } = createOperations();

    await expect(
      call(() => operations.privileged.deleteMessage({ messageId: "1.5" })),
    ).rejects.toThrow("integer string");
    expect(transport.actions).toEqual([]);
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid mute duration %s",
    async (durationSeconds) => {
      const { operations, transport } = createOperations();

      await expect(
        call(() =>
          operations.privileged.setGroupBan({
            groupId: "20002",
            userId: "10001",
            durationSeconds,
          }),
        ),
      ).rejects.toThrow("non-negative safe integer");
      expect(transport.actions).toEqual([]);
    },
  );

  test("allows -1 only for the special-title permanent duration", async () => {
    const { operations, transport } = createOperations();

    await operations.privileged.setGroupSpecialTitle({
      groupId: "20002",
      userId: "10001",
      title: "title",
      durationSeconds: -1,
    });
    await expect(
      call(() =>
        operations.privileged.setGroupSpecialTitle({
          groupId: "20002",
          userId: "10001",
          title: "title",
          durationSeconds: -2,
        }),
      ),
    ).rejects.toThrow("non-negative safe integer");
    expect(transport.actions).toHaveLength(1);
  });

  test.each([0, 11, 1.5])(
    "rejects invalid friend-like count %s",
    async (times) => {
      const { operations, transport } = createOperations();

      await expect(
        call(() => operations.standard.sendLike({ userId: "10001", times })),
      ).rejects.toThrow("integer from 1 to 10");
      expect(transport.actions).toEqual([]);
    },
  );

  test("rejects unsupported group honor and request enum values", async () => {
    const { operations, transport } = createOperations();

    await expect(
      call(() =>
        operations.standard.getGroupHonorInfo({
          groupId: "20002",
          type: "unknown" as never,
        }),
      ),
    ).rejects.toThrow("group honor type");
    await expect(
      call(() =>
        operations.privileged.setGroupAddRequest({
          flag: "request-1",
          subType: "unknown" as never,
          approve: true,
        }),
      ),
    ).rejects.toThrow("group request subType");
    expect(transport.actions).toEqual([]);
  });

  test("rejects additional fields instead of silently forwarding them", async () => {
    const { operations, transport } = createOperations();

    await expect(
      call(() =>
        operations.privileged.setGroupKick({
          groupId: "20002",
          userId: "10001",
          hiddenAction: "set_restart",
        } as never),
      ),
    ).rejects.toThrow("unsupported field hiddenAction");
    expect(transport.actions).toEqual([]);
  });

  test("rejects invalid forward nodes before transport dispatch", async () => {
    const { operations, transport } = createOperations();

    await expect(
      operations.standard.sendGroupForwardMessage({
        groupId: "20002",
        nodes: [],
      }),
    ).rejects.toThrow("non-empty array");
    await expect(
      operations.standard.sendGroupForwardMessage({
        groupId: "20002",
        nodes: [
          {
            kind: "reference",
            messageId: "1.5",
          },
        ],
      }),
    ).rejects.toThrow("integer string");
    await expect(
      operations.standard.sendPrivateForwardMessage({
        userId: "10001",
        nodes: [
          {
            kind: "custom",
            userId: "10002",
            displayName: "Alice",
            content: "",
          },
        ],
      }),
    ).rejects.toThrow("non-empty string");
    expect(transport.actions).toEqual([]);
  });

  test("allows whitespace content in a custom forward node", async () => {
    const { operations, transport } = createOperations();

    await operations.standard.sendPrivateForwardMessage({
      userId: "10001",
      nodes: [
        {
          kind: "custom",
          userId: "10002",
          displayName: "Alice",
          content: " ",
        },
      ],
    });

    expect(transport.actions[0]?.params.messages).toEqual([
      {
        type: "node",
        data: { uin: 10002, name: "Alice", content: " " },
      },
    ]);
  });

  test.each(["relative/file.txt", "file:///tmp/file.txt"])(
    "rejects non-local upload path %s",
    async (path) => {
      const { operations, transport } = createOperations();

      await expect(
        operations.standard.uploadGroupFile({ groupId: "20002", path }),
      ).rejects.toThrow("path must be absolute");
      expect(transport.actions).toEqual([]);
    },
  );

  test("rejects a directory even when it is an absolute readable path", async () => {
    const { operations, transport } = createOperations();
    const directory = fileURLToPath(new URL(".", import.meta.url));

    await expect(
      operations.standard.uploadGroupFile({
        groupId: "20002",
        path: directory,
      }),
    ).rejects.toThrow("readable file");
    expect(transport.actions).toEqual([]);
  });

  test("rejects an extension action that replaces the assigned echo", async () => {
    const transport = new RecordingTransport();
    const operations = new OneBot11Operations({
      channelId: "qq-main",
      transport,
      fileUpload: {
        createUploadGroupFileAction: (input) => ({
          action: "upload_group_file",
          params: { group_id: input.groupId, file: input.path },
          echo: "replaced",
        }),
      },
    });

    await expect(
      operations.standard.uploadGroupFile({
        groupId: "20002",
        path: fileURLToPath(import.meta.url),
      }),
    ).rejects.toThrow("preserve the assigned echo");
    expect(transport.actions).toEqual([]);
  });
});
