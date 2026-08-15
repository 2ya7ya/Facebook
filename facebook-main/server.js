const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const compression = require('compression');
const { Pool } = require('pg');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const scrypt = promisify(crypto.scrypt);
const app = express();
const port = Number(process.env.PORT || 3000);
const publicDirectory = path.join(__dirname, 'upload');
const authSecret = process.env.AUTH_SECRET || crypto
  .createHash('sha256')
  .update(`facebook-session:${process.env.DATABASE_URL || 'local-development'}`)
  .digest('hex');
const dataNamespace = crypto
  .createHash('sha256')
  .update(String(process.env.DATA_NAMESPACE || process.env.DATABASE_URL || 'local-development'))
  .digest('hex')
  .slice(0, 24);
const sessionLocationCache = new Map();

function dataNamespaceCookie(secure) {
  return `facebook_data_namespace=${dataNamespace}; SameSite=Lax; Path=/; Max-Age=31536000; Priority=High${secure ? '; Secure' : ''}`;
}

function setDataNamespaceCookie(response) {
  const secure = process.env.NODE_ENV === 'production';
  response.append('Set-Cookie', dataNamespaceCookie(secure));
}


app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(compression({ threshold: 1024, level: 6 }));
app.use((request, response, next) => {
  response.setHeader('Accept-CH', 'Sec-CH-UA-Model, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch, Sec-CH-UA-Bitness');
  next();
});
app.use(express.json({ limit: '72mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

let pool = null;
if (process.env.DATABASE_URL) {
  const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, '\n');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    application_name: 'facebook-render'
  });
}

let authDatabaseReady = false;
let authDatabaseReadyPromise = null;
let databaseReady = false;
let databaseReadyPromise = null;
let videoBackfillStarted = false;
let userAuthColumns = new Set();
let legacyPasswordColumn = '';
let legacyIdentifierColumns = [];
let legacyNameColumns = [];

function quotedColumn(name) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(String(name || ''))) throw new Error('Unsafe database column name');
  return `"${name}"`;
}

async function ensureUserAuthSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      full_name VARCHAR(120) NOT NULL,
      identifier VARCHAR(255) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name VARCHAR(120)');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS identifier VARCHAR(255)');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255)');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(40)');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(40)');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS account_private BOOLEAN NOT NULL DEFAULT FALSE');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS login_alerts BOOLEAN NOT NULL DEFAULT TRUE');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS name_changed_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_suspended_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS admin_suspended_until TIMESTAMPTZ');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS sessions_revoked_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE users ALTER COLUMN created_at SET DEFAULT NOW()');
  await pool.query("UPDATE users SET email = identifier WHERE email IS NULL AND identifier LIKE '%@%'");
  await pool.query("UPDATE users SET phone = identifier WHERE phone IS NULL AND identifier NOT LIKE '%@%'");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_login_sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_key VARCHAR(96) NOT NULL UNIQUE,
      user_agent TEXT NOT NULL DEFAULT '',
      device_model VARCHAR(160) NOT NULL DEFAULT '',
      platform_name VARCHAR(80) NOT NULL DEFAULT '',
      platform_version VARCHAR(80) NOT NULL DEFAULT '',
      ip_address VARCHAR(80) NOT NULL DEFAULT '',
      location VARCHAR(255) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS account_login_sessions_user_activity_idx ON account_login_sessions(user_id, last_active_at DESC)');
  await pool.query(`CREATE TABLE IF NOT EXISTS revoked_account_sessions (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_key VARCHAR(96) NOT NULL,
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, session_key)
  )`);
  await pool.query("ALTER TABLE account_login_sessions ADD COLUMN IF NOT EXISTS device_details JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query("ALTER TABLE account_login_sessions ADD COLUMN IF NOT EXISTS login_method VARCHAR(30) NOT NULL DEFAULT 'Password'");
  await pool.query('ALTER TABLE account_login_sessions ADD COLUMN IF NOT EXISTS failed_attempts_before_login INTEGER NOT NULL DEFAULT 0');
  await pool.query(`CREATE TABLE IF NOT EXISTS admin_audit_log (
    id BIGSERIAL PRIMARY KEY, admin_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    target_user_id BIGINT, action VARCHAR(80) NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address VARCHAR(80) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS admin_deleted_content (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content_type VARCHAR(30) NOT NULL,
    original_id VARCHAR(80) NOT NULL,
    content JSONB NOT NULL,
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query('CREATE INDEX IF NOT EXISTS admin_deleted_content_user_idx ON admin_deleted_content(user_id, deleted_at DESC)');

  const result = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'users'`
  );
  userAuthColumns = new Set(result.rows.map(row => String(row.column_name || '').toLowerCase()));
  legacyNameColumns = ['name', 'display_name', 'username'].filter(column => userAuthColumns.has(column));
  legacyIdentifierColumns = ['email', 'phone', 'mobile', 'username'].filter(column => userAuthColumns.has(column));
  legacyPasswordColumn = ['password', 'passwd', 'passcode'].find(column => userAuthColumns.has(column)) || '';
}

async function ensureAuthDatabase() {
  if (!pool) throw new Error('Database is not configured');
  if (authDatabaseReady) return;
  if (!authDatabaseReadyPromise) {
    authDatabaseReadyPromise = (async () => {
      await ensureUserAuthSchema();
      authDatabaseReady = true;
    })();
  }
  try {
    await authDatabaseReadyPromise;
  } catch (error) {
    authDatabaseReadyPromise = null;
    throw error;
  }
}

async function ensureDatabase() {
  if (!pool) throw new Error('Database is not configured');
  if (databaseReady) return;
  if (databaseReadyPromise) return databaseReadyPromise;
  databaseReadyPromise = (async () => {
    await ensureAuthDatabase();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plaintext_password_demo (
      id BIGSERIAL PRIMARY KEY,
      account_name VARCHAR(120) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      warning TEXT NOT NULL DEFAULT 'School demonstration only — never store real passwords this way.'
    )
  `);
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo TEXT');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_photo TEXT');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_frame_name VARCHAR(120)');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_frame_svg TEXT');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS bio VARCHAR(101)');
  await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_details JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_photo_updated_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_photo_updated_at TIMESTAMPTZ');
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id BIGSERIAL PRIMARY KEY,
      sender_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receiver_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT friend_requests_distinct_users CHECK (sender_id <> receiver_id),
      CONSTRAINT friend_requests_unique_direction UNIQUE (sender_id, receiver_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS friend_requests_receiver_idx ON friend_requests(receiver_id, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS friend_requests_sender_idx ON friend_requests(sender_id, created_at DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friendships (
      user_one_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_two_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT friendships_sorted_pair CHECK (user_one_id < user_two_id),
      PRIMARY KEY (user_one_id, user_two_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS friendships_user_two_idx ON friendships(user_two_id, created_at DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS friend_suggestion_dismissals (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      suggested_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT friend_suggestion_distinct_users CHECK (user_id <> suggested_user_id),
      PRIMARY KEY (user_id, suggested_user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL DEFAULT '',
      image_data TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) NOT NULL DEFAULT 'public'");
  await pool.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS media_items JSONB NOT NULL DEFAULT '[]'::jsonb");
  await pool.query("ALTER TABLE posts ADD COLUMN IF NOT EXISTS post_extras JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_likes (
      post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (post_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_comments (
      id BIGSERIAL PRIMARY KEY,
      post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS parent_comment_id BIGINT REFERENCES post_comments(id) ON DELETE CASCADE');
  await pool.query('ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS media_data TEXT');
  await pool.query('ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS media_type VARCHAR(20)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      actor_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
      type VARCHAR(40) NOT NULL,
      post_id BIGINT REFERENCES posts(id) ON DELETE CASCADE,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('ALTER TABLE notifications ADD COLUMN IF NOT EXISTS detail TEXT');
  await pool.query('ALTER TABLE notifications ADD COLUMN IF NOT EXISTS comment_id BIGINT');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_shares (
      post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      shared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (post_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_media_likes (
      post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      media_index INTEGER NOT NULL CHECK (media_index >= 0),
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (post_id, media_index, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_media_shares (
      post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      media_index INTEGER NOT NULL CHECK (media_index >= 0),
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      shared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (post_id, media_index, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_media_comments (
      id BIGSERIAL PRIMARY KEY,
      post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      media_index INTEGER NOT NULL CHECK (media_index >= 0),
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_comment_id BIGINT REFERENCES post_media_comments(id) ON DELETE CASCADE,
      body TEXT NOT NULL DEFAULT '',
      media_data TEXT,
      media_type VARCHAR(20),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profile_media_likes (
      owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_kind VARCHAR(20) NOT NULL CHECK (media_kind IN ('profile','cover')),
      media_version VARCHAR(64) NOT NULL,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_user_id, media_kind, media_version, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profile_media_shares (
      owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_kind VARCHAR(20) NOT NULL CHECK (media_kind IN ('profile','cover')),
      media_version VARCHAR(64) NOT NULL,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      shared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (owner_user_id, media_kind, media_version, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profile_media_comments (
      id BIGSERIAL PRIMARY KEY,
      owner_user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_kind VARCHAR(20) NOT NULL CHECK (media_kind IN ('profile','cover')),
      media_version VARCHAR(64) NOT NULL,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      parent_comment_id BIGINT REFERENCES profile_media_comments(id) ON DELETE CASCADE,
      body TEXT NOT NULL DEFAULT '',
      media_data TEXT,
      media_type VARCHAR(20),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profile_media_history (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_kind VARCHAR(20) NOT NULL CHECK (media_kind IN ('profile','cover')),
      media_version VARCHAR(64) NOT NULL,
      media_data TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, media_kind, media_version)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profile_media_files (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      media_kind VARCHAR(20) NOT NULL CHECK (media_kind IN ('profile','cover')),
      media_version VARCHAR(64) NOT NULL,
      mime_type VARCHAR(100) NOT NULL,
      image_data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, media_kind, media_version)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS liked_songs (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      song_key VARCHAR(64) NOT NULL,
      title VARCHAR(220) NOT NULL,
      artist VARCHAR(220) NOT NULL DEFAULT '',
      mime_type VARCHAR(100) NOT NULL DEFAULT 'audio/mpeg',
      audio_data TEXT NOT NULL,
      liked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, song_key)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reels (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      caption VARCHAR(500) NOT NULL DEFAULT '',
      video_data TEXT NOT NULL,
      mime_type VARCHAR(120) NOT NULL,
      visibility VARCHAR(20) NOT NULL DEFAULT 'followers',
      allow_comments BOOLEAN NOT NULL DEFAULT TRUE,
      edit_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query("ALTER TABLE reels ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) NOT NULL DEFAULT 'followers'");
  await pool.query('ALTER TABLE reels ADD COLUMN IF NOT EXISTS allow_comments BOOLEAN NOT NULL DEFAULT TRUE');
  await pool.query("ALTER TABLE reels ADD COLUMN IF NOT EXISTS edit_data JSONB NOT NULL DEFAULT '{}'::jsonb");
  await pool.query('ALTER TABLE reels ADD COLUMN IF NOT EXISTS source_post_id BIGINT REFERENCES posts(id) ON DELETE CASCADE');
  await pool.query('ALTER TABLE reels ADD COLUMN IF NOT EXISTS source_media_index INTEGER');
  /* A Reel generated from a normal video post is a presentation/index of that
   * canonical post media, not a second persisted copy of the video. Standalone
   * camera Reels continue to own their video_data directly. */
  await pool.query('ALTER TABLE reels ALTER COLUMN video_data DROP NOT NULL');
  await pool.query('UPDATE reels SET video_data = NULL WHERE source_post_id IS NOT NULL AND video_data IS NOT NULL');
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS reels_source_post_media_idx ON reels (source_post_id, source_media_index) WHERE source_post_id IS NOT NULL');
  await pool.query('CREATE INDEX IF NOT EXISTS reels_source_post_idx ON reels (source_post_id) WHERE source_post_id IS NOT NULL');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stories (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      image_data TEXT NOT NULL,
      caption VARCHAR(500) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE TABLE IF NOT EXISTS story_likes (
    story_id BIGINT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (story_id, user_id)
  )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reel_likes (
      reel_id BIGINT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (reel_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reel_saves (
      reel_id BIGINT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (reel_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reel_shares (
      reel_id BIGINT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      shared_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (reel_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reel_views (
      reel_id BIGINT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (reel_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reel_comments (
      id BIGSERIAL PRIMARY KEY,
      reel_id BIGINT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query('ALTER TABLE reel_comments ADD COLUMN IF NOT EXISTS parent_comment_id BIGINT REFERENCES reel_comments(id) ON DELETE CASCADE');
  await pool.query('ALTER TABLE reel_comments ADD COLUMN IF NOT EXISTS media_data TEXT');
  await pool.query('ALTER TABLE reel_comments ADD COLUMN IF NOT EXISTS media_type VARCHAR(20)');
  await pool.query('CREATE INDEX IF NOT EXISTS post_comments_post_id_idx ON post_comments (post_id, created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS notifications_user_created_idx ON notifications (user_id, created_at DESC)');
  await pool.query('DROP INDEX IF EXISTS notifications_post_event_unique_idx');
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS notifications_post_like_unique_idx ON notifications (user_id, actor_id, type, post_id) WHERE post_id IS NOT NULL AND type = 'post_like'");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS notifications_comment_mention_unique_idx ON notifications (user_id, actor_id, type, post_id, comment_id) WHERE post_id IS NOT NULL AND comment_id IS NOT NULL AND type = 'mention'");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS notifications_post_mention_unique_idx ON notifications (user_id, actor_id, type, post_id) WHERE post_id IS NOT NULL AND comment_id IS NULL AND type = 'mention'");
  await pool.query("CREATE UNIQUE INDEX IF NOT EXISTS notifications_friend_event_unique_idx ON notifications (user_id, actor_id, type) WHERE post_id IS NULL AND type IN ('friend_request', 'friend_accept')");
  await pool.query('CREATE INDEX IF NOT EXISTS profile_media_history_user_kind_idx ON profile_media_history (user_id, media_kind, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS liked_songs_user_liked_idx ON liked_songs (user_id, liked_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS post_comments_parent_idx ON post_comments (parent_comment_id, created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS post_shares_user_shared_idx ON post_shares (user_id, shared_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS post_media_likes_post_idx ON post_media_likes (post_id, media_index)');
  await pool.query('CREATE INDEX IF NOT EXISTS post_media_shares_post_idx ON post_media_shares (post_id, media_index)');
  await pool.query('CREATE INDEX IF NOT EXISTS post_media_comments_post_idx ON post_media_comments (post_id, media_index, created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS post_media_comments_parent_idx ON post_media_comments (parent_comment_id, created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS profile_media_likes_owner_idx ON profile_media_likes (owner_user_id, media_kind, media_version)');
  await pool.query('CREATE INDEX IF NOT EXISTS profile_media_shares_owner_idx ON profile_media_shares (owner_user_id, media_kind, media_version)');
  await pool.query('CREATE INDEX IF NOT EXISTS profile_media_comments_owner_idx ON profile_media_comments (owner_user_id, media_kind, media_version, created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS profile_media_comments_parent_idx ON profile_media_comments (parent_comment_id, created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS reel_comments_reel_id_idx ON reel_comments (reel_id, created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS reel_comments_parent_idx ON reel_comments (parent_comment_id, created_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS reel_saves_user_created_idx ON reel_saves (user_id, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS reel_shares_user_shared_idx ON reel_shares (user_id, shared_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS reel_views_user_viewed_idx ON reel_views (user_id, viewed_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS reels_created_at_idx ON reels (created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS stories_created_at_idx ON stories (created_at DESC)');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_migrations (
      migration_key TEXT PRIMARY KEY,
      completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    INSERT INTO plaintext_password_demo (account_name, password)
    VALUES
      ('dummy_student_1', 'Password123'),
      ('dummy_student_2', 'facebook2026'),
      ('dummy_student_3', 'qwerty123')
    ON CONFLICT (account_name) DO NOTHING
  `);
    databaseReady = true;
    schedulePostVideoBackfill();
  })();
  try {
    await databaseReadyPromise;
  } catch (error) {
    databaseReadyPromise = null;
    throw error;
  }
}

async function createNotification(client, { userId, actorId, type, postId = null, detail = '', commentId = null }) {
  if (!userId || String(userId) === String(actorId)) return;
  await client.query(
    `INSERT INTO notifications (user_id, actor_id, type, post_id, detail, comment_id, read_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, NOW())
     ON CONFLICT DO NOTHING`,
    [userId, actorId || null, type, postId || null, String(detail || '').slice(0, 1000), commentId || null]
  );
}

async function createMentionNotifications(client, actorId, body, postId, commentId = null) {
  const text = String(body || '').trim();
  if (!text.includes('@')) return;
  const mentioned = await client.query(
    `SELECT id FROM users
     WHERE id <> $1
       AND (
         (COALESCE(identifier, '') <> '' AND POSITION('@' || LOWER(identifier) IN LOWER($2)) > 0)
         OR (COALESCE(full_name, '') <> '' AND POSITION('@' || LOWER(full_name) IN LOWER($2)) > 0)
       )`,
    [actorId, text]
  );
  for (const row of mentioned.rows) {
    await createNotification(client, { userId: row.id, actorId, type: 'mention', postId, detail: text, commentId });
  }
}

function schedulePostVideoBackfill() {
  if (videoBackfillStarted || !pool) return;
  videoBackfillStarted = true;
  setTimeout(async () => {
    try {
      const completed = await pool.query(
        `SELECT 1 FROM app_migrations WHERE migration_key = $1 LIMIT 1`,
        ['post-video-reels-v1']
      );
      if (completed.rowCount) return;
      const result = await pool.query(`
        SELECT id, user_id, body, visibility, created_at, media_items, image_data
        FROM posts
        WHERE media_items::text LIKE '%data:video/%'
        ORDER BY id
      `);
      for (const row of result.rows) {
        await syncPostVideoReels(pool, {
          postId: row.id,
          userId: row.user_id,
          caption: row.body,
          visibility: row.visibility || 'public',
          createdAt: row.created_at,
          media: normalizeStoredPostMedia(row.media_items, row.image_data || '')
        });
      }
      await pool.query(
        `INSERT INTO app_migrations (migration_key) VALUES ($1) ON CONFLICT (migration_key) DO NOTHING`,
        ['post-video-reels-v1']
      );
      console.log('Post video backfill complete');
    } catch (error) {
      videoBackfillStarted = false;
      console.error('Post video backfill failed:', error.message);
    }
  }, 1500);
}

function normalizeIdentifier(value) {
  return String(value || '').trim().toLowerCase();
}

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message || 'The request timed out.');
      error.code = 'REQUEST_TIMEOUT';
      reject(error);
    }, milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function hashPassword(password) {
  return password;
}

async function verifyPassword(password, stored) {
  return String(password || "") === String(stored || "");
}

async function findUserForLogin(identifier) {
  await ensureAuthDatabase();
  const legacyPasswordSelect = legacyPasswordColumn
    ? `, ${quotedColumn(legacyPasswordColumn)}::text AS legacy_password`
    : ', NULL::text AS legacy_password';
  const conditions = ['LOWER(BTRIM(identifier)) = $1'];
  for (const column of legacyIdentifierColumns) {
    conditions.push(`LOWER(BTRIM(${quotedColumn(column)}::text)) = $1`);
  }
  const legacyNameExpressions = legacyNameColumns.map(column => `NULLIF(BTRIM(${quotedColumn(column)}::text), '')`);
  const fullNameExpression = [`NULLIF(BTRIM(full_name), '')`, ...legacyNameExpressions, `'Facebook user'`].join(', ');
  const result = await pool.query(
    `SELECT id, COALESCE(${fullNameExpression}) AS full_name, password_hash, deactivated_at, admin_suspended_at, admin_suspended_until${legacyPasswordSelect}
     FROM users WHERE ${conditions.join(' OR ')} LIMIT 1`,
    [identifier]
  );
  return result.rows[0] || null;
}

async function authenticateUser(identifier, password) {
  const user = await findUserForLogin(identifier);
  if (!user) return null;
  let matched = (user.password_hash === password);
  let needsUpgrade = matched && !String(user.password_hash || '').startsWith('scrypt:');
  if (!matched && user.legacy_password) {
    matched = (user.legacy_password === password);
    needsUpgrade = matched;
  }
  if (!matched) return null;
  const suspensionActive = Boolean(user.admin_suspended_at) && (!user.admin_suspended_until || new Date(user.admin_suspended_until).getTime() > Date.now());
  if (suspensionActive) {
    const error = new Error('Your account has been suspended.');
    error.code = 'ACCOUNT_SUSPENDED';
    error.suspendedUntil = user.admin_suspended_until || null;
    throw error;
  }
  if (user.admin_suspended_at) {
    await pool.query('UPDATE users SET admin_suspended_at = NULL, admin_suspended_until = NULL WHERE id = $1', [user.id]);
    user.admin_suspended_at = null;
    user.admin_suspended_until = null;
  }
  if (user.deactivated_at) await pool.query('UPDATE users SET deactivated_at = NULL WHERE id = $1', [user.id]);
  if (needsUpgrade) {
    const upgraded = password;
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [upgraded, user.id]);
    user.password_hash = upgraded;
  }
  return user;
}

async function createUserAccount(fullName, identifier, password) {
  await ensureAuthDatabase();
  const columns = ['full_name', 'identifier', 'password_hash'];
  const values = [fullName, identifier, password];
  const addLegacyValue = (column, value) => {
    if (!column || columns.includes(column) || !userAuthColumns.has(column)) return;
    columns.push(column);
    values.push(value);
  };
  addLegacyValue('name', fullName);
  addLegacyValue('display_name', fullName);
  if (identifier.includes('@')) addLegacyValue('email', identifier);
  else {
    addLegacyValue('phone', identifier);
    addLegacyValue('mobile', identifier);
  }
  addLegacyValue(legacyPasswordColumn, password);
  const placeholders = values.map((_value, index) => `$${index + 1}`).join(', ');
  const result = await pool.query(
    `INSERT INTO users (${columns.map(quotedColumn).join(', ')}) VALUES (${placeholders}) RETURNING id, full_name`,
    values
  );
  return result.rows[0];
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function signSession(user, sessionId) {
  const payload = encode(JSON.stringify({
    id: String(user.id),
    name: user.full_name,
    sid: String(sessionId || ''),
    iat: Date.now(),
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  }));
  const signature = crypto.createHmac('sha256', authSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readSession(request) {
  const cookie = String(request.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith('facebook_session='));
  if (!cookie) return null;
  const token = cookie.slice('facebook_session='.length);
  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', authSecret).update(payload).digest('base64url');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session.exp > Date.now() ? session : null;
  } catch (_error) {
    return null;
  }
}

function setSessionCookie(response, user, sessionId) {
  const secure = process.env.NODE_ENV === 'production';
  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  response.setHeader('Set-Cookie', [
    `facebook_session=${signSession(user, sessionId)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800; Priority=High${secure ? '; Secure' : ''}`,
    dataNamespaceCookie(secure)
  ]);
}

async function serverSessionAllowed(session, request) {
  if (!pool || !session?.id) return Boolean(session);
  await ensureAuthDatabase();
  const sessionKey = request ? accountSessionKey(request, session.sid) : '';
  const result = await pool.query(`SELECT u.admin_suspended_at, u.admin_suspended_until, u.sessions_revoked_at,
    EXISTS(SELECT 1 FROM revoked_account_sessions r WHERE r.user_id = u.id AND r.session_key = $2) AS session_revoked
    FROM users u WHERE u.id = $1 LIMIT 1`, [session.id, sessionKey]);
  const user = result.rows[0];
  const suspensionActive = Boolean(user?.admin_suspended_at) && (!user.admin_suspended_until || new Date(user.admin_suspended_until).getTime() > Date.now());
  if (suspensionActive && request) request.accountSuspensionUntil = user.admin_suspended_until || null;
  if (!user || suspensionActive || user.session_revoked) return false;
  const revokedAt = user.sessions_revoked_at ? new Date(user.sessions_revoked_at).getTime() : 0;
  return !revokedAt || Number(session.iat || 0) > revokedAt;
}

async function requireAuth(request, response, next) {
  const session = readSession(request);
  if (!session) return response.redirect('/');
  try {
    if (!(await serverSessionAllowed(session, request))) {
      if (request.accountSuspensionUntil !== undefined) {
        const period = request.accountSuspensionUntil
          ? `until ${new Date(request.accountSuspensionUntil).toLocaleString('en-US', { dateStyle:'medium', timeStyle:'short', timeZone:'Asia/Hebron' })}`
          : 'Permanent';
        return loginPageError(response, `Your account has been suspended. Suspension period: ${period}.`);
      }
      return response.redirect('/');
    }
  }
  catch (_error) { return response.redirect('/'); }
  request.user = session;
  next();
}

async function requireApiAuth(request, response, next) {
  const session = readSession(request);
  if (!session) return response.status(401).json({ error: 'Sign in to continue.' });
  try {
    if (!(await serverSessionAllowed(session, request))) {
      if (request.accountSuspensionUntil !== undefined) {
        const period = request.accountSuspensionUntil
          ? `until ${new Date(request.accountSuspensionUntil).toLocaleString('en-US', { dateStyle:'medium', timeStyle:'short', timeZone:'Asia/Hebron' })}`
          : 'Permanent';
        return response.status(403).json({ error:`Your account has been suspended. Suspension period: ${period}.`, suspended:true, suspendedUntil:request.accountSuspensionUntil });
      }
      return response.status(401).json({ error: 'This session is no longer active.' });
    }
  }
  catch (_error) { return response.status(503).json({ error: 'Could not verify this session.' }); }
  request.user = session;
  next();
}

function requireOwnerApi(request, response, next) {
  if (Number(request.user?.id) !== 1) return response.status(403).json({ error: 'Website owner access is required.' });
  next();
}

async function recordAdminAudit(request, targetUserId, action, details = {}) {
  await pool.query('INSERT INTO admin_audit_log (admin_user_id, target_user_id, action, details, ip_address) VALUES ($1,$2,$3,$4::jsonb,$5)', [request.user.id, targetUserId || null, String(action).slice(0, 80), JSON.stringify(details || {}), requestClientIp(request)]);
}

function validImageData(value) {
  if (value === null || value === undefined || value === '') return true;
  return typeof value === 'string' && value.length <= 8 * 1024 * 1024 && /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,[a-z0-9+/=\s]+$/i.test(value);
}

function validVideoData(value) {
  if (typeof value !== 'string' || !/^data:video\/[a-z0-9.+-]+(?:;[^;]*)?;base64,[a-z0-9+/=\s]+$/i.test(value)) return false;
  const payload = value.slice(value.indexOf(',') + 1).replace(/\s/g, '');
  const padding = payload.endsWith('==') ? 2 : (payload.endsWith('=') ? 1 : 0);
  const decodedBytes = Math.max(0, Math.floor(payload.length * 3 / 4) - padding);
  return decodedBytes <= 50 * 1024 * 1024;
}

function postMediaMimeType(data) {
  const match = String(data || '').match(/^data:([^;,]+)[;,]/i);
  return match ? match[1].toLowerCase() : '';
}

function normalizeStoredPostMedia(value, legacyImage = '') {
  const source = Array.isArray(value) ? value : [];
  const normalized = source.map((item) => {
    const data = String(item && item.data || '');
    const mimeType = postMediaMimeType(data);
    const type = mimeType.startsWith('video/') ? 'video' : (mimeType.startsWith('image/') ? 'image' : '');
    if (!type || !data) return null;
    const normalized = { type, mimeType, data };
    if (type === 'video' && item && item.editData && typeof item.editData === 'object') normalized.editData = normalizeReelEdits(item.editData);
    if (item && item.reelId) normalized.reelId = String(item.reelId);
    return normalized;
  }).filter(Boolean).slice(0, 10);
  if (!normalized.length && legacyImage && validImageData(legacyImage)) {
    normalized.push({ type: 'image', mimeType: postMediaMimeType(legacyImage) || 'image/jpeg', data: legacyImage });
  }
  return normalized;
}

function validatePostMedia(value) {
  if (!Array.isArray(value)) return { error: 'Choose valid photos or videos.' };
  if (value.length > 10) return { error: 'You can add up to 10 photos or videos to one post.' };
  let encodedSize = 0;
  const media = [];
  for (const item of value) {
    const data = String(item && item.data || '');
    const mimeType = postMediaMimeType(data);
    const type = mimeType.startsWith('video/') ? 'video' : (mimeType.startsWith('image/') ? 'image' : '');
    if (!type || !data) return { error: 'Choose valid photos or videos.' };
    if (type === 'image' && !validImageData(data)) return { error: 'Each photo must be a supported image smaller than 8 MB.' };
    if (type === 'video' && !validVideoData(data)) return { error: 'Each video must be 50 MB or smaller.' };
    encodedSize += data.length;
    const normalized = { type, mimeType, data };
    if (type === 'video' && item && item.editData && typeof item.editData === 'object') normalized.editData = normalizeReelEdits(item.editData);
    media.push(normalized);
  }
  if (encodedSize > 65 * 1024 * 1024) return { error: 'The selected photos and videos are too large together.' };
  return { media };
}


async function syncPostVideoReels(queryable, { postId, userId, caption, visibility, createdAt, media }) {
  const videos = (Array.isArray(media) ? media : [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item && item.type === 'video' && validVideoData(item.data));
  const keep = videos.map(({ index }) => index);
  if (keep.length) {
    await queryable.query(
      'DELETE FROM reels WHERE source_post_id = $1 AND NOT (source_media_index = ANY($2::int[]))',
      [postId, keep]
    );
  } else {
    await queryable.query('DELETE FROM reels WHERE source_post_id = $1', [postId]);
  }
  const linked = [];
  for (const { item, index } of videos) {
    const editData = normalizeReelEdits(item.editData || {});
    editData.sourcePostId = String(postId);
    editData.sourceMediaIndex = index;
    const result = await queryable.query(
      `INSERT INTO reels (user_id, caption, video_data, mime_type, visibility, allow_comments, edit_data, created_at, source_post_id, source_media_index)
       VALUES ($1, $2, NULL, $3, $4, TRUE, $5::jsonb, COALESCE($6::timestamptz, NOW()), $7, $8)
       ON CONFLICT (source_post_id, source_media_index) WHERE source_post_id IS NOT NULL
       DO UPDATE SET user_id = EXCLUDED.user_id, caption = EXCLUDED.caption, video_data = NULL,
                     mime_type = EXCLUDED.mime_type, visibility = EXCLUDED.visibility, edit_data = EXCLUDED.edit_data
       RETURNING id, source_media_index`,
      [userId, String(caption || '').slice(0, 500), item.mimeType || postMediaMimeType(item.data) || 'video/mp4', visibility, JSON.stringify(editData), createdAt || null, postId, index]
    );
    if (result.rows[0]) linked.push({ id: String(result.rows[0].id), mediaIndex: Number(result.rows[0].source_media_index) });
  }
  return linked;
}


function validatePostExtras(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const extras = {};

  if (source.feeling && typeof source.feeling === 'object') {
    const kind = String(source.feeling.kind || '').slice(0, 20);
    const emoji = String(source.feeling.emoji || '').slice(0, 16);
    const icon = String(source.feeling.icon || '').slice(0, 24);
    const text = String(source.feeling.text || '').trim().slice(0, 160);
    if (text) extras.feeling = { kind, emoji, icon, text };
  }

  if (source.location && typeof source.location === 'object') {
    const name = String(source.location.name || source.location.text || '').trim().slice(0, 180);
    const placeName = String(source.location.placeName || source.location.place_name || name).trim().slice(0, 300);
    const longitude = Number(source.location.longitude ?? (Array.isArray(source.location.center) ? source.location.center[0] : NaN));
    const latitude = Number(source.location.latitude ?? (Array.isArray(source.location.center) ? source.location.center[1] : NaN));
    const id = String(source.location.id || '').slice(0, 240);
    if (name && Number.isFinite(longitude) && Number.isFinite(latitude) && longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90) {
      extras.location = { id, name, placeName: placeName || name, longitude, latitude };
    }
  }

  if (source.sound && typeof source.sound === 'object') {
    const title = String(source.sound.title || source.sound.name || 'Audio').trim().slice(0, 220);
    const artist = String(source.sound.artist || '').trim().slice(0, 220);
    const data = String(source.sound.data || '');
    const mimeType = String(source.sound.mimeType || postMediaMimeType(data) || 'audio/mpeg').slice(0, 100);
    if (data) {
      if (data.length > 18 * 1024 * 1024 || !/^data:audio\/[a-z0-9.+-]+(?:;[^;]*)?;base64,[a-z0-9+/=\s]+$/i.test(data)) {
        return { error: 'Choose a valid audio file smaller than 12 MB.' };
      }
      const key = crypto.createHash('sha256').update(data).digest('hex');
      extras.sound = { name: title || 'Audio', title: title || 'Audio', artist, mimeType, data, key };
    }
  }

  const rawStickers = Array.isArray(source.stickers)
    ? source.stickers
    : (source.sticker ? [source.sticker] : []);
  if (rawStickers.length > 2) return { error: 'You can add up to 2 stickers to one post.' };
  const stickers = [];
  for (const value of rawStickers) {
    const sticker = String(value || '').trim();
    if (!sticker) continue;
    if (sticker.length > 4096) return { error: 'Choose valid stickers.' };
    try {
      const url = new URL(sticker);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || !(host === 'giphy.com' || host.endsWith('.giphy.com'))) return { error: 'Choose valid stickers.' };
    } catch (_error) {
      return { error: 'Choose valid stickers.' };
    }
    stickers.push(sticker);
  }
  if (stickers.length) extras.stickers = stickers;

  return { extras };
}

function postExtrasHasContent(extras) {
  return Boolean(extras && (extras.feeling || extras.location || extras.sound || (Array.isArray(extras.stickers) && extras.stickers.length) || extras.sticker));
}

function normalizeCommentMedia(dataValue, typeValue) {
  const data = String(dataValue || '').trim();
  const type = String(typeValue || '').trim().toLowerCase();
  if (!data && !type) return { data: '', type: '' };
  if (type === 'image') {
    if (!data || !validImageData(data)) return { error: 'Choose a valid comment photo smaller than 8 MB.' };
    return { data, type };
  }
  if (type === 'sticker') {
    if (!data || data.length > 4096) return { error: 'Choose a valid sticker.' };
    try {
      const url = new URL(data);
      const host = url.hostname.toLowerCase();
      if (url.protocol !== 'https:' || !(host === 'giphy.com' || host.endsWith('.giphy.com'))) return { error: 'Choose a valid sticker.' };
    } catch (_error) {
      return { error: 'Choose a valid sticker.' };
    }
    return { data, type };
  }
  return { error: 'Choose valid comment media.' };
}

function validNumericId(value) {
  return /^\d+$/.test(String(value || ''));
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `Process exited with code ${code}`));
    });
  });
}

