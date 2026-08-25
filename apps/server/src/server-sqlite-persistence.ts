import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  openSqliteHuanLinkStore,
  type AsyncToolTaskStore,
  type ConversationSessionStore,
} from "@huanlink/core";

import type { HuanLinkServerStoreCloseOwner } from "./huanlink-server-runtime.js";

export type ServerSqlitePersistence = {
  readonly sessionStore: ConversationSessionStore;
  readonly taskStore: AsyncToolTaskStore;
  readonly storeOwner: HuanLinkServerStoreCloseOwner;
};

/** Opens the single production SQLite owner at HuanLink's fixed local path. */
export async function createServerSqlitePersistence(input: {
  readonly projectRoot: string;
}): Promise<ServerSqlitePersistence> {
  const dataRoot = join(resolve(input.projectRoot), ".huanlink", "data");
  await mkdir(dataRoot, { recursive: true });
  const stores = openSqliteHuanLinkStore(join(dataRoot, "huanlink.sqlite"));
  return {
    sessionStore: stores.sessionStore,
    taskStore: stores.taskStore,
    storeOwner: stores,
  };
}
