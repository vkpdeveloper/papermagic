import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const documentsTable = sqliteTable('documents', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  author: text('author').notNull(),
  coverHue: integer('cover_hue').notNull(),
  coverImageUrl: text('cover_image_url'),
  sourceType: text('source_type').notNull(),
  description: text('description').notNull(),
  tocJson: text('toc_json').notNull(),
  metadataJson: text('metadata_json').notNull(),
  preferredMode: text('preferred_mode').notNull(),
})

export const chaptersTable = sqliteTable('chapters', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull(),
  title: text('title').notNull(),
  orderIndex: integer('order_index').notNull(),
  contentJson: text('content_json').notNull(),
})

export const progressTable = sqliteTable('reading_progress', {
  documentId: text('document_id').primaryKey(),
  progress: real('progress').notNull(),
  chapterId: text('chapter_id').notNull(),
  blockId: text('block_id').notNull(),
  pageIndex: integer('page_index').notNull(),
  readingMode: text('reading_mode').notNull(),
  lastOpenedAt: text('last_opened_at').notNull(),
})

export const highlightsTable = sqliteTable('highlights', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull(),
  chapterId: text('chapter_id').notNull(),
  blockId: text('block_id').notNull(),
  text: text('text').notNull(),
  createdAt: text('created_at').notNull(),
})

export const bookmarksTable = sqliteTable('bookmarks', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull(),
  chapterId: text('chapter_id').notNull(),
  blockId: text('block_id').notNull(),
  label: text('label').notNull(),
  createdAt: text('created_at').notNull(),
})

export const preferencesTable = sqliteTable('preferences', {
  id: integer('id').primaryKey(),
  fontSize: integer('font_size').notNull(),
  readingWidth: integer('reading_width').notNull(),
})

export const settingsTable = sqliteTable('app_settings', {
  id: integer('id').primaryKey(),
  aiEnabled: integer('ai_enabled', { mode: 'boolean' }).notNull().default(false),
  aiProvider: text('ai_provider'),
  aiModel: text('ai_model'),
  aiApiKey: text('ai_api_key'),
})

export const schema = {
  bookmarksTable,
  chaptersTable,
  documentsTable,
  highlightsTable,
  preferencesTable,
  progressTable,
  settingsTable,
}