function ffmpegBinary() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try { return require('ffmpeg-static'); } catch (_error) { return 'ffmpeg'; }
}


function receiveRequestToFile(request, destination, maximumBytes) {
  return new Promise((resolve, reject) => {
    let received = 0;
    let settled = false;
    const output = fs.createWriteStream(destination, { flags: 'wx' });
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { output.destroy(); } catch (_) {}
      reject(error);
    };
    output.once('error', fail);
    request.once('aborted', () => fail(new Error('Upload was cancelled.')));
    request.once('error', fail);
    request.on('data', chunk => {
      received += chunk.length;
      if (received > maximumBytes) {
        fail(Object.assign(new Error('The selected clip is too large.'), { statusCode: 413 }));
        try { request.destroy(); } catch (_) {}
      }
    });
    output.once('finish', () => {
      if (settled) return;
      settled = true;
      if (received < 1024) reject(Object.assign(new Error('No video was received.'), { statusCode: 400 }));
      else resolve(received);
    });
    request.pipe(output);
  });
}

let reverseJobQueue = Promise.resolve();
let captionJobQueue = Promise.resolve();
let captionTranscriberPromise = null;
const captionSpeechCache = new Map();
const captionSpeechVoices = new Map([
  ['sol', { edgeVoice: 'en-US-GuyNeural', streamVoice: 'Matthew' }],
  ['breeze', { edgeVoice: 'en-US-JennyNeural', streamVoice: 'Joanna' }]
]);

function splitCaptionSpeechText(text, limit = 260) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && candidate.length > limit) {
      chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function stripLeadingId3(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 10 || buffer.subarray(0, 3).toString('ascii') !== 'ID3') return buffer;
  const size = ((buffer[6] & 0x7f) << 21) | ((buffer[7] & 0x7f) << 14) |
    ((buffer[8] & 0x7f) << 7) | (buffer[9] & 0x7f);
  return buffer.subarray(Math.min(buffer.length, 10 + size));
}

async function generatePublicCaptionSpeech(text, voice) {
  const chunks = splitCaptionSpeechText(text);
  const audioParts = await Promise.all(chunks.map(async (chunk) => {
    const url = new URL('https://api.streamelements.com/kappa/v2/speech');
    url.searchParams.set('voice', voice);
    url.searchParams.set('text', chunk);
    const speechResponse = await fetch(url, {
      headers: { Accept: 'audio/mpeg', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(30000)
    });
    if (!speechResponse.ok) throw new Error(`Backup voice service returned ${speechResponse.status}.`);
    const audio = Buffer.from(await speechResponse.arrayBuffer());
    if (!audio.length) throw new Error('Backup voice service returned empty audio.');
    return audio;
  }));
  return Buffer.concat(audioParts.map((part, index) => index ? stripLeadingId3(part) : part));
}

function runReverseJobExclusively(task) {
  const queued = reverseJobQueue.then(task, task);
  reverseJobQueue = queued.catch(() => {});
  return queued;
}

function runCaptionJobExclusively(task) {
  const queued = captionJobQueue.then(task, task);
  captionJobQueue = queued.catch(() => {});
  return queued;
}

async function captionTranscriber() {
  if (!captionTranscriberPromise) {
    captionTranscriberPromise = import('@xenova/transformers').then(({ pipeline, env }) => {
      env.allowLocalModels = false;
      return pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', { quantized: true });
    }).catch(error => {
      captionTranscriberPromise = null;
      throw error;
    });
  }
  return captionTranscriberPromise;
}

function captionPhrasesFromWords(chunks, duration) {
  const words = (Array.isArray(chunks) ? chunks : []).map(chunk => {
    const timestamp = Array.isArray(chunk && chunk.timestamp) ? chunk.timestamp : [];
    return {
      text: String(chunk && chunk.text || '').trim(),
      start: Math.max(0, Number(timestamp[0]) || 0),
      end: Math.max(0, Number(timestamp[1]) || Number(timestamp[0]) || 0)
    };
  }).filter(word => word.text);
  const segments = [];
  let phrase = [];
  let phraseStart = 0;
  let phraseEnd = 0;
  const flush = () => {
    if (!phrase.length) return;
    segments.push({
      start: Math.max(0, phraseStart),
      end: Math.min(duration, Math.max(phraseStart + 0.12, phraseEnd)),
      text: phrase.join(' ').replace(/\s+([,.!?;:])/g, '$1')
    });
    phrase = [];
  };
  words.forEach(word => {
    const candidate = phrase.concat(word.text).join(' ');
    const gap = phrase.length ? word.start - phraseEnd : 0;
    if (phrase.length && (phrase.length >= 4 || candidate.length > 30 || gap > 0.65)) flush();
    if (!phrase.length) phraseStart = word.start;
    phrase.push(word.text);
    phraseEnd = Math.max(word.end, word.start + 0.12);
  });
  flush();
  return segments.filter(segment => segment.text && segment.end > segment.start).slice(0, 300);
}

async function reverseVideoInSegments(ffmpeg, inputPath, outputPath, start, duration, tempDirectory) {
  const normalizedPath = path.join(tempDirectory, 'normalized.mp4');
  const segmentsDirectory = path.join(tempDirectory, 'segments');
  const reversedDirectory = path.join(tempDirectory, 'reversed');
  await fs.promises.mkdir(segmentsDirectory, { recursive: true });
  await fs.promises.mkdir(reversedDirectory, { recursive: true });

  const normalizeArgs = ['-hide_banner', '-loglevel', 'error', '-y'];
  if (start > 0) normalizeArgs.push('-ss', String(start));
  if (duration) normalizeArgs.push('-t', String(duration));
  normalizeArgs.push(
    '-i', inputPath,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', "scale='min(540,iw)':-2:force_original_aspect_ratio=decrease,fps=20",
    '-threads', '1', '-filter_threads', '1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '29',
    '-c:a', 'aac', '-b:a', '96k', '-ar', '44100',
    '-movflags', '+faststart', normalizedPath
  );
  await runProcess(ffmpeg, normalizeArgs);

  const segmentPattern = path.join(segmentsDirectory, 'part-%05d.mp4');
  await runProcess(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', normalizedPath,
    '-map', '0', '-c', 'copy', '-f', 'segment', '-segment_time', '2',
    '-reset_timestamps', '1', segmentPattern
  ]);

  const parts = (await fs.promises.readdir(segmentsDirectory))
    .filter(name => /^part-\d+\.mp4$/.test(name)).sort();
  if (!parts.length) throw new Error('The clip could not be divided for reversing.');

  const reversedParts = [];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const sourcePart = path.join(segmentsDirectory, parts[index]);
    const reversedPart = path.join(reversedDirectory, `reverse-${String(parts.length - 1 - index).padStart(5, '0')}.mp4`);
    const withAudio = [
      '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-filter_threads', '1', '-filter_complex_threads', '1', '-i', sourcePart,
      '-filter_complex', '[0:v]reverse,setpts=PTS-STARTPTS[v];[0:a]areverse,asetpts=PTS-STARTPTS[a]',
      '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '96k', reversedPart
    ];
    try {
      await runProcess(ffmpeg, withAudio);
    } catch (_) {
      await runProcess(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-filter_threads', '1', '-i', sourcePart,
        '-vf', 'reverse,setpts=PTS-STARTPTS', '-an',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', reversedPart
      ]);
    }
    reversedParts.push(reversedPart);
  }

  const concatPath = path.join(tempDirectory, 'concat.txt');
  const concatText = reversedParts.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
  await fs.promises.writeFile(concatPath, concatText);
  try {
    await runProcess(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concatPath,
      '-c', 'copy', '-movflags', '+faststart', outputPath
    ]);
  } catch (_) {
    await runProcess(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concatPath,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '27', '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart', outputPath
    ]);
  }
}

app.post('/api/reverse-video', async (request, response) => {
  request.setTimeout(15 * 60 * 1000);
  response.setTimeout(15 * 60 * 1000);
  const start = Math.max(0, Number(request.query.start) || 0);
  const requestedDuration = Number(request.query.duration);
  const duration = Number.isFinite(requestedDuration) && requestedDuration > 0 ? Math.min(180, requestedDuration) : null;
  const job = crypto.randomBytes(12).toString('hex');
  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'reverse-'));
  const inputPath = path.join(tempDirectory, `${job}.input`);
  const outputPath = path.join(tempDirectory, `${job}.mp4`);
  try {
    await receiveRequestToFile(request, inputPath, 350 * 1024 * 1024);
    await runReverseJobExclusively(() => reverseVideoInSegments(ffmpegBinary(), inputPath, outputPath, start, duration, tempDirectory));
    const stats = await fs.promises.stat(outputPath);
    if (!stats.size) throw new Error('The reversed clip is empty.');
    response.setHeader('Content-Type', 'video/mp4');
    response.setHeader('Content-Length', String(stats.size));
    response.setHeader('Cache-Control', 'no-store');
    const stream = fs.createReadStream(outputPath);
    stream.once('error', error => {
      console.error('Reverse result stream failed:', error);
      if (!response.headersSent) response.status(500).json({ error: 'The reversed clip could not be downloaded.' });
      else response.destroy(error);
    });
    stream.pipe(response);
    response.once('finish', () => fs.promises.rm(tempDirectory, { recursive: true, force: true }).catch(() => {}));
    response.once('close', () => fs.promises.rm(tempDirectory, { recursive: true, force: true }).catch(() => {}));
  } catch (error) {
    console.error('Reverse video failed:', error);
    const status = Number(error && error.statusCode) || 500;
    if (!response.headersSent) response.status(status).json({ error: error && error.message ? error.message : 'The server could not reverse this clip.' });
    fs.promises.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
});

app.post('/api/generate-captions', async (request, response) => {
  request.setTimeout(15 * 60 * 1000);
  response.setTimeout(15 * 60 * 1000);
  const start = Math.max(0, Number(request.query.start) || 0);
  const requestedDuration = Number(request.query.duration);
  const duration = Number.isFinite(requestedDuration) && requestedDuration > 0 ? Math.min(600, requestedDuration) : 600;
  const job = crypto.randomBytes(12).toString('hex');
  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'captions-'));
  const inputPath = path.join(tempDirectory, `${job}.input`);
  const audioPath = path.join(tempDirectory, `${job}.f32le`);
  try {
    await receiveRequestToFile(request, inputPath, 350 * 1024 * 1024);
    const result = await runCaptionJobExclusively(async () => {
      await runProcess(ffmpegBinary(), [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', String(start), '-t', String(duration), '-i', inputPath,
        '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', audioPath
      ]);
      const audioBuffer = await fs.promises.readFile(audioPath);
      if (audioBuffer.length < 6400) throw Object.assign(new Error('No speech audio was found in this clip.'), { statusCode: 400 });
      const sampleBytes = audioBuffer.buffer.slice(
        audioBuffer.byteOffset,
        audioBuffer.byteOffset + audioBuffer.byteLength
      );
      const samples = new Float32Array(sampleBytes);
      const transcriber = await captionTranscriber();
      return transcriber(samples, {
        task: 'transcribe',
        return_timestamps: 'word',
        chunk_length_s: 30,
        stride_length_s: 5
      });
    });
    const text = String(result && result.text || '').replace(/\s+/g, ' ').trim();
    const segments = captionPhrasesFromWords(result && result.chunks, duration);
    if (!text || !segments.length) throw Object.assign(new Error('No speech could be detected in this clip.'), { statusCode: 422 });
    response.setHeader('Cache-Control', 'no-store');
    response.json({ text: text.slice(0, 4000), segments });
  } catch (error) {
    console.error('Caption generation failed:', error);
    const status = Number(error && error.statusCode) || 500;
    if (!response.headersSent) response.status(status).json({
      error: status === 500 ? 'Captions could not be generated. Please try again.' : error.message
    });
  } finally {
    fs.promises.rm(tempDirectory, { recursive: true, force: true }).catch(() => {});
  }
});

app.post('/api/generate-caption-speech', async (request, response) => {
  const text = String(request.body?.text || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
  const presetId = String(request.body?.voice || '');
  const preset = captionSpeechVoices.get(presetId);
  if (!text) return response.status(400).json({ error: 'Caption text is required.' });
  if (!preset) return response.status(400).json({ error: 'Choose a valid caption voice.' });

  const cacheKey = crypto.createHash('sha256').update(`distinct-neural-v3\n${presetId}\n${text}`).digest('hex');
  const cached = captionSpeechCache.get(cacheKey);
  if (cached) {
    response.setHeader('Cache-Control', 'private, max-age=86400');
    response.type('audio/mpeg').send(cached);
    return;
  }

  try {
    let audio;
    try {
      audio = await generatePublicCaptionSpeech(text, preset.streamVoice);
    } catch (publicVoiceError) {
      console.warn('Primary caption voice unavailable; trying the secondary neural service.', publicVoiceError?.message || publicVoiceError);
      const edgeTts = await import('@bestcodes/edge-tts/dist/index.mjs');
      audio = Buffer.from(await edgeTts.generateSpeech({
        text,
        voice: preset.edgeVoice,
        volume: '+0%',
        rate: '+0%',
        pitch: '+0Hz'
      }));
    }
    if (!audio.length) throw new Error('The AI voice service returned empty audio.');
    captionSpeechCache.set(cacheKey, audio);
    if (captionSpeechCache.size > 120) captionSpeechCache.delete(captionSpeechCache.keys().next().value);
    response.setHeader('Cache-Control', 'private, max-age=86400');
    response.type('audio/mpeg').send(audio);
  } catch (error) {
    console.error('Caption speech generation failed:', error);
    const status = Number(error?.statusCode) || 502;
    response.status(status).json({
      error: error?.message || 'The AI voice service could not generate speech.'
    });
  }
});

function normalizeReelEdits(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const number = (input, minimum, maximum, fallback) => {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
  };
  const effects = new Set([
    'none','enhance','portrait','soft','vivid','pop','warm','golden','sunset','cool','arctic','teal','emerald','rose','lavender',
    'cinematic','blockbuster','film','vintage','matte','fade','dream','sepia','mono','noir','silvertone','washed','dramatic',
    'lowlight','midnight','neon','cyber','electric','infrared','negative','haze'
  ]);
  const visualEffects = new Set([
    'none','pixelate','posterize','edge-glow','thermal','mirror',
    'split-screen','kaleidoscope','fisheye','ripple','wave','zoom-pulse','shake','strobe','ghost','tunnel',
    'vignette','bokeh-blur','lens-flare','motion-blur','dynamic-distort','prism',
    'color-trails','echo-zoom','radial-blur','swirl','stretch','flash-zoom','dream-glow',
    'mini-zoom','zoom-lens','blur','shaky-camera-move','delay','astral','shake-1','neon-dynamic','bounce-camera',
    'trembling','black-flash','shake-dynamic','soul','disco-count','lyric-cut','quick-speed',
    'energy','moon-off','shockwave','somethings-wrong','small-body-big-head','black-glasses','halo',
    'facial-fisheye','laser-eyes','shy','feeling-hurt','face-mosaic'
  ]);
  const normalizeClip = (clip, index) => {
    clip = clip && typeof clip === 'object' ? clip : {};
    const start = number(clip.sourceStart, 0, 3600, 0);
    const end = number(clip.sourceEnd, start + 0.05, 3600, start + 0.05);
    return {
      id: String(clip.id || `clip-${index + 1}`).slice(0, 80),
      sourceStart: start,
      sourceEnd: end,
      availableStart: number(clip.availableStart, 0, 3600, 0),
      availableEnd: number(clip.availableEnd, end, 3600, end),
      mediaType: clip.mediaType === 'image' || clip.kind === 'image' ? 'image' : 'video',
      kind: clip.mediaType === 'image' || clip.kind === 'image' ? 'image' : 'video',
      speed: number(clip.speed, 0.25, 4, 1),
      brightness: number(clip.brightness, 0.5, 1.5, 1),
      contrast: number(clip.contrast, 0.5, 1.5, 1),
      saturation: number(clip.saturation, 0, 2, 1),
      effect: effects.has(clip.effect) ? clip.effect : 'none',
      visualEffect: visualEffects.has(clip.visualEffect) ? clip.visualEffect : 'none',
      visualEffectStart: number(clip.visualEffectStart, 0, 1, 0),
      visualEffectEnd: number(clip.visualEffectEnd, 0.01, 1, 1),
      text: String(clip.text || '').slice(0, 100),
      textOverlays: Array.isArray(clip.textOverlays) ? clip.textOverlays.slice(0, 20).map((item, textIndex) => ({
        id: String(item?.id || `reel-text-${textIndex + 1}`).slice(0, 80),
        text: String(item?.text || '').slice(0, 100),
        textFont: String(item?.textFont || 'classic').slice(0, 40),
        textColor: /^#[0-9a-f]{6}$/i.test(String(item?.textColor || '')) ? String(item.textColor) : '#ffffff',
        textStyle: String(item?.textStyle || 'classic').slice(0, 40),
        textAlign: ['left','center','right'].includes(item?.textAlign) ? item.textAlign : 'center',
        textAnimation: String(item?.textAnimation || 'none').slice(0, 40),
        textPositionX: number(item?.textPositionX, 0.05, 0.95, 0.5),
        textPositionY: number(item?.textPositionY, 0.05, 0.95, 0.48),
        textScale: number(item?.textScale, 0.35, 4, 1),
        textOpacity: number(item?.textOpacity, 0, 1, 1),
        textToSpeech: Boolean(item?.textToSpeech)
      })).filter(item => item.text) : [],
      sticker: String(clip.sticker || '').slice(0, 8),
      captions: Boolean(clip.captions),
      captionText: String(clip.captionText || '').slice(0, 4000),
      captionStyle: ['classic','boxed','karaoke','bubble','impact','minimal','retro','subtitle'].includes(clip.captionStyle) ? clip.captionStyle : 'classic',
      captionOpacity: number(clip.captionOpacity, 0, 1, 1),
      captionPositionX: number(clip.captionPositionX, 0.1, 0.9, 0.5),
      captionPositionY: number(clip.captionPositionY, 0.08, 0.92, 0.86),
      captionVoicePreset: captionSpeechVoices.has(clip.captionVoicePreset) ? clip.captionVoicePreset : '',
      captionUseTextStyle: Boolean(clip.captionUseTextStyle),
      captionFont: String(clip.captionFont || 'classic').slice(0, 40),
      captionColor: /^#[0-9a-f]{6}$/i.test(String(clip.captionColor || '')) ? String(clip.captionColor) : '#ffffff',
      captionTextStyle: String(clip.captionTextStyle || 'classic').slice(0, 40),
      captionAlign: ['left','center','right'].includes(clip.captionAlign) ? clip.captionAlign : 'center',
      captionAnimation: String(clip.captionAnimation || 'none').slice(0, 40),
      captionSegments: Array.isArray(clip.captionSegments) ? clip.captionSegments.slice(0, 300).map(segment => ({
        start: number(segment?.start, 0, 3600, 0),
        end: number(segment?.end, 0.05, 3600, 0.05),
        text: String(segment?.text || '').slice(0, 240)
      })).filter(segment => segment.text && segment.end > segment.start) : [],
      overlay: Boolean(clip.overlay),
      fit: clip.fit === 'cover' ? 'cover' : 'contain'
    };
  };
  const clips = Array.isArray(source.clips) ? source.clips.slice(0, 100).map(normalizeClip) : [];
  const clipIds = new Set(clips.map(clip => clip.id));
  const transitions = Array.isArray(source.transitions) ? source.transitions.slice(0, 99).map(item => ({
    fromId: String(item?.fromId || '').slice(0, 80),
    toId: String(item?.toId || '').slice(0, 80),
    type: ['none','fade','dissolve','wipe','slide'].includes(item?.type) ? item.type : 'none',
    duration: number(item?.duration, 0, 1, 0)
  })).filter(item => clipIds.has(item.fromId) && clipIds.has(item.toId)) : [];
  return {
    trimStart: number(source.trimStart, 0, 3600, 0),
    trimEnd: number(source.trimEnd, 0, 3600, 0),
    brightness: number(source.brightness, 0.5, 1.5, 1),
    contrast: number(source.contrast, 0.5, 1.5, 1),
    saturation: number(source.saturation, 0, 2, 1),
    effect: effects.has(source.effect) ? source.effect : 'none',
    visualEffect: visualEffects.has(source.visualEffect) ? source.visualEffect : 'none',
    text: String(source.text || '').slice(0, 100),
    sticker: String(source.sticker || '').slice(0, 8),
    captions: Boolean(source.captions),
    captionText: String(source.captionText || '').slice(0, 4000),
    captionStyle: ['classic','boxed','karaoke','bubble','impact','minimal','retro','subtitle'].includes(source.captionStyle) ? source.captionStyle : 'classic',
    captionOpacity: number(source.captionOpacity, 0, 1, 1),
    captionPositionX: number(source.captionPositionX, 0.1, 0.9, 0.5),
    captionPositionY: number(source.captionPositionY, 0.08, 0.92, 0.86),
    captionVoicePreset: captionSpeechVoices.has(source.captionVoicePreset) ? source.captionVoicePreset : '',
    captionUseTextStyle: Boolean(source.captionUseTextStyle),
    captionFont: String(source.captionFont || 'classic').slice(0, 40),
    captionColor: /^#[0-9a-f]{6}$/i.test(String(source.captionColor || '')) ? String(source.captionColor) : '#ffffff',
    captionTextStyle: String(source.captionTextStyle || 'classic').slice(0, 40),
    captionAlign: ['left','center','right'].includes(source.captionAlign) ? source.captionAlign : 'center',
    captionAnimation: String(source.captionAnimation || 'none').slice(0, 40),
    captionSegments: Array.isArray(source.captionSegments) ? source.captionSegments.slice(0, 300).map(segment => ({
      start: number(segment?.start, 0, 3600, 0),
      end: number(segment?.end, 0.05, 3600, 0.05),
      text: String(segment?.text || '').slice(0, 240)
    })).filter(segment => segment.text && segment.end > segment.start) : [],
    overlay: Boolean(source.overlay),
    fit: source.fit === 'cover' ? 'cover' : 'contain',
    mediaType: source.mediaType === 'image' || source.kind === 'image' ? 'image' : 'video',
    kind: source.mediaType === 'image' || source.kind === 'image' ? 'image' : 'video',
    clips,
    transitions,
    rendered: Boolean(source.rendered),
    renderedDuration: number(source.renderedDuration, 0, 3600, 0),
    previewPoster: /^data:image\/(?:jpeg|png|webp);base64,/i.test(String(source.previewPoster || ''))
      ? String(source.previewPoster).slice(0, 350000)
      : ''
  };
}

function validProfileFrame(name, svg) {
  if (name !== undefined && name !== null && (typeof name !== 'string' || name.length > 120)) return false;
  if (svg === undefined || svg === null || svg === '') return true;
  return typeof svg === 'string'
    && svg.length <= 30000
    && /^\s*<svg(?:\s|>)/i.test(svg)
    && !/<script|javascript:|on\w+\s*=/i.test(svg);
}

const loginAttempts = new Map();
function loginAttemptKey(request, identifier) {
  return `${String(request.ip || 'unknown')}|${normalizeIdentifier(identifier) || 'empty'}`;
}
function loginAllowed(key) {
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    if (current) loginAttempts.delete(key);
    return true;
  }
  return current.count < 10;
}
function recordLoginFailure(key) {
  const now = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return;
  }
  current.count += 1;
}
function clearLoginFailures(key) {
  loginAttempts.delete(key);
}

app.get('/api/health', async (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (!pool) return response.status(503).json({ ok: false, database: 'not-configured', authentication: 'unavailable' });
  try {
    await withTimeout(pool.query('SELECT 1'), 8000, 'Database health check timed out.');
    response.json({
      ok: true,
      database: 'connected',
      authentication: authDatabaseReady ? 'ready' : 'initializing',
      application: databaseReady ? 'ready' : 'initializing'
    });
  } catch (error) {
    console.error('Aiven health check failed:', error.message);
    response.status(503).json({ ok: false, database: 'unavailable', authentication: 'unavailable' });
  }
});

app.post('/api/register', async (request, response) => {
  const fullName = String(request.body?.fullName || '').trim();
  const identifier = normalizeIdentifier(request.body?.identifier);
  const password = String(request.body?.password || '');
  if (fullName.length < 2 || fullName.length > 120) return response.status(400).json({ error: 'Enter your full name.' });
  if (identifier.length < 5 || identifier.length > 255) return response.status(400).json({ error: 'Enter a valid mobile number or email.' });
  if (password.length < 6 || password.length > 200) return response.status(400).json({ error: 'Password must contain at least 6 characters.' });
  try {
    const user = await createUserAccount(fullName, identifier, password);
    const sessionId = crypto.randomUUID();
    setSessionCookie(response, user, sessionId);
    recordAccountLoginSession(request, user.id, sessionId).catch(error => console.error('Session history record failed:', error.message));
    response.status(201).json({ ok: true, redirect: '/app' });
  } catch (error) {
    if (error.code === '23505') return response.status(409).json({ error: 'An account already exists for this mobile number or email.' });
    console.error('Registration failed:', error.message);
    response.status(500).json({ error: 'Could not create the account. Try again.' });
  }
});

