// MongoDB connection and the one helper every money write goes through.

import { MongoClient, type ClientSession, type Db } from 'mongodb';
import { config } from '../config.ts';

// One client per process. The global keeps it across Next.js hot reloads.
const holder = globalThis as { __payoutRunsMongo?: MongoClient };

export function mongo(): MongoClient {
  holder.__payoutRunsMongo ??= new MongoClient(config.mongoUrl, { serverSelectionTimeoutMS: 5_000 });
  return holder.__payoutRunsMongo;
}

export function db(): Db {
  return mongo().db(config.mongoDb);
}

/**
 * Runs `work` in one multi-document transaction: every write commits or none
 * does. The driver retries the whole callback on a transient conflict, so the
 * callback must only write to the database (no HTTP calls, no queue sends).
 */
export async function inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  const session = mongo().startSession();
  try {
    return await session.withTransaction(() => work(session));
  } finally {
    await session.endSession();
  }
}

export async function closeDb(): Promise<void> {
  await holder.__payoutRunsMongo?.close();
  holder.__payoutRunsMongo = undefined;
}
