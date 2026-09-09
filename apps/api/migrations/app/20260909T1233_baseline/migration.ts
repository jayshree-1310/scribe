#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/61cd8b821c72071de38ad69cfea3f87d9c013f889c389c048eb92d83cec6878f/contract';
import endContract from '../../snapshots/61cd8b821c72071de38ad69cfea3f87d9c013f889c389c048eb92d83cec6878f/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  checkExpression,
  col,
  fn,
  lit,
  primaryKey,
} from '@prisma/orm-postgres/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createSchema({ schema: 'auth' }),
      this.createSchema({ schema: 'challenges' }),
      this.createSchema({ schema: 'channels' }),
      this.createSchema({ schema: 'clubs' }),
      this.createSchema({ schema: 'content' }),
      this.createSchema({ schema: 'engagement' }),
      this.createSchema({ schema: 'gamification' }),
      this.createSchema({ schema: 'library' }),
      this.createSchema({ schema: 'public' }),
      this.createTable({
        schema: 'auth',
        table: 'user',
        columns: [
          col('authorLevel', 'int4', {
            notNull: true,
            default: lit(1),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('email', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('isAuthor', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('passwordHash', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('readerLevel', 'int4', {
            notNull: true,
            default: lit(1),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('readingStreak', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('username', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'challenges',
        table: 'challengeEntry',
        columns: [
          col('challengeId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('submittedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'challenges',
        table: 'writingChallenge',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('description', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('endAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('startAt', 'timestamptz', {
            notNull: true,
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'channels',
        table: 'broadcastChannel',
        columns: [
          col('authorId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('description', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'channels',
        table: 'channelPost',
        columns: [
          col('channelId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('content', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('postedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'channels',
        table: 'channelSubscriber',
        columns: [
          col('channelId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('subscribedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'clubs',
        table: 'bookClub',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('creatorId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('description', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'clubs',
        table: 'clubMembership',
        columns: [
          col('clubId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('joinedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('role', 'text', {
            notNull: true,
            default: lit('MEMBER'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'clubMembership_role_check_50a44636',
            "\"role\" IN ('OWNER', 'ADMIN', 'MEMBER')",
          ),
        ],
      }),
      this.createTable({
        schema: 'content',
        table: 'chapter',
        columns: [
          col('chapterNumber', 'int4', { notNull: true, codecRef: { codecId: 'pg/int4@1' } }),
          col('content', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('publishedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'content',
        table: 'genre',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('hue', 'int4', {
            notNull: true,
            default: lit(268),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'content',
        table: 'multimedia',
        columns: [
          col('chapterId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('displayOrder', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('type', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('url', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'multimedia_type_check_cb66da76',
            "\"type\" IN ('IMAGE', 'AUDIO', 'VIDEO', 'LINK')",
          ),
        ],
      }),
      this.createTable({
        schema: 'content',
        table: 'story',
        columns: [
          col('authorId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('coverUrl', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('description', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('isCompleted', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('isbn', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('kidsAppropriate', 'bool', {
            notNull: true,
            default: lit(false),
            codecRef: { codecId: 'pg/bool@1' },
          }),
          col('likeCount', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('pageCount', 'int4', { codecRef: { codecId: 'pg/int4@1' } }),
          col('publishedAt', 'timestamptz', { codecRef: { codecId: 'pg/timestamptz-temporal@1' } }),
          col('publisher', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('ratingAverage', 'numeric', { codecRef: { codecId: 'pg/numeric@1' } }),
          col('title', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('viewCount', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'content',
        table: 'storyGenre',
        columns: [
          col('genreId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['storyId', 'genreId'])],
      }),
      this.createTable({
        schema: 'engagement',
        table: 'comment',
        columns: [
          col('chapterId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('content', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'engagement',
        table: 'rating',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('rating', 'numeric', { notNull: true, codecRef: { codecId: 'pg/numeric@1' } }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'engagement',
        table: 'readingHistory',
        columns: [
          col('chapterId', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('lastReadAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('progress', 'int4', {
            notNull: true,
            default: lit(0),
            codecRef: { codecId: 'pg/int4@1' },
          }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'gamification',
        table: 'badge',
        columns: [
          col('createdAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('description', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('imageUrl', 'text', { codecRef: { codecId: 'pg/text@1' } }),
          col('name', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'gamification',
        table: 'userBadge',
        columns: [
          col('badgeId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('earnedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        schema: 'library',
        table: 'libraryEntry',
        columns: [
          col('addedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('id', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('status', 'text', {
            notNull: true,
            default: lit('WANT_TO_READ'),
            codecRef: { codecId: 'pg/text@1' },
          }),
          col('storyId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
          col('updatedAt', 'timestamptz', {
            notNull: true,
            default: fn('now()'),
            codecRef: { codecId: 'pg/timestamptz-temporal@1' },
          }),
          col('userId', 'text', { notNull: true, codecRef: { codecId: 'pg/text@1' } }),
        ],
        constraints: [
          primaryKey(['id']),
          checkExpression(
            'libraryEntry_status_check_f8242d24',
            "\"status\" IN ('WANT_TO_READ', 'READING', 'FINISHED')",
          ),
        ],
      }),
      this.addUnique({
        schema: 'auth',
        table: 'user',
        constraint: 'user_username_key',
        columns: ['username'],
      }),
      this.addUnique({
        schema: 'auth',
        table: 'user',
        constraint: 'user_email_key',
        columns: ['email'],
      }),
      this.addUnique({
        schema: 'challenges',
        table: 'challengeEntry',
        constraint: 'challengeEntry_challengeId_userId_storyId_key',
        columns: ['challengeId', 'userId', 'storyId'],
      }),
      this.addUnique({
        schema: 'channels',
        table: 'channelSubscriber',
        constraint: 'channelSubscriber_channelId_userId_key',
        columns: ['channelId', 'userId'],
      }),
      this.addUnique({
        schema: 'clubs',
        table: 'clubMembership',
        constraint: 'clubMembership_clubId_userId_key',
        columns: ['clubId', 'userId'],
      }),
      this.addUnique({
        schema: 'content',
        table: 'chapter',
        constraint: 'chapter_storyId_chapterNumber_key',
        columns: ['storyId', 'chapterNumber'],
      }),
      this.addUnique({
        schema: 'content',
        table: 'genre',
        constraint: 'genre_name_key',
        columns: ['name'],
      }),
      this.addUnique({
        schema: 'content',
        table: 'story',
        constraint: 'story_isbn_key',
        columns: ['isbn'],
      }),
      this.addUnique({
        schema: 'engagement',
        table: 'rating',
        constraint: 'rating_userId_storyId_key',
        columns: ['userId', 'storyId'],
      }),
      this.addUnique({
        schema: 'engagement',
        table: 'readingHistory',
        constraint: 'readingHistory_userId_storyId_key',
        columns: ['userId', 'storyId'],
      }),
      this.addUnique({
        schema: 'gamification',
        table: 'badge',
        constraint: 'badge_name_key',
        columns: ['name'],
      }),
      this.addUnique({
        schema: 'gamification',
        table: 'userBadge',
        constraint: 'userBadge_userId_badgeId_key',
        columns: ['userId', 'badgeId'],
      }),
      this.addUnique({
        schema: 'library',
        table: 'libraryEntry',
        constraint: 'libraryEntry_userId_storyId_key',
        columns: ['userId', 'storyId'],
      }),
      this.createIndex({
        schema: 'challenges',
        table: 'challengeEntry',
        index: 'challengeEntry_challengeId_idx_73b8115d',
        columns: ['challengeId'],
      }),
      this.createIndex({
        schema: 'challenges',
        table: 'challengeEntry',
        index: 'challengeEntry_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.createIndex({
        schema: 'challenges',
        table: 'challengeEntry',
        index: 'challengeEntry_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'channels',
        table: 'broadcastChannel',
        index: 'broadcastChannel_authorId_idx_e47547ed',
        columns: ['authorId'],
      }),
      this.createIndex({
        schema: 'channels',
        table: 'channelPost',
        index: 'channelPost_channelId_idx_166d3598',
        columns: ['channelId'],
      }),
      this.createIndex({
        schema: 'channels',
        table: 'channelSubscriber',
        index: 'channelSubscriber_channelId_idx_166d3598',
        columns: ['channelId'],
      }),
      this.createIndex({
        schema: 'channels',
        table: 'channelSubscriber',
        index: 'channelSubscriber_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'clubs',
        table: 'bookClub',
        index: 'bookClub_creatorId_idx_3a77d800',
        columns: ['creatorId'],
      }),
      this.createIndex({
        schema: 'clubs',
        table: 'clubMembership',
        index: 'clubMembership_clubId_idx_7aff947d',
        columns: ['clubId'],
      }),
      this.createIndex({
        schema: 'clubs',
        table: 'clubMembership',
        index: 'clubMembership_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'content',
        table: 'chapter',
        index: 'chapter_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.createIndex({
        schema: 'content',
        table: 'multimedia',
        index: 'multimedia_chapterId_idx_411dd3d6',
        columns: ['chapterId'],
      }),
      this.createIndex({
        schema: 'content',
        table: 'story',
        index: 'story_authorId_idx_e47547ed',
        columns: ['authorId'],
      }),
      this.createIndex({
        schema: 'content',
        table: 'storyGenre',
        index: 'storyGenre_genreId_idx_8fce6a7b',
        columns: ['genreId'],
      }),
      this.createIndex({
        schema: 'content',
        table: 'storyGenre',
        index: 'storyGenre_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'comment',
        index: 'comment_chapterId_idx_411dd3d6',
        columns: ['chapterId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'comment',
        index: 'comment_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'comment',
        index: 'comment_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'rating',
        index: 'rating_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'rating',
        index: 'rating_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'readingHistory',
        index: 'readingHistory_chapterId_idx_411dd3d6',
        columns: ['chapterId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'readingHistory',
        index: 'readingHistory_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.createIndex({
        schema: 'engagement',
        table: 'readingHistory',
        index: 'readingHistory_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'gamification',
        table: 'userBadge',
        index: 'userBadge_badgeId_idx_e78e6f52',
        columns: ['badgeId'],
      }),
      this.createIndex({
        schema: 'gamification',
        table: 'userBadge',
        index: 'userBadge_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'library',
        table: 'libraryEntry',
        index: 'libraryEntry_storyId_idx_cd452158',
        columns: ['storyId'],
      }),
      this.createIndex({
        schema: 'library',
        table: 'libraryEntry',
        index: 'libraryEntry_userId_idx_a489d58a',
        columns: ['userId'],
      }),
      this.createIndex({
        schema: 'library',
        table: 'libraryEntry',
        index: 'libraryEntry_userId_status_addedAt_idx_0db0014a',
        columns: ['userId', 'status', 'addedAt'],
      }),
      this.addForeignKey({
        schema: 'challenges',
        table: 'challengeEntry',
        foreignKey: {
          name: 'challengeEntry_challengeId_fkey',
          columns: ['challengeId'],
          references: { schema: 'challenges', table: 'writingChallenge', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'challenges',
        table: 'challengeEntry',
        foreignKey: {
          name: 'challengeEntry_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'challenges',
        table: 'challengeEntry',
        foreignKey: {
          name: 'challengeEntry_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'channels',
        table: 'broadcastChannel',
        foreignKey: {
          name: 'broadcastChannel_authorId_fkey',
          columns: ['authorId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'channels',
        table: 'channelPost',
        foreignKey: {
          name: 'channelPost_channelId_fkey',
          columns: ['channelId'],
          references: { schema: 'channels', table: 'broadcastChannel', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'channels',
        table: 'channelSubscriber',
        foreignKey: {
          name: 'channelSubscriber_channelId_fkey',
          columns: ['channelId'],
          references: { schema: 'channels', table: 'broadcastChannel', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'channels',
        table: 'channelSubscriber',
        foreignKey: {
          name: 'channelSubscriber_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'clubs',
        table: 'bookClub',
        foreignKey: {
          name: 'bookClub_creatorId_fkey',
          columns: ['creatorId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'clubs',
        table: 'clubMembership',
        foreignKey: {
          name: 'clubMembership_clubId_fkey',
          columns: ['clubId'],
          references: { schema: 'clubs', table: 'bookClub', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'clubs',
        table: 'clubMembership',
        foreignKey: {
          name: 'clubMembership_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'content',
        table: 'chapter',
        foreignKey: {
          name: 'chapter_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'content',
        table: 'multimedia',
        foreignKey: {
          name: 'multimedia_chapterId_fkey',
          columns: ['chapterId'],
          references: { schema: 'content', table: 'chapter', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'content',
        table: 'story',
        foreignKey: {
          name: 'story_authorId_fkey',
          columns: ['authorId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'content',
        table: 'storyGenre',
        foreignKey: {
          name: 'storyGenre_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'content',
        table: 'storyGenre',
        foreignKey: {
          name: 'storyGenre_genreId_fkey',
          columns: ['genreId'],
          references: { schema: 'content', table: 'genre', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'comment',
        foreignKey: {
          name: 'comment_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'comment',
        foreignKey: {
          name: 'comment_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'comment',
        foreignKey: {
          name: 'comment_chapterId_fkey',
          columns: ['chapterId'],
          references: { schema: 'content', table: 'chapter', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'rating',
        foreignKey: {
          name: 'rating_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'rating',
        foreignKey: {
          name: 'rating_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'readingHistory',
        foreignKey: {
          name: 'readingHistory_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'readingHistory',
        foreignKey: {
          name: 'readingHistory_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'engagement',
        table: 'readingHistory',
        foreignKey: {
          name: 'readingHistory_chapterId_fkey',
          columns: ['chapterId'],
          references: { schema: 'content', table: 'chapter', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'gamification',
        table: 'userBadge',
        foreignKey: {
          name: 'userBadge_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'gamification',
        table: 'userBadge',
        foreignKey: {
          name: 'userBadge_badgeId_fkey',
          columns: ['badgeId'],
          references: { schema: 'gamification', table: 'badge', columns: ['id'] },
        },
      }),
      this.addForeignKey({
        schema: 'library',
        table: 'libraryEntry',
        foreignKey: {
          name: 'libraryEntry_userId_fkey',
          columns: ['userId'],
          references: { schema: 'auth', table: 'user', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
      this.addForeignKey({
        schema: 'library',
        table: 'libraryEntry',
        foreignKey: {
          name: 'libraryEntry_storyId_fkey',
          columns: ['storyId'],
          references: { schema: 'content', table: 'story', columns: ['id'] },
          onDelete: 'cascade',
        },
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