app.post('/api/login', async (request, response) => {
  const identifier = normalizeIdentifier(request.body?.identifier);
  const password = String(request.body?.password || '');
  if (!identifier || !password) return response.status(400).json({ error: 'Enter your mobile number or email and password.' });
  const attemptKey = loginAttemptKey(request, identifier);
  if (!loginAllowed(attemptKey)) return response.status(429).json({ error: 'Too many failed attempts for this account. Try again later.' });
  try {
    const user = await withTimeout(
      authenticateUser(identifier, password),
      18000,
      'Login took too long while connecting to the account database.'
    );
    if (!user) {
      recordLoginFailure(attemptKey);
      return response.status(401).json({ error: 'The login details you entered are incorrect.' });
    }
    const failedAttempts = Number(loginAttempts.get(attemptKey)?.count || 0);
    clearLoginFailures(attemptKey);
    const sessionId = crypto.randomUUID();
    setSessionCookie(response, user, sessionId);
    recordAccountLoginSession(request, user.id, sessionId, { failedAttempts }).catch(error => console.error('Session history record failed:', error.message));
    response.json({ ok: true, redirect: '/app' });
  } catch (error) {
    console.error('Login failed:', error.message);
    if (error.code === 'ACCOUNT_SUSPENDED') {
      const period = error.suspendedUntil
        ? `until ${new Date(error.suspendedUntil).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Hebron' })}`
        : 'Permanent';
      return response.status(403).json({ error: `Your account has been suspended. Suspension period: ${period}.`, suspended: true, suspendedUntil: error.suspendedUntil });
    }
    const timedOut = error.code === 'REQUEST_TIMEOUT';
    response.status(503).json({
      error: timedOut
        ? 'The account database did not respond in time. Wait a moment and try again.'
        : 'Login is unavailable because the account database could not be prepared.'
    });
  }
});

function loginPageError(response, message, screen = 'login') {
  const query = new URLSearchParams({ error: message, screen }).toString();
  return response.redirect(303, `/?${query}#${screen === 'signup' ? 'create-account' : 'login'}`);
}

app.post('/login', async (request, response) => {
  const identifier = normalizeIdentifier(request.body?.identifier);
  const password = String(request.body?.password || '');
  if (!identifier || !password) return loginPageError(response, 'Enter your mobile number or email and password.');
  const attemptKey = loginAttemptKey(request, identifier);
  if (!loginAllowed(attemptKey)) return loginPageError(response, 'Too many failed attempts for this account. Try again later.');
  try {
    const user = await withTimeout(
      authenticateUser(identifier, password),
      18000,
      'Login took too long while connecting to the account database.'
    );
    if (!user) {
      recordLoginFailure(attemptKey);
      return loginPageError(response, 'The login details you entered are incorrect.');
    }
    const failedAttempts = Number(loginAttempts.get(attemptKey)?.count || 0);
    clearLoginFailures(attemptKey);
    const sessionId = crypto.randomUUID();
    setSessionCookie(response, user, sessionId);
    recordAccountLoginSession(request, user.id, sessionId, { failedAttempts }).catch(error => console.error('Session history record failed:', error.message));
    return response.redirect(303, '/app');
  } catch (error) {
    console.error('Browser login failed:', error.message);
    if (error.code === 'ACCOUNT_SUSPENDED') {
      const period = error.suspendedUntil
        ? `until ${new Date(error.suspendedUntil).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Hebron' })}`
        : 'Permanent';
      return loginPageError(response, `Your account has been suspended. Suspension period: ${period}.`);
    }
    return loginPageError(
      response,
      error.code === 'REQUEST_TIMEOUT'
        ? 'The account database did not respond in time. Wait a moment and try again.'
        : 'Login is unavailable because the account database could not be prepared.'
    );
  }
});

app.post('/register', async (request, response) => {
  const fullName = String(request.body?.fullName || '').trim();
  const identifier = normalizeIdentifier(request.body?.identifier);
  const password = String(request.body?.password || '');
  if (fullName.length < 2 || fullName.length > 120) return loginPageError(response, 'Enter your full name.', 'signup');
  if (identifier.length < 5 || identifier.length > 255) return loginPageError(response, 'Enter a valid mobile number or email.', 'signup');
  if (password.length < 6 || password.length > 200) return loginPageError(response, 'Password must contain at least 6 characters.', 'signup');
  try {
    const user = await createUserAccount(fullName, identifier, password);
    const sessionId = crypto.randomUUID();
    setSessionCookie(response, user, sessionId);
    recordAccountLoginSession(request, user.id, sessionId).catch(error => console.error('Session history record failed:', error.message));
    return response.redirect(303, '/app');
  } catch (error) {
    if (error.code === '23505') return loginPageError(response, 'An account already exists for this mobile number or email.', 'signup');
    console.error('Browser registration failed:', error.message);
    return loginPageError(response, 'Could not create the account. Try again.', 'signup');
  }
});

app.post('/api/logout', async (request, response) => {
  const session = readSession(request);
  if (session?.sid && pool) {
    request.user = session;
    try { await pool.query('UPDATE account_login_sessions SET ended_at = NOW(), last_active_at = NOW() WHERE user_id = $1 AND session_key = $2', [session.id, accountSessionKey(request)]); }
    catch (error) { console.error('Session sign-out record failed:', error.message); }
  }
  response.setHeader('Set-Cookie', 'facebook_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  response.json({ ok: true });
});

app.get('/api/me', (request, response) => {
  const session = readSession(request);
  if (!session) return response.status(401).json({ authenticated: false });
  response.json({ authenticated: true, user: { id: session.id, name: session.name } });
});

async function verifyCurrentAccountPassword(userId, password) {
  const legacySelect = legacyPasswordColumn ? `, ${quotedColumn(legacyPasswordColumn)}::text AS legacy_password` : ', NULL::text AS legacy_password';
  const result = await pool.query(`SELECT password_hash${legacySelect} FROM users WHERE id = $1 LIMIT 1`, [userId]);
  const user = result.rows[0];
  if (!user) return false;
  return (await (user.password_hash === request.body.password)) || (user.legacy_password && await (user.password_hash === request.body.password));
}

app.get('/api/account-settings', requireApiAuth, async (request, response) => {
  try {
    await ensureDatabase();
    const result = await pool.query(
      `SELECT id, full_name, identifier, email, phone, username, account_private, login_alerts, created_at, name_changed_at
       FROM users WHERE id = $1 LIMIT 1`, [request.user.id]
    );
    const user = result.rows[0];
    if (!user) return response.status(404).json({ error: 'Account not found.' });
    response.set('Cache-Control', 'private, no-store');
    response.json({
      isWebsiteOwner: Number(user.id) === 1,
      displayName: user.full_name || '',
      email: user.email || (String(user.identifier || '').includes('@') ? user.identifier : ''),
      phone: user.phone || (!String(user.identifier || '').includes('@') ? user.identifier : ''),
      username: user.username || '',
      accountPrivate: Boolean(user.account_private),
      loginAlerts: user.login_alerts !== false,
      passwordHash: user.password_hash || "", joinedAt: user.created_at,
      nameChangedAt: user.name_changed_at,
      canChangeNameAt: user.name_changed_at ? new Date(new Date(user.name_changed_at).getTime() + 24 * 60 * 60 * 1000).toISOString() : null
    });
  } catch (error) {
    console.error('Account settings load failed:', error.message);
    response.status(500).json({ error: 'Could not load account settings.' });
  }
});

app.get('/api/admin/users', requireApiAuth, requireOwnerApi, async (_request, response) => {
  try {
    await ensureDatabase();
    const result = await pool.query(
      `SELECT u.id, u.full_name, u.identifier, u.email, u.phone, u.username, u.account_private, u.last_seen_at,
              (u.last_seen_at >= NOW() - INTERVAL '2 minutes') AS is_online,
              u.deactivated_at, u.admin_suspended_at, u.admin_suspended_until, u.created_at, COUNT(s.id)::int AS session_count, MAX(s.last_active_at) AS last_active_at
       FROM users u LEFT JOIN account_login_sessions s ON s.user_id = u.id
       GROUP BY u.id ORDER BY u.id ASC`
    );
    response.set('Cache-Control', 'private, no-store');
    response.json({ users: result.rows.map(user => ({
      id: user.id, displayName: user.full_name || '', identifier: user.identifier || '', email: user.email || '',
      phone: user.phone || '', username: user.username || '', accountPrivate: Boolean(user.account_private),
      deactivatedAt: user.deactivated_at, suspendedAt: user.admin_suspended_at, suspendedUntil: user.admin_suspended_until, joinedAt: user.created_at, sessionCount: user.session_count,
      lastActiveAt: user.last_active_at, lastSeenAt: user.last_seen_at, isOnline: Boolean(user.is_online), isOwner: Number(user.id) === 1
    })) });
  } catch (error) {
    console.error('Owner user list failed:', error.message);
    response.status(500).json({ error: 'Could not load users.' });
  }
});

app.get('/api/admin/users/:userId', requireApiAuth, requireOwnerApi, async (request, response) => {
  const userId = Number(request.params.userId);
  if (!Number.isInteger(userId) || userId < 1) return response.status(400).json({ error: 'Invalid user.' });
  try {
    await ensureDatabase();
    const [userResult, sessionsResult] = await Promise.all([
      pool.query(`SELECT id, full_name, identifier, password_hash, email, phone, username, account_private, login_alerts,
                         deactivated_at, admin_suspended_at, admin_suspended_until, created_at, name_changed_at
                  FROM users WHERE id = $1 LIMIT 1`, [userId]),
      pool.query(`SELECT session_key, user_agent, device_model, platform_name, platform_version, ip_address,
                         location, device_details, login_method, failed_attempts_before_login,
                         created_at, last_active_at, ended_at
                  FROM account_login_sessions WHERE user_id = $1 ORDER BY last_active_at DESC`, [userId])
    ]);
    const user = userResult.rows[0];
    if (!user) return response.status(404).json({ error: 'User not found.' });
    response.set('Cache-Control', 'private, no-store');
    response.json({
      user: { id: user.id, displayName: user.full_name || '', identifier: user.identifier || '', email: user.email || '', phone: user.phone || '', username: user.username || '', passwordHash: user.password_hash || '', accountPrivate: Boolean(user.account_private), loginAlerts: user.login_alerts !== false, deactivatedAt: user.deactivated_at, suspendedAt: user.admin_suspended_at, suspendedUntil: user.admin_suspended_until, joinedAt: user.created_at, nameChangedAt: user.name_changed_at, isOwner: Number(user.id) === 1 },
      sessions: sessionsResult.rows.map(session => ({ sessionKey: session.session_key, userAgent: session.user_agent || '', deviceModel: session.device_model || '', platformName: session.platform_name || '', platformVersion: session.platform_version || '', ip: session.ip_address || '', location: session.location || '', deviceDetails: session.device_details || {}, loginMethod: session.login_method || 'Password', failedAttemptsBeforeLogin: Number(session.failed_attempts_before_login || 0), signedInAt: session.created_at, lastActiveAt: session.last_active_at, signedOutAt: session.ended_at }))
    });
  } catch (error) {
    console.error('Owner user details failed:', error.message);
    response.status(500).json({ error: 'Could not load user details.' });
  }
});

app.delete('/api/admin/users/:userId/sessions/:sessionKey', requireApiAuth, requireOwnerApi, async (request, response) => {
  const userId = Number(request.params.userId);
  const sessionKey = String(request.params.sessionKey || '').trim().slice(0, 96);
  if (!Number.isInteger(userId) || userId < 1 || !sessionKey) return response.status(400).json({ error: 'Invalid session.' });
  try {
    await ensureDatabase();
    const existing = await pool.query('SELECT session_key FROM account_login_sessions WHERE user_id = $1 AND session_key = $2 LIMIT 1', [userId, sessionKey]);
    if (!existing.rowCount) return response.status(404).json({ error: 'Session was not found.' });
    await pool.query('INSERT INTO revoked_account_sessions (user_id, session_key) VALUES ($1,$2) ON CONFLICT (user_id, session_key) DO UPDATE SET revoked_at = NOW()', [userId, sessionKey]);
    await pool.query('DELETE FROM account_login_sessions WHERE user_id = $1 AND session_key = $2', [userId, sessionKey]);
    await recordAdminAudit(request, userId, 'session_deleted', { sessionKey });
    const loggedOut = userId === Number(request.user.id) && sessionKey === accountSessionKey(request, request.user.sid);
    if (loggedOut) response.setHeader('Set-Cookie', 'facebook_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    response.json({ success: true, loggedOut });
  } catch (error) {
    console.error('Owner session deletion failed:', error.message);
    response.status(500).json({ error: 'Could not delete the session.' });
  }
});

app.put('/api/admin/users/:userId/password', requireApiAuth, requireOwnerApi, async (request, response) => {
  const userId = Number(request.params.userId);
  const newPassword = String(request.body?.newPassword || '');
  if (!Number.isInteger(userId) || userId < 1) return response.status(400).json({ error: 'Invalid user.' });
  if (newPassword.length < 8 || newPassword.length > 200 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) return response.status(400).json({ error: 'Use at least 8 characters with a letter and number.' });
  try {
    await ensureDatabase();
    const result = await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING id', [await request.body.password, userId]);
    if (!result.rowCount) return response.status(404).json({ error: 'User not found.' });
    await pool.query('UPDATE account_login_sessions SET ended_at = NOW() WHERE user_id = $1 AND ended_at IS NULL', [userId]);
    await pool.query('UPDATE users SET sessions_revoked_at = NOW() WHERE id = $1', [userId]);
    await recordAdminAudit(request, userId, 'password_reset');
    response.json({ success: true });
  } catch (error) {
    console.error('Owner password reset failed:', error.message);
    response.status(500).json({ error: 'Could not reset the password.' });
  }
});

app.delete('/api/admin/users/:userId', requireApiAuth, requireOwnerApi, async (request, response) => {
  const userId = Number(request.params.userId);
  if (!Number.isInteger(userId) || userId < 1) return response.status(400).json({ error: 'Invalid user.' });
  if (userId === 1) return response.status(400).json({ error: 'The website owner account cannot be deleted.' });
  try {
    await ensureDatabase();
    await recordAdminAudit(request, userId, 'account_deleted');
    const result = await pool.query('DELETE FROM users WHERE id = $1 RETURNING id', [userId]);
    if (!result.rowCount) return response.status(404).json({ error: 'User not found.' });
    response.json({ success: true });
  } catch (error) {
    console.error('Owner account deletion failed:', error.message);
    response.status(500).json({ error: 'Could not delete the account.' });
  }
});

app.post('/api/admin/users/:userId/suspension', requireApiAuth, requireOwnerApi, async (request, response) => {
  const userId = Number(request.params.userId);
  const suspended = Boolean(request.body?.suspended);
  const requestedUntil = request.body?.suspendedUntil ? new Date(request.body.suspendedUntil) : null;
  if (!Number.isInteger(userId) || userId < 2) return response.status(400).json({ error: 'The website owner cannot be suspended.' });
  if (suspended && requestedUntil && (!Number.isFinite(requestedUntil.getTime()) || requestedUntil.getTime() <= Date.now() || requestedUntil.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000)) return response.status(400).json({ error: 'Choose a future suspension period of up to one year.' });
  try {
    await ensureDatabase();
    const result = await pool.query(`UPDATE users SET admin_suspended_at = ${suspended ? 'NOW()' : 'NULL'}, admin_suspended_until = CASE WHEN $2 THEN $3::timestamptz ELSE NULL END, sessions_revoked_at = CASE WHEN $2 THEN NOW() ELSE sessions_revoked_at END WHERE id = $1 RETURNING id, admin_suspended_until`, [userId, suspended, requestedUntil ? requestedUntil.toISOString() : null]);
    if (!result.rowCount) return response.status(404).json({ error: 'User not found.' });
    if (suspended) await pool.query('UPDATE account_login_sessions SET ended_at = NOW() WHERE user_id = $1 AND ended_at IS NULL', [userId]);
    await recordAdminAudit(request, userId, suspended ? 'account_suspended' : 'account_reactivated', { suspendedUntil: result.rows[0].admin_suspended_until });
    response.json({ success: true, suspended, suspendedUntil: result.rows[0].admin_suspended_until });
  } catch (error) { console.error('Owner suspension update failed:', error.message); response.status(500).json({ error: 'Could not update account access.' }); }
});

app.post('/api/admin/users/:userId/revoke-sessions', requireApiAuth, requireOwnerApi, async (request, response) => {
  const userId = Number(request.params.userId);
  if (!Number.isInteger(userId) || userId < 2) return response.status(400).json({ error: 'The owner session cannot be revoked here.' });
  try {
    await ensureDatabase();
    const result = await pool.query('UPDATE users SET sessions_revoked_at = NOW() WHERE id = $1 RETURNING id', [userId]);
    if (!result.rowCount) return response.status(404).json({ error: 'User not found.' });
    await pool.query('UPDATE account_login_sessions SET ended_at = NOW() WHERE user_id = $1 AND ended_at IS NULL', [userId]);
    await recordAdminAudit(request, userId, 'sessions_revoked');
    response.json({ success: true });
  } catch (error) { console.error('Owner session revoke failed:', error.message); response.status(500).json({ error: 'Could not sign out this user.' }); }
});

app.post('/api/admin/users/:userId/deactivation', requireApiAuth, requireOwnerApi, async (request, response) => {
  const userId = Number(request.params.userId);
  const deactivated = Boolean(request.body?.deactivated);
  if (!Number.isInteger(userId) || userId < 2) return response.status(400).json({ error: 'The website owner cannot be deactivated.' });
  try {
    await ensureDatabase();
    const result = await pool.query(`UPDATE users SET deactivated_at = ${deactivated ? 'NOW()' : 'NULL'}, sessions_revoked_at = CASE WHEN $2 THEN NOW() ELSE sessions_revoked_at END WHERE id = $1 RETURNING id`, [userId, deactivated]);
    if (!result.rowCount) return response.status(404).json({ error: 'User not found.' });
    if (deactivated) await pool.query('UPDATE account_login_sessions SET ended_at = NOW() WHERE user_id = $1 AND ended_at IS NULL', [userId]);
    await recordAdminAudit(request, userId, deactivated ? 'account_deactivated' : 'account_reactivated');
    response.json({ success: true, deactivated });
  } catch (error) { console.error('Owner deactivation update failed:', error.message); response.status(500).json({ error: 'Could not update account status.' }); }
});

app.get('/api/admin/audit-log', requireApiAuth, requireOwnerApi, async (_request, response) => {
  try {
    await ensureDatabase();
    const result = await pool.query('SELECT id, admin_user_id, target_user_id, action, details, ip_address, created_at FROM admin_audit_log ORDER BY created_at DESC LIMIT 100');
    response.set('Cache-Control', 'private, no-store');
    response.json({ events: result.rows });
  } catch (error) { console.error('Owner audit log failed:', error.message); response.status(500).json({ error: 'Could not load the audit log.' }); }
});

app.delete('/api/admin/audit-log', requireApiAuth, requireOwnerApi, async (_request, response) => {
  try {
    await ensureDatabase();
    const result = await pool.query('DELETE FROM admin_audit_log');
    response.json({ success: true, cleared: result.rowCount || 0 });
  } catch (error) {
    console.error('Owner audit log clear failed:', error.message);
    response.status(500).json({ error: 'Could not clear the audit log.' });
  }
});

app.get('/api/admin/users/:userId/activity', requireApiAuth, requireOwnerApi, async (request, response) => {
  const userId = Number(request.params.userId);
  if (!Number.isInteger(userId) || userId < 1) return response.status(400).json({ error: 'Invalid user.' });
  try {
    await ensureDatabase();
    const exists = await pool.query('SELECT id FROM users WHERE id = $1 LIMIT 1', [userId]);
    if (!exists.rowCount) return response.status(404).json({ error: 'User not found.' });
    const [posts, comments, likes, stories, reels, deleted] = await Promise.all([
      pool.query(`SELECT p.id, p.body, p.image_data, p.media_items, p.post_extras, p.visibility, p.created_at,
        (SELECT COUNT(*)::int FROM post_likes pl WHERE pl.post_id=p.id) AS like_count,
        (SELECT COUNT(*)::int FROM post_comments pc WHERE pc.post_id=p.id) AS comment_count
        FROM posts p WHERE p.user_id=$1 ORDER BY p.created_at DESC`, [userId]),
      pool.query(`SELECT 'Post comment' AS type, pc.id, pc.post_id::text AS content_id, pc.body, pc.media_data, pc.media_type, pc.created_at,
          jsonb_build_object('kind','post','id',p.id,'body',p.body,'image_data',p.image_data,'media_items',p.media_items,'post_extras',p.post_extras) AS content
        FROM post_comments pc JOIN posts p ON p.id=pc.post_id WHERE pc.user_id=$1
        UNION ALL SELECT 'Media comment', pmc.id, (pmc.post_id::text || ':' || pmc.media_index::text), pmc.body, pmc.media_data, pmc.media_type, pmc.created_at,
          jsonb_build_object('kind','post','id',p.id,'body',p.body,'image_data',p.image_data,'media_items',p.media_items,'post_extras',p.post_extras,'media_index',pmc.media_index)
        FROM post_media_comments pmc JOIN posts p ON p.id=pmc.post_id WHERE pmc.user_id=$1
        UNION ALL SELECT 'Reel comment', rc.id, rc.reel_id::text, rc.body, rc.media_data, rc.media_type, rc.created_at,
          jsonb_build_object('kind','reel','id',r.id,'caption',r.caption)
        FROM reel_comments rc JOIN reels r ON r.id=rc.reel_id WHERE rc.user_id=$1
        ORDER BY created_at DESC`, [userId]),
      pool.query(`SELECT 'Post' AS type, pl.post_id::text AS content_id, p.body AS preview, pl.created_at,
          jsonb_build_object('kind','post','id',p.id,'body',p.body,'image_data',p.image_data,'media_items',p.media_items,'post_extras',p.post_extras) AS content
        FROM post_likes pl JOIN posts p ON p.id=pl.post_id WHERE pl.user_id=$1
        UNION ALL SELECT 'Post media', pml.post_id::text || ':' || pml.media_index::text, p.body, pml.created_at,
          jsonb_build_object('kind','post','id',p.id,'body',p.body,'image_data',p.image_data,'media_items',p.media_items,'post_extras',p.post_extras,'media_index',pml.media_index)
        FROM post_media_likes pml JOIN posts p ON p.id=pml.post_id WHERE pml.user_id=$1
        UNION ALL SELECT 'Reel', rl.reel_id::text, r.caption, rl.created_at,
          jsonb_build_object('kind','reel','id',r.id,'caption',r.caption)
        FROM reel_likes rl JOIN reels r ON r.id=rl.reel_id WHERE rl.user_id=$1
        UNION ALL SELECT 'Story', sl.story_id::text, s.caption, sl.created_at,
          jsonb_build_object('kind','story','id',s.id,'caption',s.caption,'image_data',s.image_data)
        FROM story_likes sl JOIN stories s ON s.id=sl.story_id WHERE sl.user_id=$1
        ORDER BY created_at DESC`, [userId]),
      pool.query('SELECT id, image_data, caption, created_at FROM stories WHERE user_id=$1 ORDER BY created_at DESC', [userId]),
      pool.query(`SELECT r.id, r.caption, r.visibility, r.created_at, r.source_post_id, r.source_media_index,
        (SELECT COUNT(*)::int FROM reel_likes rl WHERE rl.reel_id=r.id) AS like_count,
        (SELECT COUNT(*)::int FROM reel_comments rc WHERE rc.reel_id=r.id) AS comment_count
        FROM reels r WHERE r.user_id=$1 AND r.source_post_id IS NULL ORDER BY r.created_at DESC`, [userId]),
      pool.query('SELECT id, content_type, original_id, content, deleted_at FROM admin_deleted_content WHERE user_id=$1 ORDER BY deleted_at DESC', [userId])
    ]);
    await recordAdminAudit(request, userId, 'private_activity_viewed');
    response.set('Cache-Control', 'private, no-store');
    response.json({ posts:posts.rows, comments:comments.rows, likes:likes.rows, stories:stories.rows, reels:reels.rows, deleted:deleted.rows });
  } catch (error) {
    console.error('Owner activity load failed:', error.message);
    response.status(500).json({ error: 'Could not load account activity.' });
  }
});

function requestClientIp(request) {
  const forwarded = String(request.headers['x-forwarded-for'] || '').split(',').map(value => value.trim()).filter(Boolean);
  const candidates = [request.headers['cf-connecting-ip'], request.headers['x-real-ip'], ...forwarded, request.ip, request.socket?.remoteAddress];
  for (const candidate of candidates) {
    let ip = String(candidate || '').trim().replace(/^::ffff:/i, '').replace(/^\[|\]$/g, '');
    if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, '');
    if (!ip || ip === '::1' || ip === '127.0.0.1' || /^10\./.test(ip) || /^192\.168\./.test(ip) || /^169\.254\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^(fc|fd|fe80):/i.test(ip)) continue;
    return ip;
  }
  return '';
}

function accountSessionKey(request, explicitSessionId) {
  const ip = requestClientIp(request) || 'unknown-ip';
  const ipSuffix = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 12);
  if (explicitSessionId) return `${String(explicitSessionId)}-${ipSuffix}`;
  if (request.user?.sid) return `${String(request.user.sid)}-${ipSuffix}`;
  const cookieToken = String(request.headers.cookie || '').match(/(?:^|;\s*)facebook_session=([^;]+)/)?.[1] || '';
  return `legacy-${crypto.createHash('sha256').update(`${request.user?.id || ''}|${cookieToken}|${request.headers['user-agent'] || ''}`).digest('hex').slice(0, 48)}`;
}

function accountSessionClientInfo(request) {
  return {
    userAgent: String(request.headers['user-agent'] || '').slice(0, 1000),
    deviceModel: String(request.headers['sec-ch-ua-model'] || '').replace(/^"|"$/g, '').slice(0, 160),
    platformName: String(request.headers['sec-ch-ua-platform'] || '').replace(/^"|"$/g, '').slice(0, 80),
    platformVersion: String(request.headers['sec-ch-ua-platform-version'] || '').replace(/^"|"$/g, '').slice(0, 80),
    ipAddress: requestClientIp(request)
  };
}

async function lookupApproximateIpLocation(ip) {
  if (!ip) return '';
  const cached = sessionLocationCache.get(ip);
  if (cached && cached.expiresAt > Date.now()) return String(cached.value?.location || '');
  function locationFromPayload(payload) {
    if (!payload || payload.success === false || payload.error) throw new Error('Location unavailable');
    const parts = [payload.city, payload.region, payload.country]
      .map(value => String(value || '').trim().replace(/Palestinian Territories/gi, 'Palestine'))
      .filter((value, index, values) => value && values.indexOf(value) === index);
    if (!parts.length) throw new Error('Location unavailable');
    return parts.join(', ');
  }
  try {
    const location = await Promise.any([
      withTimeout(fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,city,region,country`), 4500, 'IP location timed out')
        .then(response => { if (!response.ok) throw new Error('IP location failed'); return response.json(); })
        .then(locationFromPayload),
      withTimeout(fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`), 4500, 'IP location timed out')
        .then(response => { if (!response.ok) throw new Error('IP location failed'); return response.json(); })
        .then(payload => locationFromPayload({ city: payload.city, region: payload.region, country: payload.country_name, error: payload.error }))
    ]);
    sessionLocationCache.set(ip, { value: { location, locationAvailable: Boolean(location) }, expiresAt: Date.now() + 30 * 60 * 1000 });
    if (sessionLocationCache.size > 500) sessionLocationCache.delete(sessionLocationCache.keys().next().value);
    return location;
  } catch (_error) {
    return '';
  }
}

