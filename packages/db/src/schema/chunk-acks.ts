import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const chunkAcks = pgTable(
  "chunk_acks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recordingId: text("recording_id").notNull(),
    chunkId: text("chunk_id").notNull(),
    sequenceNo: integer("sequence_no").notNull(),
    objectKey: text("object_key").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    durationMs: integer("duration_ms").notNull(),
    checksum: text("checksum"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    ackedAt: timestamp("acked_at").defaultNow().notNull(),
  },
  (table) => ({
    recordingSequenceUnique: uniqueIndex("chunk_acks_recording_sequence_unique").on(
      table.recordingId,
      table.sequenceNo,
    ),
    chunkIdUnique: uniqueIndex("chunk_acks_chunk_id_unique").on(table.chunkId),
  }),
);