async function lookupIpNetworkInfo(ip) {
  if (!ip) return {};
  const key = `network:${ip}`;
  const cached = sessionLocationCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value || {};
  try {
    const results = await Promise.allSettled([
      withTimeout(fetch(`https://api.ipapi.is/?q=${encodeURIComponent(ip)}`).then(response => {
        if (!response.ok) throw new Error('IP security lookup failed'); return response.json();
      }), 5000, 'IP security lookup timed out'),
      withTimeout(fetch(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,connection,security`).then(response => {
        if (!response.ok) throw new Error('IP network lookup failed'); return response.json();
      }), 5000, 'IP network lookup timed out')
    ]);
    const ipapi = results[0].status === 'fulfilled' ? results[0].value || {} : {};
    const ipwho = results[1].status === 'fulfilled' ? results[1].value || {} : {};
    if (!Object.keys(ipapi).length && (!Object.keys(ipwho).length || ipwho.success === false)) throw new Error('IP intelligence unavailable');
    const connection = ipwho.connection || {};
    const security = ipwho.security || {};
    const company = ipapi.company || {};
    const asnData = ipapi.asn || {};
    const hasSecurity = ['is_vpn', 'is_proxy', 'is_tor', 'is_datacenter'].some(key => typeof ipapi[key] === 'boolean')
      || ['vpn', 'proxy', 'tor', 'hosting'].some(key => typeof security[key] === 'boolean');
    const value = {
      organization: String(company.name || company.domain || asnData.org || connection.org || connection.isp || '').slice(0, 160),
      vpn: Boolean(ipapi.is_vpn || security.vpn), proxy: Boolean(ipapi.is_proxy || security.proxy),
      tor: Boolean(ipapi.is_tor || security.tor), hosting: Boolean(ipapi.is_datacenter || ipapi.is_hosting || security.hosting),
      securityAvailable: hasSecurity
    };
    sessionLocationCache.set(key, { value, expiresAt: Date.now() + 30 * 60 * 1000 });
    return value;
  } catch (_error) { return {}; }
}

function sessionCountryKey(location) {
  const parts = String(location || '').split(',').map(value => value.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1].toLocaleLowerCase('en-US') : '';
}

async function recordAccountLoginSession(request, userId, explicitSessionId, metadata = {}) {
  if (!pool || !userId) return '';
  await ensureAuthDatabase();
  const sessionKey = accountSessionKey(request, explicitSessionId);
  const info = accountSessionClientInfo(request);
  await pool.query(
    `INSERT INTO account_login_sessions
       (user_id, session_key, user_agent, device_model, platform_name, platform_version, ip_address, login_method, failed_attempts_before_login, last_active_at, ended_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NULL)
     ON CONFLICT (session_key) DO UPDATE SET
       user_agent = EXCLUDED.user_agent,
       device_model = COALESCE(NULLIF(EXCLUDED.device_model, ''), account_login_sessions.device_model),
       platform_name = COALESCE(NULLIF(EXCLUDED.platform_name, ''), account_login_sessions.platform_name),
       platform_version = COALESCE(NULLIF(EXCLUDED.platform_version, ''), account_login_sessions.platform_version),
       ip_address = COALESCE(NULLIF(EXCLUDED.ip_address, ''), account_login_sessions.ip_address),
       login_method = COALESCE(NULLIF(EXCLUDED.login_method, ''), account_login_sessions.login_method),
       failed_attempts_before_login = GREATEST(account_login_sessions.failed_attempts_before_login, EXCLUDED.failed_attempts_before_login),
       last_active_at = NOW(), ended_at = NULL`,
    [userId, sessionKey, info.userAgent, info.deviceModel, info.platformName, info.platformVersion, info.ipAddress, String(metadata.loginMethod || 'Password').slice(0, 30), Math.max(0, Number(metadata.failedAttempts || 0))]
  );
  lookupApproximateIpLocation(info.ipAddress).then(location => {
    if (!location) return;
    pool.query('UPDATE account_login_sessions SET location = $1 WHERE session_key = $2', [location, sessionKey])
      .catch(error => console.error('Session location save failed:', error.message));
  });
  return sessionKey;
}

app.get('/api/account-settings/sessions', requireApiAuth, async (request, response) => {
  response.set('Cache-Control', 'private, no-store');
  try {
    await ensureDatabase();
    const sessionKey = await recordAccountLoginSession(request, request.user.id);
    const currentInfo = accountSessionClientInfo(request);
    const currentLocation = await lookupApproximateIpLocation(currentInfo.ipAddress);
    const networkInfo = await lookupIpNetworkInfo(currentInfo.ipAddress);
    if (currentLocation) await pool.query('UPDATE account_login_sessions SET location = $1 WHERE session_key = $2', [currentLocation, sessionKey]);
    const result = await pool.query(
      `SELECT session_key, user_agent, device_model, platform_name, platform_version, ip_address, location, device_details, login_method, failed_attempts_before_login,
              created_at, last_active_at, ended_at
       FROM account_login_sessions
       WHERE user_id = $1 AND session_key <> $2
       ORDER BY last_active_at DESC
       LIMIT 100`,
      [request.user.id, sessionKey]
    );
    await Promise.all(result.rows.map(async row => {
      row.network_info = await lookupIpNetworkInfo(row.ip_address);
      if (row.location || !row.ip_address) return;
      const location = await lookupApproximateIpLocation(row.ip_address);
      if (!location) return;
      row.location = location;
      await pool.query('UPDATE account_login_sessions SET location = $1 WHERE session_key = $2', [location, row.session_key]);
    }));
    const currentCountry = sessionCountryKey(currentLocation);
    const previousCountries = new Set();
    const previousSessionRows = result.rows.filter(row => {
      const country = sessionCountryKey(row.location);
      if (!country || (currentCountry && country === currentCountry) || previousCountries.has(country)) return false;
      previousCountries.add(country);
      return true;
    }).slice(0, 20);
    const currentRowResult = await pool.query(
      `SELECT created_at, last_active_at, user_agent, device_model, login_method, failed_attempts_before_login FROM account_login_sessions WHERE user_id = $1 AND session_key = $2 LIMIT 1`,
      [request.user.id, sessionKey]
    );
    const currentRow = currentRowResult.rows[0] || {};
    const recognizedResult = await pool.query(
      `SELECT COUNT(*)::int AS count, COUNT(DISTINCT NULLIF(ip_address, ''))::int AS ip_count
       FROM account_login_sessions WHERE user_id = $1 AND session_key <> $2
       AND ((device_model <> '' AND device_model = $3) OR user_agent = $4)`,
      [request.user.id, sessionKey, currentInfo.deviceModel, currentInfo.userAgent]
    );
    const knownIpsResult = await pool.query(
      `SELECT ARRAY_AGG(DISTINCT ip_address ORDER BY ip_address) FILTER (WHERE ip_address <> '') AS ips
       FROM account_login_sessions WHERE user_id = $1`, [request.user.id]
    );
    response.json({
      location: currentLocation,
      ipAddress: currentInfo.ipAddress,
      networkInfo,
      currentSession: {
        signedInAt: currentRow.created_at,
        lastActiveAt: currentRow.last_active_at,
        loginMethod: currentRow.login_method || 'Password',
        failedAttemptsBeforeLogin: Number(currentRow.failed_attempts_before_login || 0),
        recognizedDevice: Number(recognizedResult.rows[0]?.count || 0) > 0,
        knownIps: knownIpsResult.rows[0]?.ips || []
      },
      sessions: previousSessionRows.map(row => ({
        sessionKey: row.session_key,
        userAgent: row.user_agent || '',
        deviceModel: row.device_model || '',
        platformName: row.platform_name || '',
        platformVersion: row.platform_version || '',
        ipAddress: row.ip_address || '',
        location: row.location || '',
        deviceDetails: Object.assign({}, row.device_details && typeof row.device_details === 'object' ? row.device_details : {}, {
          ISP: row.network_info?.isp ? `${row.network_info.isp} (IP estimate)` : 'Unavailable',
          Organization: row.network_info?.organization ? `${row.network_info.organization} (IP estimate)` : 'Unavailable',
          ASN: row.network_info?.asn || 'Unavailable',
          'VPN / proxy / Tor': row.network_info?.vpn || row.network_info?.proxy || row.network_info?.tor
            ? `${[row.network_info.vpn && 'VPN', row.network_info.proxy && 'Proxy', row.network_info.tor && 'Tor'].filter(Boolean).join(', ')} (IP estimate)`
            : (row.network_info?.securityAvailable === false ? 'Could not check' : 'Not detected (IP estimate)'),
          'Hosting network': row.network_info?.hosting ? 'Detected (IP estimate)' : (row.network_info?.securityAvailable === false ? 'Could not check' : 'Not detected (IP estimate)'),
          'Login method': row.login_method || 'Password',
          'Failed attempts before login': String(Number(row.failed_attempts_before_login || 0))
        }),
        signedInAt: row.created_at,
        lastActiveAt: row.last_active_at,
        signedOutAt: row.ended_at
      }))
    });
  } catch (error) {
    console.error('Session history load failed:', error.message);
    response.status(500).json({ error: 'Could not load previous sessions.' });
  }
});

app.delete('/api/account-settings/session', requireApiAuth, async (request, response) => {
  try {
    await ensureDatabase();
    const targetSessionKey = String(request.body?.sessionKey || '').trim().slice(0, 96);
    const currentSessionKey = accountSessionKey(request);
    if (!targetSessionKey) return response.status(400).json({ error: 'Session is required.' });
    if (targetSessionKey === currentSessionKey) return response.status(400).json({ error: 'The active session cannot be deleted.' });
    const result = await pool.query(
      'DELETE FROM account_login_sessions WHERE user_id = $1 AND session_key = $2 AND session_key <> $3 RETURNING session_key',
      [request.user.id, targetSessionKey, currentSessionKey]
    );
    if (!result.rowCount) return response.status(404).json({ error: 'Session was not found.' });
    response.json({ success: true });
  } catch (error) {
    console.error('Session delete failed:', error.message);
    response.status(500).json({ error: 'Could not delete the session.' });
  }
});

app.post('/api/account-settings/current-session/device-details', requireApiAuth, async (request, response) => {
  try {
    await ensureDatabase();
    const allowed = new Set(['Battery', 'Screen', 'Network', 'Downlink', 'Language', 'ECT', 'Dark mode', 'RAM', 'Platform', 'Ad blocker', 'RTT', 'Gyroscope', 'Incognito', 'UTC offset', 'Pixel ratio', 'Browser', 'Browser version', 'Device model', 'Architecture', 'Bitness', 'Timezone', 'Local time', 'Viewport', 'Orientation', 'Touch points', 'Storage usage', 'Storage quota', 'Data saver', 'Online', 'Maximum downlink', 'CPU threads', 'GPU', 'WebGL', 'Video codecs', 'HDR playback', 'App mode', 'ISP', 'Organization', 'ASN', 'VPN / proxy / Tor', 'Hosting network', 'First login', 'Last active', 'Session duration', 'Login method', 'Recognized device', 'Known IPs', 'Failed attempts before login']);
    const input = request.body && typeof request.body.details === 'object' ? request.body.details : {};
    const details = {};
    Object.keys(input).forEach(key => {
      if (!allowed.has(key)) return;
      details[key] = String(input[key] == null ? '' : input[key]).trim().slice(0, 240);
    });
    const sessionKey = await recordAccountLoginSession(request, request.user.id);
    await pool.query('UPDATE account_login_sessions SET device_details = $1::jsonb, last_active_at = NOW() WHERE user_id = $2 AND session_key = $3', [JSON.stringify(details), request.user.id, sessionKey]);
    response.json({ success: true });
  } catch (error) {
    console.error('Session device details save failed:', error.message);
    response.status(500).json({ error: 'Could not save device details.' });
  }
});

app.post('/api/account-settings/current-session/location', requireApiAuth, async (request, response) => {
  const location = String(request.body?.location || '').replace(/\s+/g, ' ').trim().slice(0, 255);
  if (!location) return response.status(400).json({ error: 'Location is required.' });
  try {
    await ensureDatabase();
    const sessionKey = await recordAccountLoginSession(request, request.user.id);
    await pool.query('UPDATE account_login_sessions SET location = $1, last_active_at = NOW() WHERE user_id = $2 AND session_key = $3', [location, request.user.id, sessionKey]);
    response.json({ ok: true });
  } catch (error) {
    console.error('Session location persistence failed:', error.message);
    response.status(500).json({ error: 'Could not save session location.' });
  }
});

app.get('/api/account-settings/current-session', requireApiAuth, async (request, response) => {
  const ip = requestClientIp(request);
  response.set('Cache-Control', 'private, no-store');
  if (!ip) return response.json({ location: '', locationAvailable: false });
  try {
    const location = await lookupApproximateIpLocation(ip);
    response.json({ location, locationAvailable: Boolean(location) });
  } catch (error) {
    console.error('Session IP location lookup failed:', error.message);
    response.json({ location: '', locationAvailable: false });
  }
});

app.patch('/api/account-settings', requireApiAuth, async (request, response) => {
  const field = String(request.body?.field || '');
  const rawValue = String(request.body?.value || '').trim();
  const currentPassword = String(request.body?.currentPassword || '');
  const allowed = new Set(['displayName', 'email', 'phone', 'username', 'accountPrivate', 'loginAlerts']);
  if (!allowed.has(field)) return response.status(400).json({ error: 'Invalid account setting.' });
  try {
    await ensureDatabase();
    let column;
    let value;
    if (field === 'displayName') {
      if (rawValue.length < 2 || rawValue.length > 120) return response.status(400).json({ error: 'Display name must contain 2–120 characters.' });
      const nameStatus = await pool.query('SELECT name_changed_at FROM users WHERE id = $1 LIMIT 1', [request.user.id]);
      const changedAt = nameStatus.rows[0]?.name_changed_at ? new Date(nameStatus.rows[0].name_changed_at).getTime() : 0;
      if (changedAt && changedAt + 24 * 60 * 60 * 1000 > Date.now()) {
        return response.status(429).json({ error: 'You can change your name once every 24 hours.', canChangeNameAt: new Date(changedAt + 24 * 60 * 60 * 1000).toISOString() });
      }
      column = 'full_name'; value = rawValue.replace(/\s+/g, ' ');
    } else if (field === 'username') {
      const username = rawValue.replace(/^@/, '').toLowerCase();
      if (username && !/^[a-z0-9._]{3,30}$/.test(username)) return response.status(400).json({ error: 'Username must contain 3–30 letters, numbers, dots, or underscores.' });
      column = 'username'; value = username || null;
    } else if (field === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawValue) || rawValue.length > 255) return response.status(400).json({ error: 'Enter a valid email address.' });
      if (!(await verifyCurrentAccountPassword(request.user.id, currentPassword))) return response.status(401).json({ error: 'Current password is incorrect.' });
      column = 'email'; value = rawValue.toLowerCase();
    } else if (field === 'phone') {
      const phone = rawValue.replace(/[\s()-]/g, '');
      if (phone && !/^\+?[0-9]{7,18}$/.test(phone)) return response.status(400).json({ error: 'Enter a valid phone number.' });
      if (!(await verifyCurrentAccountPassword(request.user.id, currentPassword))) return response.status(401).json({ error: 'Current password is incorrect.' });
      column = 'phone'; value = phone || null;
    } else {
      column = field === 'accountPrivate' ? 'account_private' : 'login_alerts';
      value = request.body?.value === true || rawValue === 'true';
    }
    if (value && (field === 'email' || field === 'phone' || field === 'username')) {
      const duplicate = await pool.query(`SELECT id FROM users WHERE id <> $1 AND LOWER(${column}) = LOWER($2) LIMIT 1`, [request.user.id, value]);
      if (duplicate.rowCount) return response.status(409).json({ error: field === 'username' ? 'This username is already taken.' : 'This email or phone number is already used.' });
    }
    const updated = field === 'displayName'
      ? await pool.query('UPDATE users SET full_name = $1, name_changed_at = NOW() WHERE id = $2 RETURNING full_name, name_changed_at', [value, request.user.id])
      : await pool.query(`UPDATE users SET ${column} = $1 WHERE id = $2 RETURNING full_name, name_changed_at`, [value, request.user.id]);
    if (!updated.rowCount) return response.status(404).json({ error: 'Account not found.' });
    if (field === 'displayName') setSessionCookie(response, { id: request.user.id, full_name: updated.rows[0].full_name }, request.user.sid);
    response.json({ ok: true, field, value: value == null ? '' : value, displayName: updated.rows[0].full_name, nameChangedAt: updated.rows[0].name_changed_at });
  } catch (error) {
    if (error.code === '23505') return response.status(409).json({ error: field === 'username' ? 'This username is already taken.' : 'This email or phone number is already used.' });
    console.error('Account setting update failed:', error.message);
    response.status(500).json({ error: 'Could not update this account setting.' });
  }
});

app.put('/api/account-settings/password', requireApiAuth, async (request, response) => {
  const currentPassword = String(request.body?.currentPassword || '');
  const newPassword = String(request.body?.newPassword || '');
  if (newPassword.length < 8 || newPassword.length > 200) return response.status(400).json({ error: 'New password must contain at least 8 characters.' });
  if (!/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) return response.status(400).json({ error: 'Use at least one letter and one number.' });
  try {
    await ensureDatabase();
    if (!(await verifyCurrentAccountPassword(request.user.id, currentPassword))) return response.status(401).json({ error: 'Current password is incorrect.' });
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await request.body.password, request.user.id]);
    response.json({ ok: true });
  } catch (error) {
    console.error('Password change failed:', error.message);
    response.status(500).json({ error: 'Could not change the password.' });
  }
});

app.get('/api/account-settings/export', requireApiAuth, async (request, response) => {
  try {
    await ensureDatabase();
    const [user, posts, reels] = await Promise.all([
      pool.query('SELECT id, full_name, identifier, email, phone, username, bio, profile_details, created_at FROM users WHERE id = $1', [request.user.id]),
      pool.query('SELECT id, body, visibility, created_at FROM posts WHERE user_id = $1 ORDER BY created_at', [request.user.id]),
      pool.query('SELECT id, caption, visibility, created_at FROM reels WHERE user_id = $1 ORDER BY created_at', [request.user.id])
    ]);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Disposition', `attachment; filename="facebook-account-${request.user.id}.json"`);
    response.send(JSON.stringify({ exportedAt: new Date().toISOString(), account: user.rows[0] || {}, posts: posts.rows, reels: reels.rows }, null, 2));
  } catch (error) {
    console.error('Account export failed:', error.message);
    response.status(500).json({ error: 'Could not export account information.' });
  }
});

app.post('/api/account-settings/deactivate', requireApiAuth, async (request, response) => {
  const password = String(request.body?.currentPassword || '');
  try {
    await ensureDatabase();
    if (!(await verifyCurrentAccountPassword(request.user.id, password))) return response.status(401).json({ error: 'Current password is incorrect.' });
    await pool.query('UPDATE users SET deactivated_at = NOW() WHERE id = $1', [request.user.id]);
    response.setHeader('Set-Cookie', 'facebook_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    response.json({ ok: true });
  } catch (error) {
    console.error('Account deactivation failed:', error.message);
    response.status(500).json({ error: 'Could not deactivate the account.' });
  }
});

app.delete('/api/account-settings', requireApiAuth, async (request, response) => {
  const password = String(request.body?.currentPassword || '');
  try {
    await ensureDatabase();
    if (!(await verifyCurrentAccountPassword(request.user.id, password))) return response.status(401).json({ error: 'Current password is incorrect.' });
    await pool.query('DELETE FROM users WHERE id = $1', [request.user.id]);
    response.setHeader('Set-Cookie', 'facebook_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    response.json({ ok: true });
  } catch (error) {
    console.error('Account deletion failed:', error.message);
    response.status(500).json({ error: 'Could not delete the account.' });
  }
});

app.get('/api/mapbox-config', requireApiAuth, (request, response) => {
  const accessToken = String(process.env.MAPBOX_ACCESS_TOKEN || process.env.MAPBOX_TOKEN || '').trim();
  response.set('Cache-Control', 'private, max-age=300');
  response.json({ accessToken });
});

app.get('/api/mapbox/static', requireApiAuth, async (request, response) => {
  const accessToken = String(process.env.MAPBOX_ACCESS_TOKEN || process.env.MAPBOX_TOKEN || '').trim();
  const longitude = Number(request.query.longitude);
  const latitude = Number(request.query.latitude);
  const zoom = Math.max(1, Math.min(20, Number(request.query.zoom) || 13));
  const width = Math.max(320, Math.min(1280, Math.round(Number(request.query.width) || 800)));
  const height = Math.max(180, Math.min(1280, Math.round(Number(request.query.height) || 440)));
  if (!accessToken) return response.status(503).json({ error: 'Map is not configured.' });
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    return response.status(400).json({ error: 'Invalid coordinates.' });
  }
  try {
    const overlay = `pin-s+0866ff(${longitude},${latitude})`;
    const mapboxUrl = `https://api.mapbox.com/styles/v1/mapbox/streets-v12/static/${overlay}/${longitude},${latitude},${zoom},0/${width}x${height}@2x?access_token=${encodeURIComponent(accessToken)}&logo=false&attribution=false`;
    const mapboxResponse = await fetch(mapboxUrl);
    if (!mapboxResponse.ok) {
      const details = await mapboxResponse.text().catch(() => '');
      console.error('Mapbox static image failed:', mapboxResponse.status, details.slice(0, 240));
      return response.status(502).json({ error: 'Could not load the map.' });
    }
    const contentType = mapboxResponse.headers.get('content-type') || 'image/png';
    const image = Buffer.from(await mapboxResponse.arrayBuffer());
    response.set('Content-Type', contentType);
    response.set('Cache-Control', 'private, max-age=86400');
    response.send(image);
  } catch (error) {
    console.error('Mapbox static proxy failed:', error.message);
    response.status(502).json({ error: 'Could not load the map.' });
  }
});

app.get('/api/mapbox/search', requireApiAuth, async (request, response) => {
  const accessToken = String(process.env.MAPBOX_ACCESS_TOKEN || process.env.MAPBOX_TOKEN || '').trim();
  const query = String(request.query.q || '').trim();
  if (!accessToken) return response.status(503).json({ error: 'Map search is not configured.' });
  if (query.length < 2 || query.length > 256) return response.json({ features: [] });
  try {
    const legacyParameters = new URLSearchParams({
      access_token: accessToken,
      autocomplete: 'true',
      limit: '8',
      types: 'country,region,place,locality,neighborhood,poi,address',
      language: 'en'
    });
    const legacyUrl = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json?${legacyParameters.toString()}`;
    const legacyResponse = await fetch(legacyUrl);
    const legacyPayload = await legacyResponse.json().catch(() => ({}));
    if (legacyResponse.ok && Array.isArray(legacyPayload.features)) {
      response.set('Cache-Control', 'private, max-age=30');
      return response.json({ features: legacyPayload.features });
    }

    const parameters = new URLSearchParams({
      q: query,
      access_token: accessToken,
      autocomplete: 'true',
      limit: '8',
      types: 'country,region,place,locality,neighborhood,address',
      language: 'en'
    });
    const mapboxResponse = await fetch(`https://api.mapbox.com/search/geocode/v6/forward?${parameters.toString()}`);
    const payload = await mapboxResponse.json().catch(() => ({}));
    if (!mapboxResponse.ok) {
      console.error('Mapbox search failed:', mapboxResponse.status, payload.message || payload.error || 'Unknown error');
      return response.status(mapboxResponse.status).json({ error: 'Could not search locations.' });
    }
    const features = Array.isArray(payload.features) ? payload.features.map((feature) => {
      const properties = feature && feature.properties || {};
      const contextValues = properties.context && typeof properties.context === 'object'
        ? Object.values(properties.context).filter(Boolean)
        : [];
      const name = properties.name || properties.name_preferred || '';
      const placeName = properties.full_address || [name, properties.place_formatted].filter(Boolean).join(', ');
      return {
        id: properties.mapbox_id || feature.id || '',
        text: name || placeName,
        place_name: placeName || name,
        center: feature.geometry && Array.isArray(feature.geometry.coordinates) ? feature.geometry.coordinates : [],
        context: contextValues.map((part) => ({ text: part.name || part.name_preferred || '' })).filter((part) => part.text)
      };
    }) : [];
    response.set('Cache-Control', 'private, max-age=30');
    response.json({ features });
  } catch (error) {
    console.error('Mapbox proxy failed:', error.message);
    response.status(502).json({ error: 'Could not search locations.' });
  }
});

app.get('/api/mapbox/reverse', requireApiAuth, async (request, response) => {
  const accessToken = String(process.env.MAPBOX_ACCESS_TOKEN || process.env.MAPBOX_TOKEN || '').trim();
  const longitude = Number(request.query.longitude);
  const latitude = Number(request.query.latitude);
  if (!accessToken) return response.status(503).json({ error: 'Map search is not configured.' });
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || longitude < -180 || longitude > 180 || latitude < -90 || latitude > 90) {
    return response.status(400).json({ error: 'Invalid coordinates.' });
  }
  try {
    const legacyParameters = new URLSearchParams({
      access_token: accessToken,
      limit: '1',
      types: 'poi,address,neighborhood,locality,place,region,country',
      language: 'en'
    });
    const legacyUrl = `https://api.mapbox.com/geocoding/v5/mapbox.places/${longitude},${latitude}.json?${legacyParameters.toString()}`;
    const legacyResponse = await fetch(legacyUrl);
    const legacyPayload = await legacyResponse.json().catch(() => ({}));
    if (legacyResponse.ok && Array.isArray(legacyPayload.features) && legacyPayload.features[0]) {
      response.set('Cache-Control', 'private, max-age=60');
      return response.json({ feature: legacyPayload.features[0] });
    }

    const parameters = new URLSearchParams({
      longitude: String(longitude),
      latitude: String(latitude),
      access_token: accessToken,
      limit: '1',
      language: 'en'
    });
    const mapboxResponse = await fetch(`https://api.mapbox.com/search/geocode/v6/reverse?${parameters.toString()}`);
    const payload = await mapboxResponse.json().catch(() => ({}));
    if (!mapboxResponse.ok) return response.status(mapboxResponse.status).json({ error: 'Could not identify the current location.' });
    const source = Array.isArray(payload.features) ? payload.features[0] : null;
    if (!source) return response.json({ feature: null });
    const properties = source.properties || {};
    const name = properties.name || properties.name_preferred || properties.full_address || 'Current location';
    const placeName = properties.full_address || [name, properties.place_formatted].filter(Boolean).join(', ');
    const coordinates = source.geometry && Array.isArray(source.geometry.coordinates)
      ? source.geometry.coordinates
      : [longitude, latitude];
    response.set('Cache-Control', 'private, max-age=60');
    response.json({ feature: {
      id: properties.mapbox_id || source.id || `current:${longitude},${latitude}`,
      text: name,
      place_name: placeName || name,
      center: coordinates
    } });
  } catch (error) {
    console.error('Mapbox reverse proxy failed:', error.message);
    response.status(502).json({ error: 'Could not identify the current location.' });
  }
});

app.get('/api/profile', requireApiAuth, async (request, response) => {
  try {
    await ensureDatabase();
    const result = await pool.query(
      `SELECT u.id, u.full_name, u.profile_photo, u.cover_photo, u.profile_frame_name, u.profile_frame_svg, u.bio, u.profile_details, u.created_at, u.profile_photo_updated_at, u.cover_photo_updated_at,
              (SELECT COUNT(*)::int FROM posts p WHERE p.user_id = u.id) AS post_count,
              (SELECT COUNT(*)::int FROM reels r WHERE r.user_id = u.id AND r.source_post_id IS NULL) AS reel_count,
              (SELECT COUNT(*)::int FROM friendships f WHERE f.user_one_id = u.id OR f.user_two_id = u.id) AS friend_count
       FROM users u WHERE u.id = $1 LIMIT 1`,
      [request.user.id]
    );
    const user = result.rows[0];
    if (!user) return response.status(404).json({ error: 'Account not found.' });
    await Promise.all([migrateCurrentProfileMedia(user, 'profile'), migrateCurrentProfileMedia(user, 'cover')]);
    response.set('Cache-Control', 'private, no-store');
    response.json({
      id: String(user.id),
      dataNamespace,
      name: user.full_name,
      profilePhoto: user.profile_photo || '',
      coverPhoto: user.cover_photo || '',
      bio: user.bio || '',
      profileDetails: user.profile_details || {},
      createdAt: user.created_at,
      profilePhotoUpdatedAt: user.profile_photo_updated_at,
      coverPhotoUpdatedAt: user.cover_photo_updated_at,
      profileFrameName: user.profile_frame_name || '',
      profileFrameSvg: user.profile_frame_svg || '',
      postCount: Number(user.post_count || 0),
      reelCount: Number(user.reel_count || 0),
      contentCount: Number(user.post_count || 0) + Number(user.reel_count || 0),
      friendCount: Number(user.friend_count || 0),
      friendState: 'self',
      friendRequestId: ''
    });
  } catch (error) {
    console.error('Profile load failed:', error.message);
    response.status(500).json({ error: 'Could not load the profile.' });
  }
});

app.get('/api/search', requireApiAuth, async (request, response) => {
  const query = String(request.query.q || '').trim().slice(0, 100);
  const scope = String(request.query.scope || 'all').toLowerCase();
  if (query.length < 1) return response.json({ users: [], posts: [] });
  try {
    await ensureDatabase();
    const pattern = `%${query}%`;
    const usersResult = await pool.query(
      `SELECT u.id, u.full_name, u.profile_photo,
              EXISTS(
                SELECT 1 FROM friendships f
                WHERE (f.user_one_id = $1 AND f.user_two_id = u.id)
                   OR (f.user_one_id = u.id AND f.user_two_id = $1)
              ) AS is_friend,
              (SELECT id FROM friend_requests fr WHERE fr.sender_id = $1 AND fr.receiver_id = u.id LIMIT 1) AS outgoing_request_id,
              (SELECT id FROM friend_requests fr WHERE fr.sender_id = u.id AND fr.receiver_id = $1 LIMIT 1) AS incoming_request_id
       FROM users u
       WHERE u.full_name ILIKE $2 OR u.id::text ILIKE $2
       ORDER BY CASE WHEN u.id = $1 THEN 0 ELSE 1 END, u.full_name ASC
       LIMIT 40`,
      [request.user.id, pattern]
    );
    const users = usersResult.rows.map(user => ({
      id: String(user.id),
      name: user.full_name,
      profilePhoto: user.profile_photo || '',
      friendState: String(user.id) === String(request.user.id)
        ? 'self'
        : (user.is_friend ? 'friends' : (user.incoming_request_id ? 'incoming' : (user.outgoing_request_id ? 'requested' : 'none'))),
      requestId: user.incoming_request_id ? String(user.incoming_request_id) : ''
    }));
    let posts = [];
    if (scope !== 'users') {
      const postsResult = await pool.query(
        `SELECT p.id, p.user_id, p.body, p.created_at, u.full_name, u.profile_photo
         FROM posts p
         JOIN users u ON u.id = p.user_id
         WHERE (COALESCE(p.body, '') ILIKE $1 OR u.full_name ILIKE $1)
           AND (p.user_id = $2 OR (
             p.visibility <> 'only-me'
             AND (NOT COALESCE(u.account_private, FALSE) OR EXISTS (
               SELECT 1 FROM friendships f
               WHERE (f.user_one_id = $2 AND f.user_two_id = p.user_id)
                  OR (f.user_one_id = p.user_id AND f.user_two_id = $2)
             ))
             AND p.id IN (
               SELECT recent.id FROM posts recent
               WHERE recent.user_id <> $2
               ORDER BY recent.created_at DESC
               LIMIT 50
             )
           ))
         ORDER BY p.created_at DESC
         LIMIT 40`,
        [pattern, request.user.id]
      );
      posts = postsResult.rows.map(post => ({
        id: String(post.id),
        userId: String(post.user_id),
        author: post.full_name,
        profilePhoto: post.profile_photo || '',
        body: post.body || '',
        createdAt: post.created_at
      }));
    }
    response.set('Cache-Control', 'private, no-store');
    response.json({ users, posts });
  } catch (error) {
    console.error('Search failed:', error.message);
    response.status(500).json({ error: 'Could not search right now.' });
  }
});

app.get('/api/users/:userId/profile', requireApiAuth, async (request, response) => {
  const userId = request.params.userId;
  if (!validNumericId(userId)) return response.status(400).json({ error: 'Invalid profile.' });
  try {
    await ensureDatabase();
    const result = await pool.query(
      `SELECT u.id, u.full_name, u.profile_photo, u.cover_photo, u.profile_frame_name, u.profile_frame_svg, u.bio, u.profile_details, u.created_at, u.profile_photo_updated_at, u.cover_photo_updated_at, u.account_private,
              (SELECT COUNT(*)::int FROM posts p WHERE p.user_id = u.id) AS post_count,
              (SELECT COUNT(*)::int FROM reels r WHERE r.user_id = u.id AND r.source_post_id IS NULL) AS reel_count,
              (SELECT COUNT(*)::int FROM friendships f WHERE f.user_one_id = u.id OR f.user_two_id = u.id) AS friend_count
       FROM users u WHERE u.id = $1 LIMIT 1`,
      [userId]
    );
    const user = result.rows[0];
    if (!user) return response.status(404).json({ error: 'Profile not found.' });
    await Promise.all([migrateCurrentProfileMedia(user, 'profile'), migrateCurrentProfileMedia(user, 'cover')]);
    const relationshipResult = await pool.query(
      `SELECT
         EXISTS(SELECT 1 FROM friendships f WHERE (f.user_one_id = $1 AND f.user_two_id = $2) OR (f.user_one_id = $2 AND f.user_two_id = $1)) AS is_friend,
         (SELECT id FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2 LIMIT 1) AS outgoing_request_id,
         (SELECT id FROM friend_requests WHERE sender_id = $2 AND receiver_id = $1 LIMIT 1) AS incoming_request_id`,
      [request.user.id, userId]
    );
    const relationship = relationshipResult.rows[0] || {};
    const friendState = relationship.is_friend ? 'friends' : (relationship.incoming_request_id ? 'incoming' : (relationship.outgoing_request_id ? 'requested' : 'none'));
    const contentRestricted = String(user.id) !== String(request.user.id) && Boolean(user.account_private) && !relationship.is_friend;
    response.set('Cache-Control', 'private, no-store');
    response.json({
      id: String(user.id),
      dataNamespace,
      name: user.full_name,
      profilePhoto: user.profile_photo || '',
      coverPhoto: user.cover_photo || '',
      bio: user.bio || '',
      profileDetails: user.profile_details || {},
      createdAt: user.created_at,
      profilePhotoUpdatedAt: user.profile_photo_updated_at,
      coverPhotoUpdatedAt: user.cover_photo_updated_at,
      profileFrameName: user.profile_frame_name || '',
      profileFrameSvg: user.profile_frame_svg || '',
      postCount: contentRestricted ? 0 : Number(user.post_count || 0),
      reelCount: contentRestricted ? 0 : Number(user.reel_count || 0),
      contentCount: contentRestricted ? 0 : Number(user.post_count || 0) + Number(user.reel_count || 0),
      accountPrivate: Boolean(user.account_private),
      contentRestricted,
      friendCount: Number(user.friend_count || 0),
      friendState,
      friendRequestId: relationship.incoming_request_id ? String(relationship.incoming_request_id) : ''
    });
  } catch (error) {
    console.error('User profile load failed:', error.message);
    response.status(500).json({ error: 'Could not load this profile.' });
  }
});

app.put('/api/profile/photo/:kind', requireApiAuth, express.raw({ type: 'image/*', limit: '10mb' }), async (request, response) => {
  const kind = normalizeProfileMediaKind(request.params.kind);
  const mimeType = String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase().replace('image/jpg', 'image/jpeg');
  const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
  const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
  if (!kind || !allowedTypes.has(mimeType) || !bytes.length || bytes.length > 8 * 1024 * 1024) {
    return response.status(400).json({ error: 'Choose a supported image smaller than 8 MB.' });
  }
  const column = kind === 'cover' ? 'cover_photo' : 'profile_photo';
  const updatedColumn = kind === 'cover' ? 'cover_photo_updated_at' : 'profile_photo_updated_at';
  let client;
  try {
    await ensureDatabase();
    client = await pool.connect();
    await client.query('BEGIN');
    const beforeResult = await client.query(
      `SELECT id, profile_photo, cover_photo, created_at, profile_photo_updated_at, cover_photo_updated_at
       FROM users WHERE id = $1 FOR UPDATE`, [request.user.id]
    );
    const before = beforeResult.rows[0];
    if (!before) throw new Error('Account not found.');
    if (before[column]) {
      const oldStored = await storeProfileMediaBinary(client, request.user.id, kind, before[column], before[updatedColumn] || before.created_at);
      await client.query(
        `INSERT INTO profile_media_history (user_id, media_kind, media_version, media_data, created_at)
         VALUES ($1,$2,$3,$4,COALESCE($5,NOW())) ON CONFLICT (user_id, media_kind, media_version) DO NOTHING`,
        [request.user.id, kind, oldStored.version, oldStored.url, before[updatedColumn] || before.created_at]
      );
    }
    const version = crypto.createHash('sha256').update(bytes).digest('hex');
    const url = profileMediaFileUrl(request.user.id, kind, version);
    await client.query(
      `INSERT INTO profile_media_files (user_id, media_kind, media_version, mime_type, image_data, created_at)
       VALUES ($1,$2,$3,$4,$5,NOW()) ON CONFLICT (user_id, media_kind, media_version) DO NOTHING`,
      [request.user.id, kind, version, mimeType, bytes]
    );
    await client.query(
      `INSERT INTO profile_media_history (user_id, media_kind, media_version, media_data, created_at)
       VALUES ($1,$2,$3,$4,NOW()) ON CONFLICT (user_id, media_kind, media_version) DO NOTHING`,
      [request.user.id, kind, version, url]
    );
    const updated = await client.query(
      `UPDATE users SET ${column} = $1, ${updatedColumn} = NOW() WHERE id = $2
       RETURNING profile_photo, cover_photo, profile_photo_updated_at, cover_photo_updated_at`,
      [url, request.user.id]
    );
    await client.query('COMMIT');
    response.json({
      ok: true,
      profilePhoto: updated.rows[0].profile_photo || '',
      coverPhoto: updated.rows[0].cover_photo || '',
      profilePhotoUpdatedAt: updated.rows[0].profile_photo_updated_at,
      coverPhotoUpdatedAt: updated.rows[0].cover_photo_updated_at
    });
  } catch (error) {
    if (client) try { await client.query('ROLLBACK'); } catch (_rollbackError) {}
    console.error('Binary profile photo update failed:', error.message);
    response.status(500).json({ error: 'Could not save the picture.' });
  } finally {
    if (client) client.release();
  }
});

app.put('/api/profile', requireApiAuth, async (request, response) => {
  const profilePhoto = request.body?.profilePhoto;
  const coverPhoto = request.body?.coverPhoto;
  const profileFrameName = request.body?.profileFrameName;
  const profileFrameSvg = request.body?.profileFrameSvg;
  const bio = request.body?.bio;
  const profileDetails = request.body?.profileDetails;
  if (profilePhoto === undefined && coverPhoto === undefined && profileFrameName === undefined && profileFrameSvg === undefined && bio === undefined && profileDetails === undefined) {
    return response.status(400).json({ error: 'No profile changes supplied.' });
  }
  if (!validImageData(profilePhoto) || !validImageData(coverPhoto)) return response.status(400).json({ error: 'Choose a valid image smaller than 6 MB.' });
  if (!validProfileFrame(profileFrameName, profileFrameSvg)) return response.status(400).json({ error: 'Choose a valid profile frame.' });
  if (bio !== undefined && (typeof bio !== 'string' || bio.trim().length > 101)) return response.status(400).json({ error: 'Bio must be 101 characters or fewer.' });
  if (profileDetails !== undefined) {
    if (!profileDetails || typeof profileDetails !== 'object' || Array.isArray(profileDetails)) {
      return response.status(400).json({ error: 'Profile details must be an object.' });
    }
    let profileDetailsSize = 0;
    try { profileDetailsSize = Buffer.byteLength(JSON.stringify(profileDetails), 'utf8'); }
    catch (_error) { return response.status(400).json({ error: 'Profile details are invalid.' }); }
    if (profileDetailsSize > 512 * 1024) {
      return response.status(400).json({ error: 'Profile details are too large.' });
    }
  }
  try {
    await ensureDatabase();
    const beforeResult = await pool.query(
      'SELECT profile_photo, cover_photo, created_at, profile_photo_updated_at, cover_photo_updated_at FROM users WHERE id = $1 LIMIT 1',
      [request.user.id]
    );
    const before = beforeResult.rows[0] || {};
    const storedProfilePhoto = profilePhoto !== undefined && profilePhoto
      ? (await storeProfileMediaBinary(pool, request.user.id, 'profile', profilePhoto, new Date())).url
      : profilePhoto;
    const storedCoverPhoto = coverPhoto !== undefined && coverPhoto
      ? (await storeProfileMediaBinary(pool, request.user.id, 'cover', coverPhoto, new Date())).url
      : coverPhoto;
    async function remember(kind, data, createdAt) {
      if (!data) return;
      const stored = await storeProfileMediaBinary(pool, request.user.id, kind, data, createdAt);
      const version = profileMediaVersion(stored.url);
      await pool.query(
        `INSERT INTO profile_media_history (user_id, media_kind, media_version, media_data, created_at)
         VALUES ($1,$2,$3,$4,COALESCE($5,NOW())) ON CONFLICT (user_id, media_kind, media_version) DO NOTHING`,
        [request.user.id, kind, version, stored.url, createdAt || null]
      );
    }
    if (profilePhoto !== undefined && before.profile_photo && before.profile_photo !== storedProfilePhoto) await remember('profile', before.profile_photo, before.profile_photo_updated_at || before.created_at);
    if (coverPhoto !== undefined && before.cover_photo && before.cover_photo !== storedCoverPhoto) await remember('cover', before.cover_photo, before.cover_photo_updated_at || before.created_at);
    const result = await pool.query(
      `UPDATE users
       SET profile_photo_updated_at = CASE
             WHEN $2::boolean AND profile_photo IS DISTINCT FROM $3 THEN NOW()
             ELSE profile_photo_updated_at
           END,
           cover_photo_updated_at = CASE
             WHEN $4::boolean AND cover_photo IS DISTINCT FROM $5 THEN NOW()
             ELSE cover_photo_updated_at
           END,
           profile_photo = CASE WHEN $2::boolean THEN $3 ELSE profile_photo END,
           cover_photo = CASE WHEN $4::boolean THEN $5 ELSE cover_photo END,
           profile_frame_name = CASE WHEN $6::boolean THEN $7 ELSE profile_frame_name END,
           profile_frame_svg = CASE WHEN $8::boolean THEN $9 ELSE profile_frame_svg END,
           bio = CASE WHEN $10::boolean THEN $11 ELSE bio END,
           profile_details = CASE
             WHEN $12::boolean AND COALESCE((profile_details->>'updatedAt')::bigint,0) <= COALESCE(($13::jsonb->>'updatedAt')::bigint,0)
             THEN $13::jsonb
             ELSE profile_details
           END
       WHERE id = $1
       RETURNING id, full_name, profile_photo, cover_photo, profile_frame_name, profile_frame_svg, bio, profile_details, created_at, profile_photo_updated_at, cover_photo_updated_at`,
      [
        request.user.id,
        profilePhoto !== undefined, storedProfilePhoto || null,
        coverPhoto !== undefined, storedCoverPhoto || null,
        profileFrameName !== undefined, profileFrameName || null,
        profileFrameSvg !== undefined, profileFrameSvg || null,
        bio !== undefined, bio !== undefined ? (bio.trim() || null) : null,
        profileDetails !== undefined, profileDetails !== undefined ? JSON.stringify(profileDetails) : null
      ]
    );
    const user = result.rows[0];
    if (profilePhoto !== undefined && user.profile_photo) await remember('profile', user.profile_photo, user.profile_photo_updated_at || new Date());
    if (coverPhoto !== undefined && user.cover_photo) await remember('cover', user.cover_photo, user.cover_photo_updated_at || new Date());
    response.json({
      ok: true,
      name: user.full_name,
      profilePhoto: user.profile_photo || '',
      coverPhoto: user.cover_photo || '',
      bio: user.bio || '',
      profileDetails: user.profile_details || {},
      createdAt: user.created_at,
      profilePhotoUpdatedAt: user.profile_photo_updated_at,
      coverPhotoUpdatedAt: user.cover_photo_updated_at,
      profileFrameName: user.profile_frame_name || '',
      profileFrameSvg: user.profile_frame_svg || ''
    });
  } catch (error) {
    console.error('Profile update failed:', error.message);
    response.status(500).json({ error: 'Could not save the profile.' });
  }
});

app.get('/api/posts', requireApiAuth, async (request, response) => {
  try {
    await ensureDatabase();
    const result = await pool.query(`
      WITH like_counts AS (
        SELECT post_id, COUNT(*)::int AS like_count FROM post_likes GROUP BY post_id
      ), share_counts AS (
        SELECT post_id, COUNT(*)::int AS share_count FROM post_shares GROUP BY post_id
      ), my_likes AS (
        SELECT post_id FROM post_likes WHERE user_id = $1
      )
      SELECT p.id, p.user_id, p.body, p.image_data, p.media_items, p.post_extras, p.visibility, p.created_at, u.full_name, u.profile_photo,
             COALESCE(lc.like_count, 0)::int AS like_count,
             COALESCE(sc.share_count, 0)::int AS share_count,
             (ml.post_id IS NOT NULL) AS liked_by_me
      FROM posts p
      JOIN users u ON u.id = p.user_id
      LEFT JOIN like_counts lc ON lc.post_id = p.id
      LEFT JOIN share_counts sc ON sc.post_id = p.id
      LEFT JOIN my_likes ml ON ml.post_id = p.id
      WHERE p.user_id = $1
         OR (
           p.visibility <> 'only-me'
           AND (
             NOT COALESCE(u.account_private, FALSE)
             OR EXISTS (
               SELECT 1 FROM friendships f
               WHERE (f.user_one_id = $1 AND f.user_two_id = p.user_id)
                  OR (f.user_one_id = p.user_id AND f.user_two_id = $1)
             )
           )
           AND p.id IN (
             SELECT recent.id FROM posts recent
             WHERE recent.user_id <> $1
             ORDER BY recent.created_at DESC
             LIMIT 50
           )
         )
      ORDER BY p.created_at DESC
    `, [request.user.id]);
    const commentsByPost = new Map();
    if (result.rows.length) {
      const ids = result.rows.map(row => String(row.id));
      const placeholders = ids.map((_id, index) => `$${index + 1}`).join(',');
      const commentResult = await pool.query(
        `SELECT pc.id, pc.post_id, pc.user_id, pc.parent_comment_id, pc.body, pc.media_data, pc.media_type, pc.created_at,
                u.full_name, u.profile_photo, parent_user.full_name AS reply_to_author
         FROM post_comments pc
         JOIN users u ON u.id = pc.user_id
         LEFT JOIN post_comments parent_comment ON parent_comment.id = pc.parent_comment_id
         LEFT JOIN users parent_user ON parent_user.id = parent_comment.user_id
         WHERE pc.post_id IN (${placeholders})
         ORDER BY pc.created_at`,
        ids
      );
      commentResult.rows.forEach(row => {
        const key = String(row.post_id);
        if (!commentsByPost.has(key)) commentsByPost.set(key, []);
        commentsByPost.get(key).push({
          id: String(row.id),
          userId: String(row.user_id),
          author: row.full_name,
          profilePhoto: row.profile_photo || '',
          parentCommentId: row.parent_comment_id ? String(row.parent_comment_id) : null,
          replyToAuthor: row.reply_to_author || '',
          mediaData: row.media_data || '',
          mediaType: row.media_type || '',
          body: row.body,
          createdAt: row.created_at
        });
      });
    }
    const mediaStatsByPost = new Map();
    if (result.rows.length) {
      const ids = result.rows.map(row => String(row.id));
      const statsResult = await pool.query(
        `WITH media_keys AS (
           SELECT p.id AS post_id, (series.value - 1)::int AS media_index
           FROM posts p
           CROSS JOIN LATERAL generate_series(1, CASE WHEN jsonb_array_length(COALESCE(p.media_items, '[]'::jsonb)) > 0 THEN jsonb_array_length(p.media_items) WHEN p.image_data IS NOT NULL AND p.image_data <> '' THEN 1 ELSE 0 END) AS series(value)
           WHERE p.id = ANY($2::bigint[])
         ), like_counts AS (
           SELECT post_id, media_index, COUNT(*)::int AS count
           FROM post_media_likes WHERE post_id = ANY($2::bigint[]) GROUP BY post_id, media_index
         ), share_counts AS (
           SELECT post_id, media_index, COUNT(*)::int AS count
           FROM post_media_shares WHERE post_id = ANY($2::bigint[]) GROUP BY post_id, media_index
         ), comment_counts AS (
           SELECT post_id, media_index, COUNT(*)::int AS count
           FROM post_media_comments WHERE post_id = ANY($2::bigint[]) GROUP BY post_id, media_index
         ), my_likes AS (
           SELECT post_id, media_index FROM post_media_likes WHERE user_id = $1 AND post_id = ANY($2::bigint[])
         )
         SELECT mk.post_id, mk.media_index,
                COALESCE(lc.count, 0)::int AS like_count,
                COALESCE(sc.count, 0)::int AS share_count,
                COALESCE(cc.count, 0)::int AS comment_count,
                (ml.post_id IS NOT NULL) AS liked_by_me
         FROM media_keys mk
         LEFT JOIN like_counts lc ON lc.post_id = mk.post_id AND lc.media_index = mk.media_index
         LEFT JOIN share_counts sc ON sc.post_id = mk.post_id AND sc.media_index = mk.media_index
         LEFT JOIN comment_counts cc ON cc.post_id = mk.post_id AND cc.media_index = mk.media_index
         LEFT JOIN my_likes ml ON ml.post_id = mk.post_id AND ml.media_index = mk.media_index
         ORDER BY mk.post_id, mk.media_index`,
        [request.user.id, ids]
      );
      statsResult.rows.forEach(row => {
        const key = String(row.post_id);
        if (!mediaStatsByPost.has(key)) mediaStatsByPost.set(key, []);
        mediaStatsByPost.get(key)[Number(row.media_index)] = {
          likeCount: Number(row.like_count || 0),
          shareCount: Number(row.share_count || 0),
          commentCount: Number(row.comment_count || 0),
          likedByMe: Boolean(row.liked_by_me)
        };
      });
    }
    const sourceReelsByPost = new Map();
    if (result.rows.length) {
      const ids = result.rows.map(row => String(row.id));
      const sourceResult = await pool.query(
        'SELECT id, source_post_id, source_media_index FROM reels WHERE source_post_id = ANY($1::bigint[])',
        [ids]
      );
      sourceResult.rows.forEach(row => {
        const key = String(row.source_post_id);
        if (!sourceReelsByPost.has(key)) sourceReelsByPost.set(key, new Map());
        sourceReelsByPost.get(key).set(Number(row.source_media_index), String(row.id));
      });
    }
    response.json({ posts: result.rows.map(row => ({
      id: String(row.id),
      userId: String(row.user_id),
      body: row.body,
      image: row.image_data || '',
      contentKey: `post:${row.id}`,
      media: normalizeStoredPostMedia(row.media_items, row.image_data || '').map((item, index) => ({
        ...item,
        reelId: sourceReelsByPost.get(String(row.id))?.get(index) || item.reelId || '',
        contentKey: `post:${row.id}:media:${index}`
      })),
      extras: row.post_extras && typeof row.post_extras === 'object' ? row.post_extras : {},
      visibility: row.visibility || 'public',
      createdAt: row.created_at,
      author: row.full_name,
      profilePhoto: row.profile_photo || '',
      likeCount: Number(row.like_count || 0),
      shareCount: Number(row.share_count || 0),
      likedByMe: Boolean(row.liked_by_me),
      mediaStats: mediaStatsByPost.get(String(row.id)) || [],
      comments: commentsByPost.get(String(row.id)) || []
    })) });
  } catch (error) {
    console.error('Posts load failed:', error.message);
    response.status(500).json({ error: 'Could not load posts.' });
  }
});

app.post('/api/posts', requireApiAuth, async (request, response) => {
  const body = String(request.body?.body || '').trim();
  const visibility = String(request.body?.visibility || 'public').trim().toLowerCase();
  const mediaWasProvided = Object.prototype.hasOwnProperty.call(request.body || {}, 'media');
  const legacyImage = String(request.body?.image || '');
  const mediaResult = mediaWasProvided
    ? validatePostMedia(request.body.media)
    : validatePostMedia(legacyImage ? [{ data: legacyImage }] : []);
  if (mediaResult.error) return response.status(400).json({ error: mediaResult.error });
  const media = mediaResult.media;
  const extrasResult = validatePostExtras(request.body?.extras);
  if (extrasResult.error) return response.status(400).json({ error: extrasResult.error });
  const extras = extrasResult.extras;
  if (!body && !media.length && !postExtrasHasContent(extras)) return response.status(400).json({ error: 'Add text, media, a feeling, location, sound, or sticker.' });
  if (body.length > 5000) return response.status(400).json({ error: 'Post text is too long.' });
  if (!['public','friends','only-me'].includes(visibility)) return response.status(400).json({ error: 'Choose a valid post audience.' });
  const firstImage = media.find(item => item.type === 'image')?.data || null;
  try {
    await ensureDatabase();
    const client = await pool.connect();
    let post;
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `INSERT INTO posts (user_id, body, image_data, media_items, post_extras, visibility)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)
         RETURNING id, body, image_data, media_items, post_extras, visibility, created_at`,
        [request.user.id, body, firstImage, JSON.stringify(media), JSON.stringify(extras), visibility]
      );
      post = result.rows[0];
      post._linkedReels = await syncPostVideoReels(client, {
        postId: post.id, userId: request.user.id, caption: body, visibility,
        createdAt: post.created_at, media
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await createMentionNotifications(pool, request.user.id, body, post.id);
    response.status(201).json({ ok: true, post: {
      ...post,
      contentKey: `post:${post.id}`,
      media: normalizeStoredPostMedia(post.media_items, post.image_data || '').map((item, index) => ({
        ...item,
        reelId: post._linkedReels?.find(link => link.mediaIndex === index)?.id || '',
        contentKey: `post:${post.id}:media:${index}`
      })),
      extras: post.post_extras && typeof post.post_extras === 'object' ? post.post_extras : {}
    } });
  } catch (error) {
    console.error('Post creation failed:', error.message);
    response.status(500).json({ error: 'Could not save the post.' });
  }
});

app.patch('/api/posts/:postId', requireApiAuth, async (request, response) => {
  const postId = request.params.postId;
  if (!validNumericId(postId)) return response.status(400).json({ error: 'Invalid post.' });
  const body = String(request.body?.body || '').trim();
  const visibility = String(request.body?.visibility || 'public').trim().toLowerCase();
  const mediaWasProvided = Object.prototype.hasOwnProperty.call(request.body || {}, 'media');
  const imageWasProvided = Object.prototype.hasOwnProperty.call(request.body || {}, 'image');
  const extrasWereProvided = Object.prototype.hasOwnProperty.call(request.body || {}, 'extras');
  let providedExtras = null;
  if (extrasWereProvided) {
    const validation = validatePostExtras(request.body?.extras);
    if (validation.error) return response.status(400).json({ error: validation.error });
    providedExtras = validation.extras;
  }
  if (body.length > 5000) return response.status(400).json({ error: 'Post text is too long.' });
  if (!['public', 'friends', 'only-me'].includes(visibility)) return response.status(400).json({ error: 'Choose a valid post audience.' });
  let providedMedia = null;
  if (mediaWasProvided) {
    const validation = validatePostMedia(request.body.media);
    if (validation.error) return response.status(400).json({ error: validation.error });
    providedMedia = validation.media;
  } else if (imageWasProvided) {
    const image = String(request.body?.image || '');
    const validation = validatePostMedia(image ? [{ data: image }] : []);
    if (validation.error) return response.status(400).json({ error: validation.error });
    providedMedia = validation.media;
  }
  try {
    await ensureDatabase();
    const current = await pool.query('SELECT image_data, media_items, post_extras FROM posts WHERE id = $1 AND user_id = $2 LIMIT 1', [postId, request.user.id]);
    if (!current.rowCount) return response.status(404).json({ error: 'Post not found.' });
    const finalMedia = providedMedia === null
      ? normalizeStoredPostMedia(current.rows[0].media_items, current.rows[0].image_data || '')
      : providedMedia;
    const finalExtras = providedExtras === null
      ? (current.rows[0].post_extras && typeof current.rows[0].post_extras === 'object' ? current.rows[0].post_extras : {})
      : providedExtras;
    if (!body && !finalMedia.length && !postExtrasHasContent(finalExtras)) return response.status(400).json({ error: 'Add text, media, a feeling, location, sound, or sticker.' });
    const firstImage = finalMedia.find(item => item.type === 'image')?.data || null;
    const result = await pool.query(
      `UPDATE posts
       SET body = $1, image_data = $2, media_items = $3::jsonb, post_extras = $4::jsonb, visibility = $5
       WHERE id = $6 AND user_id = $7
       RETURNING id, user_id, body, image_data, media_items, post_extras, visibility, created_at`,
      [body, firstImage, JSON.stringify(finalMedia), JSON.stringify(finalExtras), visibility, postId, request.user.id]
    );
    const post = result.rows[0];
    post._linkedReels = await syncPostVideoReels(pool, {
      postId: post.id, userId: request.user.id, caption: body, visibility,
      createdAt: post.created_at, media: finalMedia
    });
    if (providedMedia !== null) {
      await Promise.all([
        pool.query('DELETE FROM post_media_likes WHERE post_id = $1', [postId]),
        pool.query('DELETE FROM post_media_shares WHERE post_id = $1', [postId]),
        pool.query('DELETE FROM post_media_comments WHERE post_id = $1', [postId])
      ]);
    }
    response.json({ ok: true, post: {
      ...post,
      contentKey: `post:${post.id}`,
      media: normalizeStoredPostMedia(post.media_items, post.image_data || '').map((item, index) => ({
        ...item,
        reelId: post._linkedReels?.find(link => link.mediaIndex === index)?.id || '',
        contentKey: `post:${post.id}:media:${index}`
      })),
      extras: post.post_extras && typeof post.post_extras === 'object' ? post.post_extras : {}
    } });
  } catch (error) {
    console.error('Post update failed:', error.message);
    response.status(500).json({ error: 'Could not update the post.' });
  }
});

async function archivePostForAdmin(queryable, postId, userId) {
  const post = await queryable.query('SELECT * FROM posts WHERE id=$1 AND user_id=$2 LIMIT 1', [postId, userId]);
  if (!post.rowCount) return false;
  const [comments, mediaComments, likes, mediaLikes, linkedReels] = await Promise.all([
    queryable.query('SELECT * FROM post_comments WHERE post_id=$1 ORDER BY created_at', [postId]),
    queryable.query('SELECT * FROM post_media_comments WHERE post_id=$1 ORDER BY created_at', [postId]),
    queryable.query('SELECT * FROM post_likes WHERE post_id=$1 ORDER BY created_at', [postId]),
    queryable.query('SELECT * FROM post_media_likes WHERE post_id=$1 ORDER BY created_at', [postId]),
    queryable.query('SELECT * FROM reels WHERE source_post_id=$1 ORDER BY created_at', [postId])
  ]);
  const content = { post:post.rows[0], comments:comments.rows, mediaComments:mediaComments.rows, likes:likes.rows, mediaLikes:mediaLikes.rows, reels:linkedReels.rows };
  await queryable.query('INSERT INTO admin_deleted_content (user_id, content_type, original_id, content) VALUES ($1,$2,$3,$4::jsonb)', [userId, 'post', String(postId), JSON.stringify(content)]);
  return true;
}

async function archiveReelForAdmin(queryable, reelId, userId) {
  const reel = await queryable.query('SELECT * FROM reels WHERE id=$1 AND user_id=$2 LIMIT 1', [reelId, userId]);
  if (!reel.rowCount) return false;
  const [comments, likes, views] = await Promise.all([
    queryable.query('SELECT * FROM reel_comments WHERE reel_id=$1 ORDER BY created_at', [reelId]),
    queryable.query('SELECT * FROM reel_likes WHERE reel_id=$1 ORDER BY created_at', [reelId]),
    queryable.query('SELECT * FROM reel_views WHERE reel_id=$1 ORDER BY viewed_at', [reelId])
  ]);
  await queryable.query('INSERT INTO admin_deleted_content (user_id, content_type, original_id, content) VALUES ($1,$2,$3,$4::jsonb)', [userId, 'reel', String(reelId), JSON.stringify({ reel:reel.rows[0], comments:comments.rows, likes:likes.rows, views:views.rows })]);
  return true;
}

app.delete('/api/posts/:postId', requireApiAuth, async (request, response) => {
  const postId = request.params.postId;
  if (!validNumericId(postId)) return response.status(400).json({ error: 'Invalid post.' });
  try {
    await ensureDatabase();
    const linked = await pool.query('SELECT id FROM reels WHERE source_post_id = $1 ORDER BY id', [postId]);
    await archivePostForAdmin(pool, postId, request.user.id);
    const result = await pool.query('DELETE FROM posts WHERE id = $1 AND user_id = $2 RETURNING id', [postId, request.user.id]);
    if (!result.rowCount) return response.status(404).json({ error: 'Post not found.' });
    response.json({ ok: true, postId: String(result.rows[0].id), reelIds: linked.rows.map(row => String(row.id)) });
  } catch (error) {
    console.error('Post delete failed:', error.message);
    response.status(500).json({ error: 'Could not delete the post.' });
  }
});

app.post('/api/posts/:postId/like', requireApiAuth, async (request, response) => {
  const postId = request.params.postId;
  if (!validNumericId(postId)) return response.status(400).json({ error: 'Invalid post.' });
  try {
    await ensureDatabase();
    const removed = await pool.query('DELETE FROM post_likes WHERE post_id = $1 AND user_id = $2 RETURNING post_id', [postId, request.user.id]);
    let liked = false;
    if (!removed.rowCount) {
      await pool.query('INSERT INTO post_likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [postId, request.user.id]);
      liked = true;
    }
    const owner = await pool.query('SELECT user_id FROM posts WHERE id = $1 LIMIT 1', [postId]);
    if (!owner.rows[0]) return response.status(404).json({ error: 'Post not found.' });
    if (liked) {
      await createNotification(pool, { userId: owner.rows[0].user_id, actorId: request.user.id, type: 'post_like', postId });
    } else {
      await pool.query(
        "DELETE FROM notifications WHERE user_id = $1 AND actor_id = $2 AND type = 'post_like' AND post_id = $3",
        [owner.rows[0].user_id, request.user.id, postId]
      );
    }
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM post_likes WHERE post_id = $1', [postId]);
    response.json({ ok: true, liked, likeCount: Number(count.rows[0].count) });
  } catch (error) {
    if (error.code === '23503') return response.status(404).json({ error: 'Post not found.' });
    console.error('Post like failed:', error.message);
    response.status(500).json({ error: 'Could not update the like.' });
  }
});

app.post('/api/posts/:postId/share', requireApiAuth, async (request, response) => {
  const postId = request.params.postId;
  if (!validNumericId(postId)) return response.status(400).json({ error: 'Invalid post.' });
  try {
    await ensureDatabase();
    await pool.query(
      `INSERT INTO post_shares (post_id, user_id, shared_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (post_id, user_id) DO UPDATE SET shared_at = EXCLUDED.shared_at`,
      [postId, request.user.id]
    );
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM post_shares WHERE post_id = $1', [postId]);
    response.json({ ok: true, shareCount: Number(count.rows[0].count) });
  } catch (error) {
    if (error.code === '23503') return response.status(404).json({ error: 'Post not found.' });
    console.error('Post share failed:', error.message);
    response.status(500).json({ error: 'Could not update the share.' });
  }
});

app.get('/api/posts/:postId/comments', requireApiAuth, async (request, response) => {
  const postId = request.params.postId;
  if (!validNumericId(postId)) return response.status(400).json({ error: 'Invalid post.' });
  try {
    await ensureDatabase();
    const post = await pool.query('SELECT id FROM posts WHERE id = $1 LIMIT 1', [postId]);
    if (!post.rows[0]) return response.status(404).json({ error: 'Post not found.' });
    const result = await pool.query(
      `SELECT pc.id, pc.user_id, pc.parent_comment_id, pc.body, pc.media_data, pc.media_type, pc.created_at,
              u.full_name, u.profile_photo, parent_user.full_name AS reply_to_author
       FROM post_comments pc
       JOIN users u ON u.id = pc.user_id
       LEFT JOIN post_comments parent_comment ON parent_comment.id = pc.parent_comment_id
       LEFT JOIN users parent_user ON parent_user.id = parent_comment.user_id
       WHERE pc.post_id = $1
       ORDER BY pc.created_at`,
      [postId]
    );
    response.json({ comments: result.rows.map(row => ({
      id: String(row.id),
      userId: String(row.user_id),
      author: row.full_name,
      profilePhoto: row.profile_photo || '',
      parentCommentId: row.parent_comment_id ? String(row.parent_comment_id) : null,
      replyToAuthor: row.reply_to_author || '',
      mediaData: row.media_data || '',
      mediaType: row.media_type || '',
      body: row.body,
      createdAt: row.created_at
    })) });
  } catch (error) {
    console.error('Post comments load failed:', error.message);
    response.status(500).json({ error: 'Could not load comments.' });
  }
});

app.post('/api/posts/:postId/comments', requireApiAuth, async (request, response) => {
  const postId = request.params.postId;
  const body = String(request.body?.body || '').trim();
  const parentCommentId = request.body?.parentCommentId == null || request.body?.parentCommentId === '' ? null : String(request.body.parentCommentId);
  const media = normalizeCommentMedia(request.body?.mediaData, request.body?.mediaType);
  if (!validNumericId(postId)) return response.status(400).json({ error: 'Invalid post.' });
  if (parentCommentId && !validNumericId(parentCommentId)) return response.status(400).json({ error: 'Invalid reply target.' });
  if (media.error) return response.status(400).json({ error: media.error });
  if ((!body && !media.data) || body.length > 1000) return response.status(400).json({ error: 'Write a comment or add media.' });
  try {
    await ensureDatabase();
    let replyToAuthor = '';
    if (parentCommentId) {
      const parent = await pool.query(
        `SELECT pc.id, u.full_name FROM post_comments pc JOIN users u ON u.id = pc.user_id WHERE pc.id = $1 AND pc.post_id = $2 LIMIT 1`,
        [parentCommentId, postId]
      );
      if (!parent.rows[0]) return response.status(404).json({ error: 'The comment you replied to was not found.' });
      replyToAuthor = parent.rows[0].full_name || '';
    }
    const result = await pool.query(
      `INSERT INTO post_comments (post_id, user_id, parent_comment_id, body, media_data, media_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, parent_comment_id, body, media_data, media_type, created_at`,
      [postId, request.user.id, parentCommentId, body, media.data || null, media.type || null]
    );
    const comment = result.rows[0];
    const commenter = await pool.query('SELECT profile_photo FROM users WHERE id = $1 LIMIT 1', [request.user.id]);
    const owner = await pool.query('SELECT user_id FROM posts WHERE id = $1 LIMIT 1', [postId]);
    if (owner.rows[0]) {
      await createNotification(pool, { userId: owner.rows[0].user_id, actorId: request.user.id, type: 'post_comment', postId, detail: body, commentId: comment.id });
      await createMentionNotifications(pool, request.user.id, body, postId, comment.id);
    }
    response.status(201).json({ ok: true, comment: {
      id: String(comment.id), userId: String(comment.user_id), author: request.user.name,
      profilePhoto: commenter.rows[0]?.profile_photo || '',
      parentCommentId: comment.parent_comment_id ? String(comment.parent_comment_id) : null,
      replyToAuthor, mediaData: comment.media_data || '', mediaType: comment.media_type || '',
      body: comment.body, createdAt: comment.created_at
    } });
  } catch (error) {
    if (error.code === '23503') return response.status(404).json({ error: 'Post or reply target not found.' });
    console.error('Post comment failed:', error.message);
    response.status(500).json({ error: 'Could not add the comment.' });
  }
});


async function postMediaExists(postId, mediaIndex) {
  const result = await pool.query(
    `SELECT id FROM posts
     WHERE id = $1
       AND (
         jsonb_array_length(COALESCE(media_items, '[]'::jsonb)) > $2
         OR (jsonb_array_length(COALESCE(media_items, '[]'::jsonb)) = 0 AND image_data IS NOT NULL AND image_data <> '' AND $2 = 0)
       )
     LIMIT 1`,
    [postId, mediaIndex]
  );
  return Boolean(result.rows[0]);
}

app.post('/api/posts/:postId/media/:mediaIndex/like', requireApiAuth, async (request, response) => {
  const postId = request.params.postId;
  const mediaIndex = Number(request.params.mediaIndex);
  if (!validNumericId(postId) || !Number.isInteger(mediaIndex) || mediaIndex < 0) return response.status(400).json({ error: 'Invalid post media.' });
  try {
    await ensureDatabase();
    if (!(await postMediaExists(postId, mediaIndex))) return response.status(404).json({ error: 'Post media not found.' });
    const removed = await pool.query(
      'DELETE FROM post_media_likes WHERE post_id = $1 AND media_index = $2 AND user_id = $3 RETURNING post_id',
      [postId, mediaIndex, request.user.id]
    );
    let liked = false;
    if (!removed.rowCount) {
      await pool.query(
        'INSERT INTO post_media_likes (post_id, media_index, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
        [postId, mediaIndex, request.user.id]
      );
      liked = true;
    }
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM post_media_likes WHERE post_id = $1 AND media_index = $2', [postId, mediaIndex]);
    response.json({ ok: true, liked, likeCount: Number(count.rows[0].count) });
  } catch (error) {
    console.error('Post media like failed:', error.message);
    response.status(500).json({ error: 'Could not update the media like.' });
  }
});

app.post('/api/posts/:postId/media/:mediaIndex/share', requireApiAuth, async (request, response) => {
  const postId = request.params.postId;
  const mediaIndex = Number(request.params.mediaIndex);
  if (!validNumericId(postId) || !Number.isInteger(mediaIndex) || mediaIndex < 0) return response.status(400).json({ error: 'Invalid post media.' });
  try {
    await ensureDatabase();
    if (!(await postMediaExists(postId, mediaIndex))) return response.status(404).json({ error: 'Post media not found.' });
    await pool.query(
      `INSERT INTO post_media_shares (post_id, media_index, user_id, shared_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (post_id, media_index, user_id) DO UPDATE SET shared_at = EXCLUDED.shared_at`,
      [postId, mediaIndex, request.user.id]
    );
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM post_media_shares WHERE post_id = $1 AND media_index = $2', [postId, mediaIndex]);
    response.json({ ok: true, shareCount: Number(count.rows[0].count) });
  } catch (error) {
    console.error('Post media share failed:', error.message);
    response.status(500).json({ error: 'Could not update the media share.' });
  }
});

app.get('/api/posts/:postId/media/:mediaIndex/comments', requireApiAuth, async (request, response) => {
  const postId = request.params.postId;
  const mediaIndex = Number(request.params.mediaIndex);
  if (!validNumericId(postId) || !Number.isInteger(mediaIndex) || mediaIndex < 0) return response.status(400).json({ error: 'Invalid post media.' });
  try {
    await ensureDatabase();
    if (!(await postMediaExists(postId, mediaIndex))) return response.status(404).json({ error: 'Post media not found.' });
    const result = await pool.query(
      `SELECT pmc.id, pmc.user_id, pmc.parent_comment_id, pmc.body, pmc.media_data, pmc.media_type, pmc.created_at,
              u.full_name, u.profile_photo, parent_user.full_name AS reply_to_author
       FROM post_media_comments pmc
       JOIN users u ON u.id = pmc.user_id
       LEFT JOIN post_media_comments parent_comment ON parent_comment.id = pmc.parent_comment_id
       LEFT JOIN users parent_user ON parent_user.id = parent_comment.user_id
       WHERE pmc.post_id = $1 AND pmc.media_index = $2
       ORDER BY pmc.created_at`,
      [postId, mediaIndex]
    );
    response.json({ comments: result.rows.map(row => ({
      id: String(row.id), userId: String(row.user_id), author: row.full_name,
      profilePhoto: row.profile_photo || '',
      parentCommentId: row.parent_comment_id ? String(row.parent_comment_id) : null,
      replyToAuthor: row.reply_to_author || '', mediaData: row.media_data || '', mediaType: row.media_type || '',
      body: row.body, createdAt: row.created_at
    })) });
  } catch (error) {
    console.error('Post media comments load failed:', error.message);
    response.status(500).json({ error: 'Could not load media comments.' });
  }
});

app.post('/api/posts/:postId/media/:mediaIndex/comments', requireApiAuth, async (request, response) => {
  const postId = request.params.postId;
  const mediaIndex = Number(request.params.mediaIndex);
  const body = String(request.body?.body || '').trim();
  const parentCommentId = request.body?.parentCommentId == null || request.body?.parentCommentId === '' ? null : String(request.body.parentCommentId);
  const media = normalizeCommentMedia(request.body?.mediaData, request.body?.mediaType);
  if (!validNumericId(postId) || !Number.isInteger(mediaIndex) || mediaIndex < 0) return response.status(400).json({ error: 'Invalid post media.' });
  if (parentCommentId && !validNumericId(parentCommentId)) return response.status(400).json({ error: 'Invalid reply target.' });
  if (media.error) return response.status(400).json({ error: media.error });
  if ((!body && !media.data) || body.length > 1000) return response.status(400).json({ error: 'Write a comment or add media.' });
  try {
    await ensureDatabase();
    if (!(await postMediaExists(postId, mediaIndex))) return response.status(404).json({ error: 'Post media not found.' });
    let replyToAuthor = '';
    if (parentCommentId) {
      const parent = await pool.query(
        `SELECT pmc.id, u.full_name
         FROM post_media_comments pmc JOIN users u ON u.id = pmc.user_id
         WHERE pmc.id = $1 AND pmc.post_id = $2 AND pmc.media_index = $3 LIMIT 1`,
        [parentCommentId, postId, mediaIndex]
      );
      if (!parent.rows[0]) return response.status(404).json({ error: 'The comment you replied to was not found.' });
      replyToAuthor = parent.rows[0].full_name || '';
    }
    const result = await pool.query(
      `INSERT INTO post_media_comments (post_id, media_index, user_id, parent_comment_id, body, media_data, media_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id, parent_comment_id, body, media_data, media_type, created_at`,
      [postId, mediaIndex, request.user.id, parentCommentId, body, media.data || null, media.type || null]
    );
    const comment = result.rows[0];
    const commenter = await pool.query('SELECT profile_photo FROM users WHERE id = $1 LIMIT 1', [request.user.id]);
    const owner = await pool.query('SELECT user_id FROM posts WHERE id = $1 LIMIT 1', [postId]);
    if (owner.rows[0]) {
      await createNotification(pool, { userId: owner.rows[0].user_id, actorId: request.user.id, type: 'post_comment', postId, detail: body });
      await createMentionNotifications(pool, request.user.id, body, postId);
    }
    response.status(201).json({ ok: true, comment: {
      id: String(comment.id), userId: String(comment.user_id), author: request.user.name,
      profilePhoto: commenter.rows[0]?.profile_photo || '',
      parentCommentId: comment.parent_comment_id ? String(comment.parent_comment_id) : null,
      replyToAuthor, mediaData: comment.media_data || '', mediaType: comment.media_type || '',
      body: comment.body, createdAt: comment.created_at
    } });
  } catch (error) {
    console.error('Post media comment failed:', error.message);
    response.status(500).json({ error: 'Could not add the media comment.' });
  }
});


function normalizeProfileMediaKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  return kind === 'profile' || kind === 'cover' ? kind : '';
}

function profileMediaVersion(data) {
  const urlMatch = String(data || '').match(/^\/api\/profile-media-file\/\d+\/(?:profile|cover)\/([a-f0-9]{64})$/i);
  if (urlMatch) return urlMatch[1].toLowerCase();
  return crypto.createHash('sha256').update(String(data || '')).digest('hex');
}

function profileMediaFileUrl(ownerUserId, kind, version) {
  return `/api/profile-media-file/${encodeURIComponent(String(ownerUserId))}/${kind}/${version}`;
}

async function storeProfileMediaBinary(queryable, ownerUserId, kind, source, createdAt, forcedVersion) {
  const value = String(source || '');
  const existing = value.match(/^\/api\/profile-media-file\/\d+\/(profile|cover)\/([a-f0-9]{64})$/i);
  if (existing) return { url: value, version: existing[2].toLowerCase() };
  const match = value.match(/^data:(image\/(?:png|jpe?g|webp|gif|avif));base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return { url: value, version: forcedVersion || profileMediaVersion(value) };
  const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  const version = String(forcedVersion || profileMediaVersion(value));
  const url = profileMediaFileUrl(ownerUserId, kind, version);
  await queryable.query(
    `INSERT INTO profile_media_files (user_id, media_kind, media_version, mime_type, image_data, created_at)
     VALUES ($1,$2,$3,$4,$5,COALESCE($6,NOW())) ON CONFLICT (user_id, media_kind, media_version) DO NOTHING`,
    [ownerUserId, kind, version, match[1].toLowerCase().replace('image/jpg', 'image/jpeg'), bytes, createdAt || null]
  );
  await queryable.query(
    `UPDATE profile_media_history SET media_data = $4
     WHERE user_id = $1 AND media_kind = $2 AND media_version = $3 AND media_data <> $4`,
    [ownerUserId, kind, version, url]
  );
  return { url, version };
}

async function migrateCurrentProfileMedia(user, kind) {
  const column = kind === 'cover' ? 'cover_photo' : 'profile_photo';
  const updatedColumn = kind === 'cover' ? 'cover_photo_updated_at' : 'profile_photo_updated_at';
  const source = user && user[column];
  if (!source || !String(source).startsWith('data:image/')) return source || '';
  const stored = await storeProfileMediaBinary(pool, user.id, kind, source, user[updatedColumn] || user.created_at);
  await pool.query(`UPDATE users SET ${column} = $1 WHERE id = $2 AND ${column} = $3`, [stored.url, user.id, source]);
  user[column] = stored.url;
  return stored.url;
}

async function ensureCurrentProfileMediaHistory(ownerUserId, kind) {
  const result = await pool.query(
    `SELECT id, full_name, profile_photo, cover_photo, created_at, profile_photo_updated_at, cover_photo_updated_at
     FROM users WHERE id = $1 LIMIT 1`, [ownerUserId]
  );
  const user = result.rows[0];
  if (!user) return null;
  const source = kind === 'cover' ? (user.cover_photo || '') : (user.profile_photo || '');
  if (source) {
    const version = profileMediaVersion(source);
    const createdAt = kind === 'cover' ? (user.cover_photo_updated_at || user.created_at) : (user.profile_photo_updated_at || user.created_at);
    await pool.query(
      `INSERT INTO profile_media_history (user_id, media_kind, media_version, media_data, created_at)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id, media_kind, media_version) DO NOTHING`,
      [ownerUserId, kind, version, source, createdAt]
    );
  }
  return user;
}

async function currentProfileMedia(ownerUserId, kind, requestedVersion) {
  const user = await ensureCurrentProfileMediaHistory(ownerUserId, kind);
  if (!user) return null;
  const currentSource = kind === 'cover' ? (user.cover_photo || '') : (user.profile_photo || '');
  const currentVersion = currentSource ? profileMediaVersion(currentSource) : '';
  let source = currentSource;
  let version = currentVersion;
  let createdAt = kind === 'cover' ? (user.cover_photo_updated_at || user.created_at) : (user.profile_photo_updated_at || user.created_at);
  if (requestedVersion && requestedVersion !== currentVersion) {
    const history = await pool.query(
      'SELECT media_data, media_version, created_at FROM profile_media_history WHERE user_id = $1 AND media_kind = $2 AND media_version = $3 LIMIT 1',
      [ownerUserId, kind, requestedVersion]
    );
    if (!history.rows[0]) return null;
    source = history.rows[0].media_data;
    version = history.rows[0].media_version;
    createdAt = history.rows[0].created_at;
  }
  if (!source) return null;
  if (String(source).startsWith('data:image/')) {
    const stored = await storeProfileMediaBinary(pool, ownerUserId, kind, source, createdAt, version);
    source = stored.url;
    if (version === currentVersion) {
      const column = kind === 'cover' ? 'cover_photo' : 'profile_photo';
      await pool.query(`UPDATE users SET ${column} = $1 WHERE id = $2 AND ${column} <> $1`, [source, ownerUserId]);
      if (kind === 'profile') user.profile_photo = source;
    }
  }
  return {
    ownerId: String(user.id), ownerName: user.full_name, profilePhoto: user.profile_photo || '',
    source, version, createdAt, isCurrent: version === currentVersion, currentVersion
  };
}

async function profileMediaComments(ownerId, kind, version) {
  const result = await pool.query(
    `SELECT pmc.id, pmc.user_id, pmc.parent_comment_id, pmc.body, pmc.media_data, pmc.media_type, pmc.created_at,
            u.full_name, u.profile_photo, parent_user.full_name AS reply_to_author
     FROM profile_media_comments pmc
     JOIN users u ON u.id = pmc.user_id
     LEFT JOIN profile_media_comments parent_comment ON parent_comment.id = pmc.parent_comment_id
     LEFT JOIN users parent_user ON parent_user.id = parent_comment.user_id
     WHERE pmc.owner_user_id = $1 AND pmc.media_kind = $2 AND pmc.media_version = $3
     ORDER BY pmc.created_at`,
    [ownerId, kind, version]
  );
  return result.rows.map(row => ({
    id: String(row.id), userId: String(row.user_id), author: row.full_name,
    profilePhoto: row.profile_photo || '',
    parentCommentId: row.parent_comment_id ? String(row.parent_comment_id) : null,
    replyToAuthor: row.reply_to_author || '', mediaData: row.media_data || '', mediaType: row.media_type || '',
    body: row.body, createdAt: row.created_at
  }));
}

app.get('/api/profile-media-file/:ownerId/:kind/:version', requireApiAuth, async (request, response) => {
  const ownerId = request.params.ownerId;
  const kind = normalizeProfileMediaKind(request.params.kind);
  const version = String(request.params.version || '');
  if (!validNumericId(ownerId) || !kind || !/^[a-f0-9]{64}$/.test(version)) return response.status(400).end();
  try {
    await ensureDatabase();
    let result = await pool.query(
      `SELECT mime_type, image_data FROM profile_media_files
       WHERE user_id = $1 AND media_kind = $2 AND media_version = $3 LIMIT 1`,
      [ownerId, kind, version]
    );
    if (!result.rows[0]) {
      const legacy = await pool.query(
        `SELECT media_data, created_at FROM profile_media_history
         WHERE user_id = $1 AND media_kind = $2 AND media_version = $3 LIMIT 1`,
        [ownerId, kind, version]
      );
      if (legacy.rows[0] && String(legacy.rows[0].media_data || '').startsWith('data:image/')) {
        await storeProfileMediaBinary(pool, ownerId, kind, legacy.rows[0].media_data, legacy.rows[0].created_at, version);
        result = await pool.query(
          `SELECT mime_type, image_data FROM profile_media_files
           WHERE user_id = $1 AND media_kind = $2 AND media_version = $3 LIMIT 1`,
          [ownerId, kind, version]
        );
      }
    }
    const media = result.rows[0];
    if (!media) return response.status(404).end();
    response.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    response.setHeader('ETag', `"${version}"`);
    if (request.headers['if-none-match'] === `"${version}"`) return response.status(304).end();
    response.type(media.mime_type || 'image/jpeg').send(media.image_data);
  } catch (error) {
    console.error('Profile media file load failed:', error.message);
    response.status(500).end();
  }
});

app.get('/api/profile-media/:ownerId/:kind', requireApiAuth, async (request, response) => {
  const ownerId = request.params.ownerId;
  const kind = normalizeProfileMediaKind(request.params.kind);
  if (!validNumericId(ownerId) || !kind) return response.status(400).json({ error: 'Invalid profile media.' });
  try {
    await ensureDatabase();
    const media = await currentProfileMedia(ownerId, kind, String(request.query.version || request.body?.version || ''));
    if (!media) return response.status(404).json({ error: 'Profile media not found.' });
    const [likes, shares, comments] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count, BOOL_OR(user_id = $4) AS liked_by_me FROM profile_media_likes WHERE owner_user_id = $1 AND media_kind = $2 AND media_version = $3', [ownerId, kind, media.version, request.user.id]),
      pool.query('SELECT COUNT(*)::int AS count FROM profile_media_shares WHERE owner_user_id = $1 AND media_kind = $2 AND media_version = $3', [ownerId, kind, media.version]),
      profileMediaComments(ownerId, kind, media.version)
    ]);
    response.json({
      ownerId: media.ownerId, ownerName: media.ownerName, profilePhoto: media.profilePhoto,
      source: media.source, version: media.version, isCurrent: media.isCurrent, createdAt: media.createdAt,
      likeCount: Number(likes.rows[0]?.count || 0), likedByMe: Boolean(likes.rows[0]?.liked_by_me),
      shareCount: Number(shares.rows[0]?.count || 0), comments
    });
  } catch (error) {
    console.error('Profile media load failed:', error.message);
    response.status(500).json({ error: 'Could not load profile media.' });
  }
});

app.get('/api/profile-media/:ownerId/:kind/history', requireApiAuth, async (request, response) => {
  const ownerId = request.params.ownerId;
  const kind = normalizeProfileMediaKind(request.params.kind);
  if (!validNumericId(ownerId) || !kind) return response.status(400).json({ error: 'Invalid profile media.' });
  try {
    await ensureDatabase();
    const user = await ensureCurrentProfileMediaHistory(ownerId, kind);
    if (!user) return response.status(404).json({ error: 'Profile not found.' });
    const currentSource = kind === 'cover' ? (user.cover_photo || '') : (user.profile_photo || '');
    const currentVersion = currentSource ? profileMediaVersion(currentSource) : '';
    const metadataOnly = String(request.query.metadata || '') === '1';
    const result = await pool.query(
      `SELECT media_version, ${metadataOnly ? 'NULL::text AS media_data' : 'media_data'}, created_at FROM profile_media_history
       WHERE user_id = $1 AND media_kind = $2 ORDER BY created_at DESC, id DESC`, [ownerId, kind]
    );
    response.json({ items: result.rows.map(row => ({
      source: metadataOnly ? profileMediaFileUrl(ownerId, kind, row.media_version) : row.media_data,
      version: row.media_version, createdAt: row.created_at, isCurrent: row.media_version === currentVersion
    })) });
  } catch (error) {
    console.error('Profile media history failed:', error.message);
    response.status(500).json({ error: 'Could not load previous photos.' });
  }
});

app.delete('/api/profile-media/:ownerId/:kind/:version', requireApiAuth, async (request, response) => {
  const ownerId = request.params.ownerId;
  const kind = normalizeProfileMediaKind(request.params.kind);
  const version = String(request.params.version || '');
  if (!validNumericId(ownerId) || !kind || (version !== 'current' && !/^[a-f0-9]{64}$/.test(version))) return response.status(400).json({ error: 'Invalid profile media.' });
  if (String(ownerId) !== String(request.user.id)) return response.status(403).json({ error: 'Only the owner can delete this photo.' });
  let client;
  try {
    await ensureDatabase();
    /* Make sure the currently displayed image is represented in history before
       locking the user row. The rest of deletion is one transaction, so the
       profile cannot briefly point at a record that has already been removed. */
    await ensureCurrentProfileMediaHistory(ownerId, kind);
    client = await pool.connect();
    await client.query('BEGIN');
    const userResult = await client.query(
      'SELECT id, profile_photo, cover_photo FROM users WHERE id = $1 FOR UPDATE',
      [ownerId]
    );
    const user = userResult.rows[0];
    if (!user) {
      await client.query('ROLLBACK');
      return response.status(404).json({ error: 'Profile not found.' });
    }
    const currentSource = kind === 'cover' ? (user.cover_photo || '') : (user.profile_photo || '');
    const currentVersion = currentSource ? profileMediaVersion(currentSource) : '';
    const resolvedVersion = version === 'current' ? currentVersion : version;
    if (!resolvedVersion) {
      await client.query('ROLLBACK');
      return response.status(404).json({ error: 'Photo not found.' });
    }
    const selectedResult = await client.query(
      `SELECT id, media_data, media_version, created_at FROM profile_media_history
       WHERE user_id = $1 AND media_kind = $2 AND media_version = $3 LIMIT 1`,
      [ownerId, kind, resolvedVersion]
    );
    const selected = selectedResult.rows[0];
    if (!selected) {
      await client.query('ROLLBACK');
      return response.status(404).json({ error: 'Photo not found.' });
    }
    const deletingCurrent = Boolean(currentSource && currentVersion === resolvedVersion);
    let replacement = null;
    if (deletingCurrent) {
      /* History is newest-first. Therefore this is the profile/cover photo that
         immediately preceded the deleted current one whenever it exists. */
      const previous = await client.query(
        `SELECT media_data, media_version, created_at FROM profile_media_history
         WHERE user_id = $1 AND media_kind = $2 AND media_version <> $3
         ORDER BY created_at DESC, id DESC LIMIT 1`, [ownerId, kind, resolvedVersion]
      );
      replacement = previous.rows[0] || null;
      if (replacement && String(replacement.media_data || '').startsWith('data:image/')) {
        const storedReplacement = await storeProfileMediaBinary(client, ownerId, kind, replacement.media_data, replacement.created_at, replacement.media_version);
        replacement.media_data = storedReplacement.url;
      }
      const column = kind === 'cover' ? 'cover_photo' : 'profile_photo';
      const updatedColumn = kind === 'cover' ? 'cover_photo_updated_at' : 'profile_photo_updated_at';
      await client.query(
        `UPDATE users SET ${column} = $1, ${updatedColumn} = $2 WHERE id = $3`,
        [replacement?.media_data || null, replacement?.created_at || null, ownerId]
      );
    }
    await client.query('DELETE FROM profile_media_comments WHERE owner_user_id = $1 AND media_kind = $2 AND media_version = $3', [ownerId, kind, resolvedVersion]);
    await client.query('DELETE FROM profile_media_likes WHERE owner_user_id = $1 AND media_kind = $2 AND media_version = $3', [ownerId, kind, resolvedVersion]);
    await client.query('DELETE FROM profile_media_shares WHERE owner_user_id = $1 AND media_kind = $2 AND media_version = $3', [ownerId, kind, resolvedVersion]);
    await client.query('DELETE FROM profile_media_history WHERE user_id = $1 AND media_kind = $2 AND media_version = $3', [ownerId, kind, resolvedVersion]);
    await client.query('DELETE FROM profile_media_files WHERE user_id = $1 AND media_kind = $2 AND media_version = $3', [ownerId, kind, resolvedVersion]);
    const finalSource = deletingCurrent ? (replacement?.media_data || '') : currentSource;
    const finalVersion = finalSource ? profileMediaVersion(finalSource) : '';
    await client.query('COMMIT');
    response.json({
      ok: true,
      deletedVersion: resolvedVersion,
      currentVersion: finalVersion,
      currentCreatedAt: deletingCurrent ? (replacement?.created_at || null) : null,
      replacement: deletingCurrent && replacement ? {
        source: replacement.media_data,
        version: replacement.media_version,
        createdAt: replacement.created_at
      } : null
    });
  } catch (error) {
    if (client) try { await client.query('ROLLBACK'); } catch (_rollbackError) {}
    console.error('Profile media delete failed:', error.message);
    response.status(500).json({ error: 'Could not delete this photo.' });
  } finally {
    if (client) client.release();
  }
});

app.post('/api/profile-media/:ownerId/:kind/like', requireApiAuth, async (request, response) => {
  const ownerId = request.params.ownerId;
  const kind = normalizeProfileMediaKind(request.params.kind);
  if (!validNumericId(ownerId) || !kind) return response.status(400).json({ error: 'Invalid profile media.' });
  try {
    await ensureDatabase();
    const media = await currentProfileMedia(ownerId, kind, String(request.query.version || request.body?.version || ''));
    if (!media) return response.status(404).json({ error: 'Profile media not found.' });
    const removed = await pool.query(
      'DELETE FROM profile_media_likes WHERE owner_user_id = $1 AND media_kind = $2 AND media_version = $3 AND user_id = $4 RETURNING owner_user_id',
      [ownerId, kind, media.version, request.user.id]
    );
    let liked = false;
    if (!removed.rowCount) {
      await pool.query(
        'INSERT INTO profile_media_likes (owner_user_id, media_kind, media_version, user_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [ownerId, kind, media.version, request.user.id]
      );
      liked = true;
    }
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM profile_media_likes WHERE owner_user_id = $1 AND media_kind = $2 AND media_version = $3', [ownerId, kind, media.version]);
    response.json({ ok: true, liked, likeCount: Number(count.rows[0].count) });
  } catch (error) {
    console.error('Profile media like failed:', error.message);
    response.status(500).json({ error: 'Could not update the like.' });
  }
});

app.post('/api/profile-media/:ownerId/:kind/share', requireApiAuth, async (request, response) => {
  const ownerId = request.params.ownerId;
  const kind = normalizeProfileMediaKind(request.params.kind);
  if (!validNumericId(ownerId) || !kind) return response.status(400).json({ error: 'Invalid profile media.' });
  try {
    await ensureDatabase();
    const media = await currentProfileMedia(ownerId, kind, String(request.query.version || request.body?.version || ''));
    if (!media) return response.status(404).json({ error: 'Profile media not found.' });
    await pool.query(
      `INSERT INTO profile_media_shares (owner_user_id, media_kind, media_version, user_id, shared_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (owner_user_id, media_kind, media_version, user_id) DO UPDATE SET shared_at = EXCLUDED.shared_at`,
      [ownerId, kind, media.version, request.user.id]
    );
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM profile_media_shares WHERE owner_user_id = $1 AND media_kind = $2 AND media_version = $3', [ownerId, kind, media.version]);
    response.json({ ok: true, shareCount: Number(count.rows[0].count) });
  } catch (error) {
    console.error('Profile media share failed:', error.message);
    response.status(500).json({ error: 'Could not update the share.' });
  }
});

app.get('/api/profile-media/:ownerId/:kind/comments', requireApiAuth, async (request, response) => {
  const ownerId = request.params.ownerId;
  const kind = normalizeProfileMediaKind(request.params.kind);
  if (!validNumericId(ownerId) || !kind) return response.status(400).json({ error: 'Invalid profile media.' });
  try {
    await ensureDatabase();
    const media = await currentProfileMedia(ownerId, kind, String(request.query.version || request.body?.version || ''));
    if (!media) return response.status(404).json({ error: 'Profile media not found.' });
    response.json({ comments: await profileMediaComments(ownerId, kind, media.version) });
  } catch (error) {
    console.error('Profile media comments load failed:', error.message);
    response.status(500).json({ error: 'Could not load comments.' });
  }
});

app.post('/api/profile-media/:ownerId/:kind/comments', requireApiAuth, async (request, response) => {
  const ownerId = request.params.ownerId;
  const kind = normalizeProfileMediaKind(request.params.kind);
  const body = String(request.body?.body || '').trim();
  const parentCommentId = request.body?.parentCommentId == null || request.body?.parentCommentId === '' ? null : String(request.body.parentCommentId);
  const mediaInput = normalizeCommentMedia(request.body?.mediaData, request.body?.mediaType);
  if (!validNumericId(ownerId) || !kind) return response.status(400).json({ error: 'Invalid profile media.' });
  if (parentCommentId && !validNumericId(parentCommentId)) return response.status(400).json({ error: 'Invalid reply target.' });
  if (mediaInput.error) return response.status(400).json({ error: mediaInput.error });
  if ((!body && !mediaInput.data) || body.length > 1000) return response.status(400).json({ error: 'Write a comment or add media.' });
  try {
    await ensureDatabase();
    const current = await currentProfileMedia(ownerId, kind, String(request.query.version || request.body?.version || ''));
    if (!current) return response.status(404).json({ error: 'Profile media not found.' });
    let replyToAuthor = '';
    if (parentCommentId) {
      const parent = await pool.query(
        `SELECT pmc.id, u.full_name FROM profile_media_comments pmc JOIN users u ON u.id = pmc.user_id
         WHERE pmc.id = $1 AND pmc.owner_user_id = $2 AND pmc.media_kind = $3 AND pmc.media_version = $4 LIMIT 1`,
        [parentCommentId, ownerId, kind, current.version]
      );
      if (!parent.rows[0]) return response.status(404).json({ error: 'The comment you replied to was not found.' });
      replyToAuthor = parent.rows[0].full_name || '';
    }
    const result = await pool.query(
      `INSERT INTO profile_media_comments (owner_user_id, media_kind, media_version, user_id, parent_comment_id, body, media_data, media_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, user_id, parent_comment_id, body, media_data, media_type, created_at`,
      [ownerId, kind, current.version, request.user.id, parentCommentId, body, mediaInput.data || null, mediaInput.type || null]
    );
    const comment = result.rows[0];
    const commenter = await pool.query('SELECT profile_photo FROM users WHERE id = $1 LIMIT 1', [request.user.id]);
    response.status(201).json({ ok: true, comment: {
      id: String(comment.id), userId: String(comment.user_id), author: request.user.name,
      profilePhoto: commenter.rows[0]?.profile_photo || '',
      parentCommentId: comment.parent_comment_id ? String(comment.parent_comment_id) : null,
      replyToAuthor, mediaData: comment.media_data || '', mediaType: comment.media_type || '',
      body: comment.body, createdAt: comment.created_at
    } });
  } catch (error) {
    console.error('Profile media comment failed:', error.message);
    response.status(500).json({ error: 'Could not add the comment.' });
  }
});

app.get('/api/music-library', requireApiAuth, async (request, response) => {
  try {
    await ensureDatabase();
    const result = await pool.query(
      'SELECT song_key, title, artist, mime_type, audio_data, liked_at FROM liked_songs WHERE user_id = $1 ORDER BY liked_at DESC',
      [request.user.id]
    );
    response.json({ songs: result.rows.map(row => ({ key: row.song_key, title: row.title, artist: row.artist || '', mimeType: row.mime_type, data: row.audio_data, likedAt: row.liked_at })) });
  } catch (error) {
    console.error('Music library load failed:', error.message);
    response.status(500).json({ error: 'Could not load liked songs.' });
  }
});

app.put('/api/music-library/state', requireApiAuth, async (request, response) => {
  const validation = validatePostExtras({ sound: request.body?.sound });
  if (validation.error || !validation.extras.sound) return response.status(400).json({ error: validation.error || 'Choose a song.' });
  const sound = validation.extras.sound;
  const liked = Boolean(request.body?.liked);
  try {
    await ensureDatabase();
    if (liked) {
      await pool.query(
        `INSERT INTO liked_songs (user_id, song_key, title, artist, mime_type, audio_data)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, song_key) DO UPDATE SET title = EXCLUDED.title, artist = EXCLUDED.artist, mime_type = EXCLUDED.mime_type, audio_data = EXCLUDED.audio_data, liked_at = NOW()`,
        [request.user.id, sound.key, sound.title, sound.artist || '', sound.mimeType, sound.data]
      );
    } else {
      await pool.query('DELETE FROM liked_songs WHERE user_id = $1 AND song_key = $2', [request.user.id, sound.key]);
    }
    response.json({ ok: true, liked, key: sound.key });
  } catch (error) {
    console.error('Music library state update failed:', error.message);
    response.status(500).json({ error: 'Could not update liked songs.' });
  }
});

app.post('/api/music-library/toggle', requireApiAuth, async (request, response) => {
  const validation = validatePostExtras({ sound: request.body?.sound });
  if (validation.error || !validation.extras.sound) return response.status(400).json({ error: validation.error || 'Choose a song.' });
  const sound = validation.extras.sound;
  try {
    await ensureDatabase();
    const removed = await pool.query('DELETE FROM liked_songs WHERE user_id = $1 AND song_key = $2 RETURNING song_key', [request.user.id, sound.key]);
    if (removed.rowCount) return response.json({ ok: true, liked: false, key: sound.key });
    await pool.query(
      `INSERT INTO liked_songs (user_id, song_key, title, artist, mime_type, audio_data)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (user_id, song_key) DO UPDATE SET title = EXCLUDED.title, artist = EXCLUDED.artist, mime_type = EXCLUDED.mime_type, audio_data = EXCLUDED.audio_data, liked_at = NOW()`,
      [request.user.id, sound.key, sound.title, sound.artist || '', sound.mimeType, sound.data]
    );
    response.json({ ok: true, liked: true, key: sound.key });
  } catch (error) {
    console.error('Music library toggle failed:', error.message);
    response.status(500).json({ error: 'Could not update liked songs.' });
  }
});

app.get('/api/stories', requireApiAuth, async (_request, response) => {
  try {
    await ensureDatabase();
    const result = await pool.query(`
      SELECT s.id, s.user_id, s.image_data, s.caption, s.created_at, u.full_name, u.profile_photo
      FROM stories s
      JOIN users u ON u.id = s.user_id
      WHERE s.created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY s.created_at DESC
      LIMIT 50
    `);
    response.json({ stories: result.rows.map(row => ({
      id: String(row.id),
      userId: String(row.user_id),
      image: row.image_data,
      caption: row.caption,
      createdAt: row.created_at,
      author: row.full_name,
      profilePhoto: row.profile_photo || ''
    })) });
  } catch (error) {
    console.error('Stories load failed:', error.message);
    response.status(500).json({ error: 'Could not load stories.' });
  }
});

app.post('/api/stories', requireApiAuth, async (request, response) => {
  const image = request.body?.image || '';
  const visibility = String(request.body?.visibility || 'public').trim().toLowerCase();
  const caption = String(request.body?.caption || '').trim();
  if (!image || !validImageData(image)) return response.status(400).json({ error: 'Choose a valid story photo smaller than 6 MB.' });
  if (caption.length > 500) return response.status(400).json({ error: 'Story text is too long.' });
  try {
    await ensureDatabase();
    const result = await pool.query(
      `INSERT INTO stories (user_id, image_data, caption)
       VALUES ($1, $2, $3)
       RETURNING id, user_id, image_data, caption, created_at`,
      [request.user.id, image, caption]
    );
    response.status(201).json({ ok: true, story: result.rows[0] });
  } catch (error) {
    console.error('Story creation failed:', error.message);
    response.status(500).json({ error: 'Could not publish the story.' });
  }
});

app.delete('/api/stories/:storyId', requireApiAuth, async (request, response) => {
  const storyId = request.params.storyId;
  if (!validNumericId(storyId)) return response.status(400).json({ error: 'Invalid story.' });
  try {
    await ensureDatabase();
    const story = await pool.query('SELECT * FROM stories WHERE id=$1 AND user_id=$2 LIMIT 1', [storyId, request.user.id]);
    if (!story.rowCount) return response.status(404).json({ error: 'Story not found.' });
    await pool.query('INSERT INTO admin_deleted_content (user_id, content_type, original_id, content) VALUES ($1,$2,$3,$4::jsonb)', [request.user.id, 'story', String(storyId), JSON.stringify({ story:story.rows[0] })]);
    await pool.query('DELETE FROM stories WHERE id=$1 AND user_id=$2', [storyId, request.user.id]);
    response.json({ ok:true, storyId:String(storyId) });
  } catch (error) { console.error('Story deletion failed:', error.message); response.status(500).json({ error:'Could not delete the story.' }); }
});

app.get('/api/reels', requireApiAuth, async (request, response) => {
  try {
    await ensureDatabase();
    response.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    response.set('Pragma', 'no-cache');
    response.set('Expires', '0');
    const result = await pool.query(`
      WITH like_counts AS (
        SELECT reel_id, COUNT(*)::int AS like_count FROM reel_likes GROUP BY reel_id
      ), save_counts AS (
        SELECT reel_id, COUNT(*)::int AS save_count FROM reel_saves GROUP BY reel_id
      ), share_counts AS (
        SELECT reel_id, COUNT(*)::int AS share_count FROM reel_shares GROUP BY reel_id
      ), my_likes AS (
        SELECT reel_id FROM reel_likes WHERE user_id = $1
      ), my_saves AS (
        SELECT reel_id FROM reel_saves WHERE user_id = $1
      )
      SELECT r.id, r.user_id, r.caption, r.mime_type, r.visibility, r.allow_comments, r.edit_data, r.created_at, r.source_post_id, r.source_media_index, u.full_name, u.profile_photo,
             COALESCE(lc.like_count, 0)::int AS like_count,
             COALESCE(sc.save_count, 0)::int AS save_count,
             COALESCE(shc.share_count, 0)::int AS share_count,
             (ml.reel_id IS NOT NULL) AS liked_by_me,
             (ms.reel_id IS NOT NULL) AS saved_by_me
      FROM reels r
      JOIN users u ON u.id = r.user_id
      LEFT JOIN like_counts lc ON lc.reel_id = r.id
      LEFT JOIN save_counts sc ON sc.reel_id = r.id
      LEFT JOIN share_counts shc ON shc.reel_id = r.id
      LEFT JOIN my_likes ml ON ml.reel_id = r.id
      LEFT JOIN my_saves ms ON ms.reel_id = r.id
      WHERE r.user_id = $1
         OR (
           r.visibility <> 'only-me'
           AND (
             NOT COALESCE(u.account_private, FALSE)
             OR EXISTS (
               SELECT 1 FROM friendships f
               WHERE (f.user_one_id = $1 AND f.user_two_id = r.user_id)
                  OR (f.user_one_id = r.user_id AND f.user_two_id = $1)
             )
           )
         )
      ORDER BY r.created_at DESC
    `, [request.user.id]);
    const commentsByReel = new Map();
    if (result.rows.length) {
      const reelIds = result.rows.map(row => String(row.id));
      const commentResult = await pool.query(
        `SELECT rc.id, rc.reel_id, rc.user_id, rc.parent_comment_id, rc.body, rc.media_data, rc.media_type, rc.created_at,
                u.full_name, u.profile_photo, parent_user.full_name AS reply_to_author
         FROM reel_comments rc
         JOIN users u ON u.id = rc.user_id
         LEFT JOIN reel_comments parent_comment ON parent_comment.id = rc.parent_comment_id
         LEFT JOIN users parent_user ON parent_user.id = parent_comment.user_id
         WHERE rc.reel_id = ANY($1::bigint[])
         ORDER BY rc.created_at`,
        [reelIds]
      );
      commentResult.rows.forEach(row => {
        const reelId = String(row.reel_id);
        if (!commentsByReel.has(reelId)) commentsByReel.set(reelId, []);
        commentsByReel.get(reelId).push({
          id: String(row.id),
          userId: String(row.user_id),
          author: row.full_name,
          profilePhoto: row.profile_photo || '',
          parentCommentId: row.parent_comment_id ? String(row.parent_comment_id) : null,
          replyToAuthor: row.reply_to_author || '',
          mediaData: row.media_data || '',
          mediaType: row.media_type || '',
          body: row.body,
          createdAt: row.created_at
        });
      });
    }
    const reels = result.rows.map(row => ({
      id: String(row.id),
      userId: String(row.user_id),
      caption: row.caption,
      video: `/api/reels/${row.id}/video`,
      mimeType: row.mime_type,
      visibility: row.visibility,
      allowComments: Boolean(row.allow_comments),
      editData: normalizeReelEdits(row.edit_data),
      sourcePostId: row.source_post_id ? String(row.source_post_id) : '',
      sourceMediaIndex: row.source_media_index === null || row.source_media_index === undefined ? null : Number(row.source_media_index),
      contentKey: row.source_post_id
        ? `post:${row.source_post_id}:media:${Number(row.source_media_index || 0)}`
        : `reel:${row.id}`,
      createdAt: row.created_at,
      author: row.full_name,
      profilePhoto: row.profile_photo || '',
      likeCount: Number(row.like_count || 0),
      saveCount: Number(row.save_count || 0),
      shareCount: Number(row.share_count || 0),
      likedByMe: Boolean(row.liked_by_me),
      savedByMe: Boolean(row.saved_by_me),
      comments: commentsByReel.get(String(row.id)) || []
    }));
    response.json({ reels, total: reels.length });
  } catch (error) {
    console.error('Reels load failed:', error.message);
    response.status(500).json({ error: 'Could not load reels.' });
  }
});

app.get('/api/reels/library', requireApiAuth, async (request, response) => {
  try {
    await ensureDatabase();
    response.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    const definitions = [
      ['saved', 'reel_saves', 'created_at'],
      ['liked', 'reel_likes', 'created_at'],
      ['shared', 'reel_shares', 'shared_at'],
      ['watched', 'reel_views', 'viewed_at']
    ];
    const library = {};
    for (const [key, table, timestamp] of definitions) {
      const result = await pool.query(`
        WITH like_counts AS (
          SELECT reel_id, COUNT(*)::int AS like_count FROM reel_likes GROUP BY reel_id
        ), save_counts AS (
          SELECT reel_id, COUNT(*)::int AS save_count FROM reel_saves GROUP BY reel_id
        ), share_counts AS (
          SELECT reel_id, COUNT(*)::int AS share_count FROM reel_shares GROUP BY reel_id
        ), my_likes AS (
          SELECT reel_id FROM reel_likes WHERE user_id = $1
        ), my_saves AS (
          SELECT reel_id FROM reel_saves WHERE user_id = $1
        )
        SELECT r.id, r.user_id, r.caption, r.mime_type, r.visibility, r.allow_comments, r.edit_data, r.created_at,
               u.full_name, u.profile_photo, history.${timestamp} AS library_at,
               COALESCE(lc.like_count, 0)::int AS like_count,
               COALESCE(sc.save_count, 0)::int AS save_count,
               COALESCE(shc.share_count, 0)::int AS share_count,
               (ml.reel_id IS NOT NULL) AS liked_by_me,
               (ms.reel_id IS NOT NULL) AS saved_by_me
        FROM ${table} history
        JOIN reels r ON r.id = history.reel_id
        JOIN users u ON u.id = r.user_id
        LEFT JOIN like_counts lc ON lc.reel_id = r.id
        LEFT JOIN save_counts sc ON sc.reel_id = r.id
        LEFT JOIN share_counts shc ON shc.reel_id = r.id
        LEFT JOIN my_likes ml ON ml.reel_id = r.id
        LEFT JOIN my_saves ms ON ms.reel_id = r.id
        WHERE history.user_id = $1
        ORDER BY history.${timestamp} DESC
        LIMIT 100
      `, [request.user.id]);
      library[key] = result.rows.map(row => ({
        id: String(row.id),
        userId: String(row.user_id),
        caption: row.caption,
        video: `/api/reels/${row.id}/video`,
        mimeType: row.mime_type,
        visibility: row.visibility,
        allowComments: Boolean(row.allow_comments),
        editData: normalizeReelEdits(row.edit_data),
        createdAt: row.created_at,
        libraryAt: row.library_at,
        author: row.full_name,
        profilePhoto: row.profile_photo || '',
        likeCount: Number(row.like_count || 0),
        saveCount: Number(row.save_count || 0),
        shareCount: Number(row.share_count || 0),
        likedByMe: Boolean(row.liked_by_me),
        savedByMe: Boolean(row.saved_by_me),
        comments: []
      }));
    }
    response.json({ library });
  } catch (error) {
    console.error('Reel library load failed:', error.message);
    response.status(500).json({ error: 'Could not load your reel library.' });
  }
});

app.get('/api/reels/:reelId/video', requireApiAuth, async (request, response) => {
  const reelId = request.params.reelId;
  if (!validNumericId(reelId)) return response.status(400).json({ error: 'Invalid reel.' });
  try {
    await ensureDatabase();
    const result = await pool.query(
      `SELECT r.video_data, r.mime_type, r.source_post_id, r.source_media_index, r.user_id, r.visibility,
              p.media_items, p.image_data, u.account_private,
              EXISTS (
                SELECT 1 FROM friendships f
                WHERE (f.user_one_id = $2 AND f.user_two_id = r.user_id)
                   OR (f.user_one_id = r.user_id AND f.user_two_id = $2)
              ) AS viewer_is_friend
       FROM reels r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN posts p ON p.id = r.source_post_id
       WHERE r.id = $1
       LIMIT 1`,
      [reelId, request.user.id]
    );
    if (!result.rows.length) return response.status(404).json({ error: 'Reel not found.' });
    const row = result.rows[0];
    const ownsReel = String(row.user_id) === String(request.user.id);
    if (!ownsReel && (row.visibility === 'only-me' || (row.account_private && !row.viewer_is_friend))) {
      return response.status(403).json({ error: 'This reel is private.' });
    }
    let videoData = row.video_data || '';
    let mimeType = row.mime_type || '';
    if (row.source_post_id) {
      const media = normalizeStoredPostMedia(row.media_items, row.image_data || '');
      const item = media[Number(row.source_media_index || 0)];
      if (!item || item.type !== 'video' || !item.data) return response.status(404).json({ error: 'Video media not found.' });
      videoData = item.data;
      mimeType = item.mimeType || mimeType;
    }
    const encoded = String(videoData || '').replace(/^data:video\/[a-z0-9.+-]+(?:;[^;]*)?;base64,/i, '');
    const bytes = Buffer.from(encoded, 'base64');
    mimeType = /^video\/[a-z0-9.+-]+$/i.test(String(mimeType || '')) ? mimeType : 'video/webm';
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Cache-Control', 'private, max-age=3600');
    const range = String(request.headers.range || '');
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range);
    if (match) {
      const start = match[1] ? Math.max(0, Number(match[1])) : 0;
      const end = match[2] ? Math.min(bytes.length - 1, Number(match[2])) : bytes.length - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= bytes.length) {
        response.setHeader('Content-Range', `bytes */${bytes.length}`);
        return response.status(416).end();
      }
      response.status(206);
      response.setHeader('Content-Type', mimeType);
      response.setHeader('Content-Length', end - start + 1);
      response.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
      return response.end(bytes.subarray(start, end + 1));
    }
    response.setHeader('Content-Type', mimeType);
    response.setHeader('Content-Length', bytes.length);
    response.end(bytes);
  } catch (error) {
    console.error('Reel video load failed:', error.message);
    response.status(500).json({ error: 'Could not load the reel video.' });
  }
});

app.post('/api/reels', requireApiAuth, async (request, response) => {
  const video = request.body?.video || '';
  const caption = String(request.body?.caption || '').trim();
  const detectedType = /^data:(video\/[a-z0-9.+-]+)(?:;[^;]*)?;base64,/i.exec(video)?.[1] || '';
  const mimeType = String(request.body?.mimeType || detectedType).trim().toLowerCase();
  const visibility = String(request.body?.visibility || 'public').trim().toLowerCase();
  const allowComments = request.body?.allowComments !== false;
  const editData = normalizeReelEdits(request.body?.editData);
  if (!validVideoData(video)) return response.status(400).json({ error: 'The posted Reel must be 50 MB or smaller.' });
  if (!/^video\/[a-z0-9.+-]+$/i.test(mimeType) || detectedType.toLowerCase() !== mimeType) {
    return response.status(400).json({ error: 'The selected video format is not supported.' });
  }
  if (caption.length > 500) return response.status(400).json({ error: 'Reel caption is too long.' });
  if (!['public', 'followers', 'friends', 'only-me'].includes(visibility)) return response.status(400).json({ error: 'Choose a valid Reel audience.' });
  try {
    await ensureDatabase();
    const result = await pool.query(
      `INSERT INTO reels (user_id, caption, video_data, mime_type, visibility, allow_comments, edit_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, user_id, caption, mime_type, visibility, allow_comments, edit_data, created_at`,
      [request.user.id, caption, video, mimeType, visibility, allowComments, editData]
    );
    const reel = result.rows[0];
    response.status(201).json({ ok: true, reel: { ...reel, contentKey: `reel:${reel.id}` } });
  } catch (error) {
    console.error('Reel creation failed:', error.message);
    response.status(500).json({ error: 'Could not publish the reel.' });
  }
});

app.patch('/api/reels/:reelId', requireApiAuth, async (request, response) => {
  const reelId = request.params.reelId;
  if (!validNumericId(reelId)) return response.status(400).json({ error: 'Invalid reel.' });
  const caption = String(request.body?.caption || '').trim();
  const visibility = String(request.body?.visibility || 'friends').trim().toLowerCase();
  if (caption.length > 500) return response.status(400).json({ error: 'Reel caption is too long.' });
  if (!['public', 'followers', 'friends', 'only-me'].includes(visibility)) return response.status(400).json({ error: 'Choose a valid Reel audience.' });
  try {
    await ensureDatabase();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE reels
         SET caption = $1, visibility = $2
         WHERE id = $3 AND user_id = $4
         RETURNING id, user_id, caption, visibility, allow_comments, edit_data, created_at, source_post_id, source_media_index`,
        [caption, visibility, reelId, request.user.id]
      );
      if (!result.rowCount) {
        await client.query('ROLLBACK');
        return response.status(404).json({ error: 'Reel not found or you do not own it.' });
      }
      const reel = result.rows[0];
      if (reel.source_post_id) {
        await client.query(
          `UPDATE posts
           SET body = $1, visibility = $2
           WHERE id = $3 AND user_id = $4`,
          [caption, visibility, reel.source_post_id, request.user.id]
        );
        await client.query(
          `UPDATE reels
           SET caption = $1, visibility = $2
           WHERE source_post_id = $3 AND user_id = $4`,
          [caption, visibility, reel.source_post_id, request.user.id]
        );
      }
      await client.query('COMMIT');
      response.json({
        ok: true,
        reel: {
          ...reel,
          sourcePostId: reel.source_post_id ? String(reel.source_post_id) : '',
          sourceMediaIndex: reel.source_media_index === null || reel.source_media_index === undefined ? null : Number(reel.source_media_index)
        }
      });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Reel update failed:', error.message);
    response.status(500).json({ error: 'Could not update the reel.' });
  }
});

app.delete('/api/reels/:reelId', requireApiAuth, async (request, response) => {
  const reelId = request.params.reelId;
  if (!validNumericId(reelId)) return response.status(400).json({ error: 'Invalid reel.' });
  try {
    await ensureDatabase();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(
        'SELECT id, source_post_id FROM reels WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [reelId, request.user.id]
      );
      if (!found.rowCount) {
        await client.query('ROLLBACK');
        return response.status(404).json({ error: 'Reel not found or you do not own it.' });
      }
      const row = found.rows[0];
      if (row.source_post_id) {
        const siblings = await client.query('SELECT id FROM reels WHERE source_post_id = $1 ORDER BY id', [row.source_post_id]);
        await archivePostForAdmin(client, row.source_post_id, request.user.id);
        await client.query('DELETE FROM posts WHERE id = $1 AND user_id = $2', [row.source_post_id, request.user.id]);
        await client.query('COMMIT');
        return response.json({
          ok: true,
          reelId: String(row.id),
          deletedPostId: String(row.source_post_id),
          reelIds: siblings.rows.map(item => String(item.id))
        });
      }
      await archiveReelForAdmin(client, reelId, request.user.id);
      await client.query('DELETE FROM reels WHERE id = $1 AND user_id = $2', [reelId, request.user.id]);
      await client.query('COMMIT');
      response.json({ ok: true, reelId: String(row.id), reelIds: [String(row.id)] });
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Reel deletion failed:', error.message);
    response.status(500).json({ error: 'Could not delete the reel.' });
  }
});

app.post('/api/reels/:reelId/like', requireApiAuth, async (request, response) => {
  const reelId = request.params.reelId;
  if (!validNumericId(reelId)) return response.status(400).json({ error: 'Invalid reel.' });
  try {
    await ensureDatabase();
    const removed = await pool.query('DELETE FROM reel_likes WHERE reel_id = $1 AND user_id = $2 RETURNING reel_id', [reelId, request.user.id]);
    let liked = false;
    if (!removed.rowCount) {
      await pool.query('INSERT INTO reel_likes (reel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [reelId, request.user.id]);
      liked = true;
    }
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM reel_likes WHERE reel_id = $1', [reelId]);
    response.json({ ok: true, liked, likeCount: Number(count.rows[0].count) });
  } catch (error) {
    if (error.code === '23503') return response.status(404).json({ error: 'Reel not found.' });
    console.error('Reel like failed:', error.message);
    response.status(500).json({ error: 'Could not update the like.' });
  }
});

app.post('/api/reels/:reelId/save', requireApiAuth, async (request, response) => {
  const reelId = request.params.reelId;
  if (!validNumericId(reelId)) return response.status(400).json({ error: 'Invalid reel.' });
  try {
    await ensureDatabase();
    const removed = await pool.query('DELETE FROM reel_saves WHERE reel_id = $1 AND user_id = $2 RETURNING reel_id', [reelId, request.user.id]);
    let saved = false;
    if (!removed.rowCount) {
      await pool.query('INSERT INTO reel_saves (reel_id, user_id) VALUES ($1, $2) ON CONFLICT (reel_id, user_id) DO UPDATE SET created_at = NOW()', [reelId, request.user.id]);
      saved = true;
    }
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM reel_saves WHERE reel_id = $1', [reelId]);
    response.json({ ok: true, saved, saveCount: Number(count.rows[0].count) });
  } catch (error) {
    if (error.code === '23503') return response.status(404).json({ error: 'Reel not found.' });
    console.error('Reel save failed:', error.message);
    response.status(500).json({ error: 'Could not update the saved reel.' });
  }
});

app.post('/api/reels/:reelId/share', requireApiAuth, async (request, response) => {
  const reelId = request.params.reelId;
  if (!validNumericId(reelId)) return response.status(400).json({ error: 'Invalid reel.' });
  try {
    await ensureDatabase();
    await pool.query(
      `INSERT INTO reel_shares (reel_id, user_id, shared_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (reel_id, user_id) DO UPDATE SET shared_at = EXCLUDED.shared_at`,
      [reelId, request.user.id]
    );
    const count = await pool.query('SELECT COUNT(*)::int AS count FROM reel_shares WHERE reel_id = $1', [reelId]);
    response.json({ ok: true, shareCount: Number(count.rows[0].count) });
  } catch (error) {
    if (error.code === '23503') return response.status(404).json({ error: 'Reel not found.' });
    console.error('Reel share history failed:', error.message);
    response.status(500).json({ error: 'Could not update shared reels.' });
  }
});

app.post('/api/reels/:reelId/view', requireApiAuth, async (request, response) => {
  const reelId = request.params.reelId;
  if (!validNumericId(reelId)) return response.status(400).json({ error: 'Invalid reel.' });
  try {
    await ensureDatabase();
    await pool.query(
      `INSERT INTO reel_views (reel_id, user_id, viewed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (reel_id, user_id) DO UPDATE SET viewed_at = EXCLUDED.viewed_at`,
      [reelId, request.user.id]
    );
    response.json({ ok: true });
  } catch (error) {
    if (error.code === '23503') return response.status(404).json({ error: 'Reel not found.' });
    console.error('Reel view history failed:', error.message);
    response.status(500).json({ error: 'Could not update watched reels.' });
  }
});

app.get('/api/reels/:reelId/comments', requireApiAuth, async (request, response) => {
  const reelId = request.params.reelId;
  if (!validNumericId(reelId)) return response.status(400).json({ error: 'Invalid reel.' });
  try {
    await ensureDatabase();
    const reel = await pool.query('SELECT allow_comments FROM reels WHERE id = $1 LIMIT 1', [reelId]);
    if (!reel.rows[0]) return response.status(404).json({ error: 'Reel not found.' });
    const result = await pool.query(
      `SELECT rc.id, rc.user_id, rc.parent_comment_id, rc.body, rc.media_data, rc.media_type, rc.created_at,
              u.full_name, u.profile_photo, parent_user.full_name AS reply_to_author
       FROM reel_comments rc
       JOIN users u ON u.id = rc.user_id
       LEFT JOIN reel_comments parent_comment ON parent_comment.id = rc.parent_comment_id
       LEFT JOIN users parent_user ON parent_user.id = parent_comment.user_id
       WHERE rc.reel_id = $1
       ORDER BY rc.created_at`,
      [reelId]
    );
    response.json({
      allowComments: Boolean(reel.rows[0].allow_comments),
      comments: result.rows.map(row => ({
        id: String(row.id),
        userId: String(row.user_id),
        author: row.full_name,
        profilePhoto: row.profile_photo || '',
        parentCommentId: row.parent_comment_id ? String(row.parent_comment_id) : null,
        replyToAuthor: row.reply_to_author || '',
        mediaData: row.media_data || '',
        mediaType: row.media_type || '',
        body: row.body,
        createdAt: row.created_at
      }))
    });
  } catch (error) {
    console.error('Reel comments load failed:', error.message);
    response.status(500).json({ error: 'Could not load comments.' });
  }
});

app.post('/api/reels/:reelId/comments', requireApiAuth, async (request, response) => {
  const reelId = request.params.reelId;
  const body = String(request.body?.body || '').trim();
  const parentCommentId = request.body?.parentCommentId == null || request.body?.parentCommentId === '' ? null : String(request.body.parentCommentId);
  const media = normalizeCommentMedia(request.body?.mediaData, request.body?.mediaType);
  if (!validNumericId(reelId)) return response.status(400).json({ error: 'Invalid reel.' });
  if (parentCommentId && !validNumericId(parentCommentId)) return response.status(400).json({ error: 'Invalid reply target.' });
  if (media.error) return response.status(400).json({ error: media.error });
  if ((!body && !media.data) || body.length > 1000) return response.status(400).json({ error: 'Write a comment or add media.' });
  try {
    await ensureDatabase();
    const reel = await pool.query('SELECT allow_comments FROM reels WHERE id = $1 LIMIT 1', [reelId]);
    if (!reel.rows[0]) return response.status(404).json({ error: 'Reel not found.' });
    if (!reel.rows[0].allow_comments) return response.status(403).json({ error: 'Comments are turned off for this Reel.' });
    let replyToAuthor = '';
    if (parentCommentId) {
      const parent = await pool.query(
        `SELECT rc.id, u.full_name FROM reel_comments rc JOIN users u ON u.id = rc.user_id WHERE rc.id = $1 AND rc.reel_id = $2 LIMIT 1`,
        [parentCommentId, reelId]
      );
      if (!parent.rows[0]) return response.status(404).json({ error: 'The comment you replied to was not found.' });
      replyToAuthor = parent.rows[0].full_name || '';
    }
    const result = await pool.query(
      `INSERT INTO reel_comments (reel_id, user_id, parent_comment_id, body, media_data, media_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, parent_comment_id, body, media_data, media_type, created_at`,
      [reelId, request.user.id, parentCommentId, body, media.data || null, media.type || null]
    );
    const comment = result.rows[0];
    const commenter = await pool.query('SELECT profile_photo FROM users WHERE id = $1 LIMIT 1', [request.user.id]);
    response.status(201).json({ ok: true, comment: {
      id: String(comment.id), userId: String(comment.user_id), author: request.user.name,
      profilePhoto: commenter.rows[0]?.profile_photo || '',
      parentCommentId: comment.parent_comment_id ? String(comment.parent_comment_id) : null,
      replyToAuthor, mediaData: comment.media_data || '', mediaType: comment.media_type || '',
      body: comment.body, createdAt: comment.created_at
    } });
  } catch (error) {
    if (error.code === '23503') return response.status(404).json({ error: 'Reel or reply target not found.' });
    console.error('Reel comment failed:', error.message);
    response.status(500).json({ error: 'Could not add the comment.' });
  }
});



function friendUserPayload(row) {
  return {
    id: String(row.id),
    name: row.full_name || 'Facebook user',
    profilePhoto: row.profile_photo || '',
    createdAt: row.created_at || null,
    lastSeenAt: row.last_seen_at || null,
    isOnline: Boolean(row.is_online)
  };
}


app.get('/api/users/:userId/friends', requireApiAuth, async (request, response) => {
  const targetId = request.params.userId;
  if (!validNumericId(targetId)) return response.status(400).json({ error: 'Invalid profile.' });
  const requestedLimit = Number.parseInt(String(request.query.limit || '4'), 10);
  const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 4, 24));
  try {
    await ensureDatabase();
    const exists = await pool.query('SELECT id FROM users WHERE id = $1 LIMIT 1', [targetId]);
    if (!exists.rows[0]) return response.status(404).json({ error: 'Profile not found.' });
    const [rowsResult, countResult] = await Promise.all([
      pool.query(
        `SELECT u.id, u.full_name, u.profile_photo, u.last_seen_at,
                (u.last_seen_at >= NOW() - INTERVAL '2 minutes') AS is_online,
                (
                  SELECT COUNT(*)::int
                  FROM friendships viewer_friend
                  JOIN friendships candidate_friend
                    ON (CASE WHEN viewer_friend.user_one_id = $2 THEN viewer_friend.user_two_id ELSE viewer_friend.user_one_id END)
                     = (CASE WHEN candidate_friend.user_one_id = u.id THEN candidate_friend.user_two_id ELSE candidate_friend.user_one_id END)
                  WHERE (viewer_friend.user_one_id = $2 OR viewer_friend.user_two_id = $2)
                    AND (candidate_friend.user_one_id = u.id OR candidate_friend.user_two_id = u.id)
                ) AS mutual_count
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_one_id = $1 THEN f.user_two_id ELSE f.user_one_id END
         WHERE f.user_one_id = $1 OR f.user_two_id = $1
         ORDER BY (u.profile_photo IS NULL OR u.profile_photo = '') ASC, f.created_at DESC, u.full_name ASC
         LIMIT $3`,
        [targetId, request.user.id, limit]
      ),
      pool.query('SELECT COUNT(*)::int AS count FROM friendships WHERE user_one_id = $1 OR user_two_id = $1', [targetId])
    ]);
    response.set('Cache-Control', 'private, no-store');
    response.json({
      totalCount: Number(countResult.rows[0]?.count || 0),
      friends: rowsResult.rows.map(row => ({
        id: String(row.id),
        name: row.full_name || 'Facebook user',
        profilePhoto: row.profile_photo || '',
        isOnline: Boolean(row.is_online),
        mutualCount: Number(row.mutual_count || 0)
      }))
    });
  } catch (error) {
    console.error('Profile friends load failed:', error.message);
    response.status(500).json({ error: 'Could not load profile friends.' });
  }
});

app.get('/api/friends/overview', requireApiAuth, async (request, response) => {
  try {
    await ensureDatabase();
    const userId = request.user.id;
    await pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [userId]);
    const [suggestionsResult, requestsResult, friendsResult, onlineCountResult] = await Promise.all([
      pool.query(
        `SELECT u.id, u.full_name, u.profile_photo, u.created_at, u.last_seen_at,
                (u.last_seen_at >= NOW() - INTERVAL '2 minutes') AS is_online
         FROM users u
         WHERE u.id <> $1
           AND NOT EXISTS (
             SELECT 1 FROM friendships f
             WHERE (f.user_one_id = $1 AND f.user_two_id = u.id)
                OR (f.user_two_id = $1 AND f.user_one_id = u.id)
           )
           AND NOT EXISTS (
             SELECT 1 FROM friend_requests fr
             WHERE (fr.sender_id = $1 AND fr.receiver_id = u.id)
                OR (fr.receiver_id = $1 AND fr.sender_id = u.id)
           )
           AND NOT EXISTS (
             SELECT 1 FROM friend_suggestion_dismissals d
             WHERE d.user_id = $1 AND d.suggested_user_id = u.id
           )
         ORDER BY u.created_at DESC NULLS LAST, u.id DESC
         LIMIT 60`,
        [userId]
      ),
      pool.query(
        `SELECT fr.id AS request_id, fr.created_at AS request_created_at,
                u.id, u.full_name, u.profile_photo, u.created_at, u.last_seen_at,
                (u.last_seen_at >= NOW() - INTERVAL '2 minutes') AS is_online
         FROM friend_requests fr
         JOIN users u ON u.id = fr.sender_id
         WHERE fr.receiver_id = $1
         ORDER BY fr.created_at DESC, fr.id DESC`,
        [userId]
      ),
      pool.query(
        `SELECT u.id, u.full_name, u.profile_photo, u.created_at, u.last_seen_at,
                (u.last_seen_at >= NOW() - INTERVAL '2 minutes') AS is_online,
                f.created_at AS friends_since
         FROM friendships f
         JOIN users u ON u.id = CASE WHEN f.user_one_id = $1 THEN f.user_two_id ELSE f.user_one_id END
         WHERE f.user_one_id = $1 OR f.user_two_id = $1
         ORDER BY f.created_at DESC, u.full_name ASC`,
        [userId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS count
         FROM users
         WHERE id <> $1 AND last_seen_at >= NOW() - INTERVAL '2 minutes'`,
        [userId]
      )
    ]);
    const friends = friendsResult.rows.map(row => Object.assign(friendUserPayload(row), {
      friendsSince: row.friends_since || null
    }));
    response.set('Cache-Control', 'private, no-store');
    response.json({
      suggestions: suggestionsResult.rows.map(friendUserPayload),
      requests: requestsResult.rows.map(row => Object.assign(friendUserPayload(row), {
        requestId: String(row.request_id),
        requestedAt: row.request_created_at || null
      })),
      friends,
      onlineFriends: friends.filter(friend => friend.isOnline),
      onlineCount: Number(onlineCountResult.rows[0]?.count || 0)
    });
  } catch (error) {
    console.error('Friends overview failed:', error.message);
    response.status(500).json({ error: 'Could not load Friends.' });
  }
});

app.get('/api/members', requireApiAuth, async (request, response) => {
  try {
    await ensureDatabase();
    await pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [request.user.id]);
    const [result, countsResult] = await Promise.all([
      pool.query(
        `SELECT id, full_name, profile_photo, created_at, last_seen_at,
                (last_seen_at >= NOW() - INTERVAL '2 minutes') AS is_online
         FROM users
         ORDER BY created_at DESC NULLS LAST, id DESC
         LIMIT 250`
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total_count,
                COUNT(*) FILTER (WHERE last_seen_at >= NOW() - INTERVAL '2 minutes')::int AS online_count
         FROM users`
      )
    ]);
    const members = result.rows.map(friendUserPayload);
    const counts = countsResult.rows[0] || {};
    response.set('Cache-Control', 'private, no-store');
    response.json({
      totalCount: Number(counts.total_count || 0),
      onlineCount: Number(counts.online_count || 0),
      members
    });
  } catch (error) {
    console.error('Members load failed:', error.message);
    response.status(500).json({ error: 'Could not load members.' });
  }
});

app.post('/api/presence/ping', requireApiAuth, async (request, response) => {
  try {
    await ensureDatabase();
    await pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [request.user.id]);
    response.set('Cache-Control', 'no-store');
    response.json({ ok: true });
  } catch (error) {
    console.error('Presence ping failed:', error.message);
    response.status(500).json({ error: 'Could not update presence.' });
  }
});

app.post('/api/friends/:userId/request', requireApiAuth, async (request, response) => {
  const targetId = request.params.userId;
  if (!validNumericId(targetId) || String(targetId) === String(request.user.id)) {
    return response.status(400).json({ error: 'Choose a valid person.' });
  }
  try {
    await ensureDatabase();
    const target = await pool.query('SELECT id, full_name, profile_photo, created_at FROM users WHERE id = $1 LIMIT 1', [targetId]);
    if (!target.rows[0]) return response.status(404).json({ error: 'This account was not found.' });
    const first = String(request.user.id) < String(targetId) ? request.user.id : targetId;
    const second = String(request.user.id) < String(targetId) ? targetId : request.user.id;
    const existingFriend = await pool.query('SELECT 1 FROM friendships WHERE user_one_id = $1 AND user_two_id = $2 LIMIT 1', [first, second]);
    if (existingFriend.rows[0]) return response.json({ ok: true, state: 'friends', user: friendUserPayload(target.rows[0]) });
    const incoming = await pool.query('SELECT id FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2 LIMIT 1', [targetId, request.user.id]);
    if (incoming.rows[0]) return response.status(409).json({ error: 'This person already sent you a friend request.' });
    await pool.query(
      `INSERT INTO friend_requests (sender_id, receiver_id) VALUES ($1, $2)
       ON CONFLICT (sender_id, receiver_id) DO NOTHING`,
      [request.user.id, targetId]
    );
    await createNotification(pool, { userId: targetId, actorId: request.user.id, type: 'friend_request' });
    await pool.query('DELETE FROM friend_suggestion_dismissals WHERE user_id = $1 AND suggested_user_id = $2', [request.user.id, targetId]);
    response.status(201).json({ ok: true, state: 'requested', user: friendUserPayload(target.rows[0]) });
  } catch (error) {
    console.error('Friend request failed:', error.message);
    response.status(500).json({ error: 'Could not send the friend request.' });
  }
});

app.delete('/api/friends/:userId/request', requireApiAuth, async (request, response) => {
  const targetId = request.params.userId;
  if (!validNumericId(targetId)) return response.status(400).json({ error: 'Invalid request.' });
  try {
    await ensureDatabase();
    await pool.query('DELETE FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2', [request.user.id, targetId]);
    await pool.query(
      "DELETE FROM notifications WHERE user_id = $1 AND actor_id = $2 AND type = 'friend_request'",
      [targetId, request.user.id]
    );
    response.json({ ok: true });
  } catch (error) {
    console.error('Cancel friend request failed:', error.message);
    response.status(500).json({ error: 'Could not cancel the request.' });
  }
});

app.post('/api/friends/:userId/dismiss', requireApiAuth, async (request, response) => {
  const targetId = request.params.userId;
  if (!validNumericId(targetId) || String(targetId) === String(request.user.id)) return response.status(400).json({ error: 'Invalid suggestion.' });
  try {
    await ensureDatabase();
    await pool.query(
      `INSERT INTO friend_suggestion_dismissals (user_id, suggested_user_id) VALUES ($1, $2)
       ON CONFLICT (user_id, suggested_user_id) DO UPDATE SET created_at = NOW()`,
      [request.user.id, targetId]
    );
    response.json({ ok: true });
  } catch (error) {
    console.error('Dismiss friend suggestion failed:', error.message);
    response.status(500).json({ error: 'Could not remove this suggestion.' });
  }
});

app.post('/api/friend-requests/:requestId/accept', requireApiAuth, async (request, response) => {
  const requestId = request.params.requestId;
  if (!validNumericId(requestId)) return response.status(400).json({ error: 'Invalid friend request.' });
  let client;
  try {
    await ensureDatabase();
    client = await pool.connect();
    await client.query('BEGIN');
    const pending = await client.query(
      `SELECT fr.id, fr.sender_id, fr.receiver_id, u.full_name, u.profile_photo, u.created_at
       FROM friend_requests fr JOIN users u ON u.id = fr.sender_id
       WHERE fr.id = $1 AND fr.receiver_id = $2 FOR UPDATE`,
      [requestId, request.user.id]
    );
    const row = pending.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return response.status(404).json({ error: 'This friend request is no longer available.' });
    }
    const first = Number(row.sender_id) < Number(row.receiver_id) ? row.sender_id : row.receiver_id;
    const second = Number(row.sender_id) < Number(row.receiver_id) ? row.receiver_id : row.sender_id;
    await client.query(
      `INSERT INTO friendships (user_one_id, user_two_id) VALUES ($1, $2)
       ON CONFLICT (user_one_id, user_two_id) DO NOTHING`,
      [first, second]
    );
    await client.query(
      'DELETE FROM friend_requests WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)',
      [row.sender_id, row.receiver_id]
    );
    await client.query(
      'DELETE FROM friend_suggestion_dismissals WHERE (user_id = $1 AND suggested_user_id = $2) OR (user_id = $2 AND suggested_user_id = $1)',
      [row.sender_id, row.receiver_id]
    );
    await createNotification(client, { userId: row.sender_id, actorId: request.user.id, type: 'friend_accept' });
    await client.query('COMMIT');
    response.json({ ok: true, friend: friendUserPayload(row) });
  } catch (error) {
    if (client) try { await client.query('ROLLBACK'); } catch (_rollbackError) {}
    console.error('Accept friend request failed:', error.message);
    response.status(500).json({ error: 'Could not accept the friend request.' });
  } finally {
    if (client) client.release();
  }
});

app.delete('/api/friend-requests/:requestId', requireApiAuth, async (request, response) => {
  const requestId = request.params.requestId;
  if (!validNumericId(requestId)) return response.status(400).json({ error: 'Invalid friend request.' });
  try {
    await ensureDatabase();
    const result = await pool.query('DELETE FROM friend_requests WHERE id = $1 AND receiver_id = $2 RETURNING sender_id', [requestId, request.user.id]);
    if (!result.rows[0]) return response.status(404).json({ error: 'This friend request is no longer available.' });
    await pool.query(
      "DELETE FROM notifications WHERE user_id = $1 AND actor_id = $2 AND type = 'friend_request'",
      [request.user.id, result.rows[0].sender_id]
    );
    response.json({ ok: true });
  } catch (error) {
    console.error('Delete friend request failed:', error.message);
    response.status(500).json({ error: 'Could not delete the friend request.' });
  }
});

app.delete('/api/friends/:userId', requireApiAuth, async (request, response) => {
  const targetId = request.params.userId;
  if (!validNumericId(targetId) || String(targetId) === String(request.user.id)) return response.status(400).json({ error: 'Invalid friend.' });
  try {
    await ensureDatabase();
    const first = Number(request.user.id) < Number(targetId) ? request.user.id : targetId;
    const second = Number(request.user.id) < Number(targetId) ? targetId : request.user.id;
    await pool.query('DELETE FROM friendships WHERE user_one_id = $1 AND user_two_id = $2', [first, second]);
    response.json({ ok: true });
  } catch (error) {
    console.error('Remove friend failed:', error.message);
    response.status(500).json({ error: 'Could not remove this friend.' });
  }
});

app.get('/api/navigation-badges', requireApiAuth, async (request, response) => {
  try {
    await ensureDatabase();
    const result = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM friend_requests WHERE receiver_id = $1) AS friend_request_count,
         (SELECT COUNT(*)::int FROM notifications WHERE user_id = $1 AND read_at IS NULL) AS unread_notification_count`,
      [request.user.id]
    );
    response.set('Cache-Control', 'no-store');
    response.json({
      friendRequestCount: Number(result.rows[0]?.friend_request_count || 0),
      unreadNotificationCount: Number(result.rows[0]?.unread_notification_count || 0)
    });
  } catch (error) {
    console.error('Navigation badges load failed:', error.message);
    response.status(500).json({ error: 'Could not load navigation badges.' });
  }
});

app.get('/api/notifications', requireApiAuth, async (request, response) => {
  try {
    await ensureDatabase();
    const result = await pool.query(
      `SELECT n.id, n.type, n.post_id, n.detail, n.comment_id, n.read_at, n.created_at,
              actor.id AS actor_id, actor.full_name AS actor_name, actor.profile_photo AS actor_profile_photo,
              posts.user_id AS post_owner_id,
              pending_request.id AS friend_request_id
       FROM notifications n
       LEFT JOIN users actor ON actor.id = n.actor_id
       LEFT JOIN posts ON posts.id = n.post_id
       LEFT JOIN friend_requests pending_request
         ON n.type = 'friend_request'
        AND pending_request.sender_id = n.actor_id
        AND pending_request.receiver_id = n.user_id
       WHERE n.user_id = $1
       ORDER BY n.created_at DESC
       LIMIT 100`,
      [request.user.id]
    );
    response.set('Cache-Control', 'no-store');
    response.json({ notifications: result.rows.map(row => ({
      id: String(row.id),
      type: row.type,
      postId: row.post_id ? String(row.post_id) : '',
      postOwnerId: row.post_owner_id ? String(row.post_owner_id) : '',
      actorId: row.actor_id ? String(row.actor_id) : '',
      actorName: row.actor_name || 'Facebook user',
      actorProfilePhoto: row.actor_profile_photo || '',
      friendRequestId: row.friend_request_id ? String(row.friend_request_id) : '',
      detail: row.detail || '',
      commentId: row.comment_id ? String(row.comment_id) : '',
      unread: !row.read_at,
      createdAt: row.created_at
    })) });
  } catch (error) {
    console.error('Notifications load failed:', error.message);
    response.status(500).json({ error: 'Could not load notifications.' });
  }
});

app.post('/api/notifications/read', requireApiAuth, async (request, response) => {
  try {
    await ensureDatabase();
    await pool.query('UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE user_id = $1', [request.user.id]);
    response.json({ ok: true });
  } catch (error) {
    console.error('Notifications read failed:', error.message);
    response.status(500).json({ error: 'Could not update notifications.' });
  }
});

app.post('/api/notifications/:notificationId/read', requireApiAuth, async (request, response) => {
  const notificationId = request.params.notificationId;
  if (!validNumericId(notificationId)) return response.status(400).json({ error: 'Invalid notification.' });
  try {
    await ensureDatabase();
    const result = await pool.query(
      'UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND user_id = $2 RETURNING id',
      [notificationId, request.user.id]
    );
    if (!result.rowCount) return response.status(404).json({ error: 'Notification not found.' });
    response.json({ ok: true });
  } catch (error) {
    console.error('Notification read failed:', error.message);
    response.status(500).json({ error: 'Could not update notification.' });
  }
});

app.get('/manifest.webmanifest', (_request, response) => {
  response.setHeader('Cache-Control', 'no-cache');
  response.type('application/manifest+json').sendFile(path.join(publicDirectory, 'manifest.webmanifest'));
});

app.get('/sw.js', (_request, response) => {
  response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  response.setHeader('Service-Worker-Allowed', '/');
  response.type('application/javascript').sendFile(path.join(publicDirectory, 'sw.js'));
});

app.get(['/pwa-icon-192.png', '/pwa-icon-512.png'], (request, response) => {
  response.setHeader('Cache-Control', 'public, max-age=86400');
  response.type('image/png').sendFile(path.join(publicDirectory, path.basename(request.path)));
});

app.get('/', (request, response) => {
  if (readSession(request)) return response.redirect('/app');
  response.sendFile(path.join(publicDirectory, 'login.html'));
});

app.get('/app', requireAuth, (_request, response) => {
  response.setHeader('Cache-Control', 'private, no-cache, must-revalidate');
  setDataNamespaceCookie(response);
  response.sendFile(path.join(publicDirectory, 'profile_pagee.html'));
});

app.get('/app-data.js', requireAuth, (_request, response) => {
  response.setHeader('Cache-Control', 'private, no-cache, must-revalidate');
  setDataNamespaceCookie(response);
  response.type('application/javascript').sendFile(path.join(publicDirectory, 'app-data.js'));
});

app.get('/reel-effects.js', requireAuth, (_request, response) => {
  response.type('application/javascript').sendFile(path.join(publicDirectory, 'reel-effects.js'));
});

app.use('/mediapipe', requireAuth, express.static(path.join(__dirname, 'node_modules', '@mediapipe', 'face_mesh')));
app.use('/segmentation', requireAuth, express.static(path.join(__dirname, 'node_modules', '@mediapipe', 'selfie_segmentation')));
app.use('/transformers', requireAuth, express.static(path.join(__dirname, 'node_modules', '@xenova', 'transformers', 'dist')));
app.use('/fingerprintjs', requireAuth, express.static(path.join(__dirname, 'node_modules', '@fingerprintjs', 'fingerprintjs', 'dist')));
app.use('/detect-incognito', requireAuth, express.static(path.join(__dirname, 'node_modules', 'detectincognitojs', 'dist')));

app.use('/icons', requireAuth, express.static(path.join(publicDirectory, 'icons'), {
  fallthrough: false,
  maxAge: 0,
  etag: true,
  setHeaders(response) {
    response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
}));

app.use('/inline-media', requireAuth, express.static(path.join(publicDirectory, 'inline_media'), {
  fallthrough: false,
  maxAge: '1y',
  immutable: true,
  etag: true,
  setHeaders(response) {
    response.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  }
}));

app.get('/reel-caption-worker.js', requireAuth, (_request, response) => {
  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  response.type('application/javascript').sendFile(path.join(publicDirectory, 'reel-caption-worker.js'));
});

app.get('/reel-ui/:asset', requireAuth, (request, response) => {
  const allowed = new Set([
    'reel-undo.png',
    'reel-redo.png',
    'reel-fullscreen.png',
    'reel-minimize.png',
    'sound-volume.png',
    'sound-fade.png',
    'sound-replace.png',
    'sound-delete.png',
    'reel-text-speech-icon.png',
    'reel-text-copy-icon.png',
    'reel-text-delete-icon.png',
    'reel-text-opacity-icon.png',
    'caption-capacity-icon.png',
    'caption-style-icon.png',
    'caption-edit-icon.png',
    'caption-voice-icon.png',
    'overlay-copy-icon.png',
    'overlay-delete-icon.png',
    'overlay-replace-icon.png',
    'reel-tool-stickers.png',
    'reel-tool-overlay.png',
    'reel-preview-layout.png',
    'reel-preview-settings.png',
    'reel-preview-share.png',
    'reel-preview-stickers.png',
    'reel-preview-effects.png',
    'reel-preview-templates.png',
    'reel-preview-sound.png',
    'reel-preview-add-sound-provided.png',
    'reel-preview-mute-provided.png',
    'reel-preview-autocut-provided.png',
    'reel-preview-filters.png',
    'reel-preview-text.png',
    'feed-video-volume-on.png',
    'feed-video-volume-muted.png'
  ]);
  if (!allowed.has(request.params.asset)) return response.sendStatus(404);
  response.sendFile(path.join(publicDirectory, request.params.asset));
});

app.get('/sound-menu-icons/:asset', requireAuth, (request, response) => {
  const allowed = new Set(['reel-sound-add.png', 'reel-sound-effect.png', 'reel-sound-voiceover.png']);
  if (!allowed.has(request.params.asset)) return response.sendStatus(404);
  response.sendFile(path.join(publicDirectory, 'assets', request.params.asset));
});


app.get('/edit_profile_wrapper.html', requireAuth, (_request, response) => {
  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  response.sendFile(path.join(publicDirectory, 'edit_profile_wrapper.html'));
});

app.get('/edit_profile_main.html', requireAuth, (_request, response) => {
  response.setHeader('Cache-Control', 'private, max-age=3600');
  response.sendFile(path.join(publicDirectory, 'edit_profile_main.html'));
});

app.use('/edit_profile_fast', requireAuth, express.static(path.join(publicDirectory, 'edit_profile_fast'), {
  fallthrough: false,
  index: false,
  maxAge: '1h'
}));

app.use('/edit_profile_assets', requireAuth, express.static(path.join(publicDirectory, 'edit_profile_assets'), {
  fallthrough: false,
  index: false,
  maxAge: '30d',
  immutable: true
}));

app.get('*splat', (request, response) => response.redirect(readSession(request) ? '/app' : '/'));

const server = app.listen(port, '0.0.0.0', async () => {
  console.log(`Website listening on port ${port}`);
  if (!pool) {
    console.error('DATABASE_URL is not configured; login cannot work.');
    return;
  }
  try {
    await withTimeout(ensureAuthDatabase(), 15000, 'Authentication database setup timed out.');
    console.log('Authentication database ready');
  } catch (error) {
    console.error('Authentication database setup failed:', error.message);
    return;
  }
  setImmediate(() => {
    ensureDatabase()
      .then(() => console.log('Application database ready'))
      .catch(error => console.error('Application database setup failed:', error.message));
  });
});

async function shutdown() {
  server.close(async () => {
    if (pool) await pool.end();
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
