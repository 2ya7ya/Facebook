const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const express = require('express');
const compression = require('compression');
const { Pool } = require('pg');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { WebSocketServer, WebSocket } = require('ws');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');

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
const postMediaRoot = process.env.POST_MEDIA_ROOT || path.join(process.env.HOME || os.homedir(), 'facebook-media', 'posts');
const postMediaUploadRoot = path.join(postMediaRoot, '_uploads');
const postMediaAssetRoot = path.join(postMediaRoot, 'assets');

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
  response.setHeader('Accept-CH', 'Sec-CH-UA-Model, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version, Sec-CH-UA-Full-Version-List, Sec-CH-UA-Arch, Sec-CH-UA-Bitness, ECT, Downlink, Save-Data');
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
  await pool.query("ALTER TABLE account_login_sessions ADD COLUMN IF NOT EXISTS location VARCHAR(255) NOT NULL DEFAULT ''");
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
  await pool.query('CREATE INDEX IF NOT EXISTS admin_deleted_content_user_time_id_idx ON admin_deleted_content(user_id, deleted_at DESC, id DESC)');


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


  /* Messenger V85: normalized conversation/message store. Message bodies and
     metadata stay small; binary attachments live separately and are fetched
     only when needed. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messenger_conversations (
      id BIGSERIAL PRIMARY KEY,
      conversation_type VARCHAR(16) NOT NULL DEFAULT 'direct',
      title VARCHAR(160) NOT NULL DEFAULT '',
      created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      named_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      group_image TEXT NOT NULL DEFAULT '',
      direct_key VARCHAR(96) UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE messenger_conversations ADD COLUMN IF NOT EXISTS named_by BIGINT REFERENCES users(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE messenger_conversations ADD COLUMN IF NOT EXISTS group_image TEXT NOT NULL DEFAULT ''`);
  await pool.query(`UPDATE messenger_conversations SET named_by=created_by WHERE conversation_type='group' AND named_by IS NULL`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messenger_conversation_members (
      conversation_id BIGINT NOT NULL REFERENCES messenger_conversations(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role VARCHAR(16) NOT NULL DEFAULT 'member',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_read_message_id BIGINT,
      last_read_at TIMESTAMPTZ,
      muted_until TIMESTAMPTZ,
      archived BOOLEAN NOT NULL DEFAULT FALSE,
      pinned BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (conversation_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messenger_messages (
      id BIGSERIAL PRIMARY KEY,
      conversation_id BIGINT NOT NULL REFERENCES messenger_conversations(id) ON DELETE CASCADE,
      sender_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      client_id VARCHAR(96),
      message_type VARCHAR(24) NOT NULL DEFAULT 'text',
      body TEXT NOT NULL DEFAULT '',
      reply_to_id BIGINT REFERENCES messenger_messages(id) ON DELETE SET NULL,
      edited_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (sender_id, client_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messenger_attachments (
      id BIGSERIAL PRIMARY KEY,
      message_id BIGINT NOT NULL REFERENCES messenger_messages(id) ON DELETE CASCADE,
      uploader_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      file_name VARCHAR(255) NOT NULL DEFAULT '',
      mime_type VARCHAR(160) NOT NULL DEFAULT 'application/octet-stream',
      byte_size INTEGER NOT NULL DEFAULT 0,
      file_data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messenger_message_receipts (
      message_id BIGINT NOT NULL REFERENCES messenger_messages(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      delivered_at TIMESTAMPTZ,
      read_at TIMESTAMPTZ,
      PRIMARY KEY (message_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messenger_message_reactions (
      message_id BIGINT NOT NULL REFERENCES messenger_messages(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji VARCHAR(24) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (message_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messenger_message_hides (
      message_id BIGINT NOT NULL REFERENCES messenger_messages(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      hidden_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (message_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messenger_conversation_nicknames (
      conversation_id BIGINT NOT NULL REFERENCES messenger_conversations(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      nickname VARCHAR(80) NOT NULL,
      updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (conversation_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messenger_user_blocks (
      blocker_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (blocker_id, blocked_id),
      CONSTRAINT messenger_block_distinct_users CHECK (blocker_id <> blocked_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS messenger_members_user_idx ON messenger_conversation_members(user_id, pinned DESC, archived, conversation_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS messenger_messages_conversation_idx ON messenger_messages(conversation_id, id DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS messenger_messages_search_idx ON messenger_messages(conversation_id, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS messenger_receipts_user_idx ON messenger_message_receipts(user_id, read_at, message_id)');
  await pool.query('CREATE INDEX IF NOT EXISTS messenger_conversations_updated_idx ON messenger_conversations(updated_at DESC, id DESC)');
  await pool.query('ALTER TABLE messenger_messages ADD COLUMN IF NOT EXISTS forwarded_from_id BIGINT REFERENCES messenger_messages(id) ON DELETE SET NULL');
  await pool.query("ALTER TABLE messenger_conversations ADD COLUMN IF NOT EXISTS theme_key VARCHAR(32) NOT NULL DEFAULT 'default'");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketplace_listings (
      id BIGSERIAL PRIMARY KEY,
      seller_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(180) NOT NULL,
      price NUMERIC(12,2),
      currency VARCHAR(12) NOT NULL DEFAULT '',
      category VARCHAR(120) NOT NULL DEFAULT '',
      location VARCHAR(255) NOT NULL DEFAULT '',
      image_data TEXT,
      status VARCHAR(24) NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketplace_saved (
      listing_id BIGINT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (listing_id, user_id)
    )
  `);
  await pool.query("CREATE INDEX IF NOT EXISTS marketplace_active_created_idx ON marketplace_listings (created_at DESC, id DESC) WHERE status = 'active'");
  await pool.query('CREATE INDEX IF NOT EXISTS marketplace_seller_created_idx ON marketplace_listings(seller_id, created_at DESC, id DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS marketplace_saved_user_created_idx ON marketplace_saved(user_id, created_at DESC)');
  await pool.query("ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''");
  await pool.query("ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS media_json JSONB NOT NULL DEFAULT '[]'::jsonb");
  await pool.query("ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS condition VARCHAR(40) NOT NULL DEFAULT ''");
  await pool.query("ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS seller_ip_prefix VARCHAR(80) NOT NULL DEFAULT ''");
  await pool.query("ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS seller_country VARCHAR(120) NOT NULL DEFAULT ''");
  await pool.query('CREATE INDEX IF NOT EXISTS marketplace_country_created_idx ON marketplace_listings(seller_country, created_at DESC, id DESC)');
  await pool.query(`
    UPDATE marketplace_listings m
       SET seller_country = BTRIM(regexp_replace(latest.location, '^.*,\\s*', ''))
      FROM LATERAL (
        SELECT s.location
          FROM account_login_sessions s
         WHERE s.user_id = m.seller_id
           AND COALESCE(s.location, '') <> ''
         ORDER BY s.last_active_at DESC
         LIMIT 1
      ) latest
     WHERE COALESCE(m.seller_country, '') = ''
       AND COALESCE(latest.location, '') <> ''
  `).catch(() => {});

  await pool.query('CREATE INDEX IF NOT EXISTS marketplace_local_prefix_created_idx ON marketplace_listings(seller_ip_prefix, created_at DESC, id DESC)');
  await pool.query(`
    UPDATE marketplace_listings m
       SET seller_ip_prefix = CASE
         WHEN latest.ip_address ~ '^[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}$'
           THEN split_part(latest.ip_address, '.', 1) || '.' || split_part(latest.ip_address, '.', 2)
         ELSE ''
       END
      FROM LATERAL (
        SELECT s.ip_address
          FROM account_login_sessions s
         WHERE s.user_id = m.seller_id
           AND COALESCE(s.ip_address, '') <> ''
         ORDER BY s.last_active_at DESC
         LIMIT 1
      ) latest
     WHERE COALESCE(m.seller_ip_prefix, '') = ''
  `).catch(() => {});

  await pool.query('ALTER TABLE marketplace_listings ADD COLUMN IF NOT EXISTS views INTEGER NOT NULL DEFAULT 0');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketplace_recent_views (
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      listing_id BIGINT NOT NULL REFERENCES marketplace_listings(id) ON DELETE CASCADE,
      viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, listing_id)
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS marketplace_category_created_idx ON marketplace_listings(category, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS marketplace_price_created_idx ON marketplace_listings(price, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS marketplace_recent_user_idx ON marketplace_recent_views(user_id, viewed_at DESC)');

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
  await pool.query('ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS media_storage_key VARCHAR(48)');
  await pool.query('ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS media_mime_type VARCHAR(100)');
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
    CREATE TABLE IF NOT EXISTS fcm_device_tokens (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS fcm_device_tokens_user_idx ON fcm_device_tokens (user_id)'
  );
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
    CREATE TABLE IF NOT EXISTS reel_video_variants (
      reel_id BIGINT NOT NULL REFERENCES reels(id) ON DELETE CASCADE,
      variant VARCHAR(16) NOT NULL CHECK (variant IN ('source','low','high')),
      mime_type VARCHAR(80) NOT NULL DEFAULT 'video/mp4',
      byte_length INTEGER NOT NULL DEFAULT 0,
      video_data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (reel_id, variant)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reel_thumbnails (
      reel_id BIGINT PRIMARY KEY REFERENCES reels(id) ON DELETE CASCADE,
      mime_type VARCHAR(80) NOT NULL DEFAULT 'image/jpeg',
      image_data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reel_upload_sessions (
      id VARCHAR(64) PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      caption VARCHAR(500) NOT NULL DEFAULT '',
      mime_type VARCHAR(120) NOT NULL DEFAULT 'video/mp4',
      visibility VARCHAR(20) NOT NULL DEFAULT 'public',
      allow_comments BOOLEAN NOT NULL DEFAULT TRUE,
      edit_data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '2 hours'
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS reel_upload_sessions_user_idx ON reel_upload_sessions (user_id, created_at DESC)');
  await pool.query('DELETE FROM reel_upload_sessions WHERE expires_at < NOW()');
  await pool.query('CREATE INDEX IF NOT EXISTS reel_video_variants_reel_idx ON reel_video_variants (reel_id)');
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

  await pool.query('CREATE INDEX IF NOT EXISTS posts_user_created_id_idx ON posts (user_id, created_at DESC, id DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS posts_created_id_idx ON posts (created_at DESC, id DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS reels_user_created_id_idx ON reels (user_id, created_at DESC, id DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS stories_user_created_id_idx ON stories (user_id, created_at DESC, id DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS post_comments_user_created_id_idx ON post_comments (user_id, created_at DESC, id DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS post_media_comments_user_created_id_idx ON post_media_comments (user_id, created_at DESC, id DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS reel_comments_user_created_id_idx ON reel_comments (user_id, created_at DESC, id DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS post_likes_user_created_idx ON post_likes (user_id, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS post_media_likes_user_created_idx ON post_media_likes (user_id, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS reel_likes_user_created_idx ON reel_likes (user_id, created_at DESC)');
  await pool.query('CREATE INDEX IF NOT EXISTS story_likes_user_created_idx ON story_likes (user_id, created_at DESC)');

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


let firebaseMessaging = null;

function getFirebaseMessaging() {
  if (firebaseMessaging) return firebaseMessaging;

  let raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();

  const credentialFile = String(
    process.env.FIREBASE_SERVICE_ACCOUNT_FILE || ''
  ).trim();

  if (!raw && credentialFile) {
    try {
      raw = fs.readFileSync(credentialFile, 'utf8').trim();
    } catch (error) {
      console.error('Firebase credential file read failed:', error.message);
      return null;
    }
  }

  if (!raw) return null;

  try {
    const serviceAccount = JSON.parse(raw);

    if (serviceAccount.private_key) {
      serviceAccount.private_key = String(serviceAccount.private_key).replace(/\\n/g, '\n');
    }

    if (!getApps().length) {
      initializeApp({
        credential: cert(serviceAccount)
      });
    }

    firebaseMessaging = getMessaging();
    return firebaseMessaging;
  } catch (error) {
    console.error('Firebase Admin initialization failed:', error.message);
    return null;
  }
}

function notificationPushText(type, actorName) {
  const actor = actorName || 'Someone';

  if (type === 'post_like') return `${actor} liked your post.`;
  if (type === 'post_comment') return `${actor} commented on your post.`;
  if (type === 'mention') return `${actor} mentioned you.`;
  if (type === 'friend_request') return `${actor} sent you a friend request.`;
  if (type === 'friend_accept') return `${actor} accepted your friend request.`;

  return `${actor} sent you a notification.`;
}

async function sendNotificationPush({
  notificationId,
  userId,
  actorId,
  type,
  postId = null,
  commentId = null,
  detail = ''
}) {
  const messaging = getFirebaseMessaging();
  if (!messaging || !pool) return;

  try {
    const [tokensResult, actorResult] = await Promise.all([
      pool.query(
        'SELECT token FROM fcm_device_tokens WHERE user_id = $1 ORDER BY updated_at DESC',
        [userId]
      ),
      actorId
        ? pool.query(
            `SELECT
               COALESCE(NULLIF(BTRIM(full_name), ''), 'Someone') AS name,
               COALESCE(profile_photo, '') AS profile_photo
             FROM users
             WHERE id = $1
             LIMIT 1`,
            [actorId]
          )
        : Promise.resolve({ rows: [] })
    ]);

    const tokens = tokensResult.rows
      .map(row => String(row.token || '').trim())
      .filter(Boolean);

    if (!tokens.length) return;

    const actorName = actorResult.rows[0]?.name || 'Someone';
    const actorProfilePhoto = actorResult.rows[0]?.profile_photo || '';
    const cleanDetail = String(detail || '').trim().slice(0, 500);

    let pushBody = notificationPushText(type, actorName);

    if (type === 'post_comment' && cleanDetail) {
      pushBody = `commented on your post: ${cleanDetail}`;
    } else if (type === 'mention' && cleanDetail) {
      pushBody = `mentioned you: ${cleanDetail}`;
    }

    const result = await messaging.sendEachForMulticast({
      tokens,
      data: {
        title: actorName,
        body: pushBody,
        type: String(type || ''),
        notificationId: String(notificationId || ''),
        actorId: String(actorId || ''),
        actorName: String(actorName || ''),
        actorProfilePhoto: String(actorProfilePhoto || ''),
        postId: String(postId || ''),
        commentId: String(commentId || ''),
        detail: cleanDetail
      },
      android: {
        priority: 'high'
      }
    });

    const staleTokens = [];

    result.responses.forEach((item, index) => {
      if (item.success) return;

      const code = String(item.error?.code || '');

      if (
        code === 'messaging/registration-token-not-registered' ||
        code === 'messaging/invalid-registration-token'
      ) {
        staleTokens.push(tokens[index]);
      }
    });

    if (staleTokens.length) {
      await pool.query(
        'DELETE FROM fcm_device_tokens WHERE token = ANY($1::text[])',
        [staleTokens]
      );
    }
  } catch (error) {
    console.error('Notification push failed:', error.message);
  }
}

async function createNotification(client, { userId, actorId, type, postId = null, detail = '', commentId = null }) {
  if (!userId || String(userId) === String(actorId)) return;

  const created = await client.query(
    `INSERT INTO notifications (user_id, actor_id, type, post_id, detail, comment_id, read_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, NOW())
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [userId, actorId || null, type, postId || null, String(detail || '').slice(0, 1000), commentId || null]
  );

  if (!created.rowCount) return;

  sendNotificationPush({
    notificationId: created.rows[0].id,
    userId,
    actorId,
    type,
    postId,
    commentId,
    detail
  }).catch(error => {
    console.error('Notification push scheduling failed:', error.message);
  });
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
    `SELECT id, COALESCE(${fullNameExpression}) AS full_name, profile_photo, password_hash, deactivated_at, admin_suspended_at, admin_suspended_until${legacyPasswordSelect}
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

const sessionValidationCache = new Map();
const SESSION_VALIDATION_CACHE_MS = 3000;

async function serverSessionAllowed(session, request) {
  if (!pool || !session?.id) return Boolean(session);

  const sessionKey = request ? accountSessionKey(request, session.sid) : '';
  const cacheKey = String(session.id) + ':' + String(sessionKey);
  const now = Date.now();

  const cached = sessionValidationCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return true;
  }

  if (cached) sessionValidationCache.delete(cacheKey);

  await ensureAuthDatabase();

  const result = await pool.query(`SELECT u.admin_suspended_at, u.admin_suspended_until, u.sessions_revoked_at,
    EXISTS(SELECT 1 FROM revoked_account_sessions r WHERE r.user_id = u.id AND r.session_key = $2) AS session_revoked
    FROM users u WHERE u.id = $1 LIMIT 1`, [session.id, sessionKey]);

  const user = result.rows[0];

  const suspensionActive =
    Boolean(user?.admin_suspended_at) &&
    (!user.admin_suspended_until ||
      new Date(user.admin_suspended_until).getTime() > now);

  if (suspensionActive && request) {
    request.accountSuspensionUntil =
      user.admin_suspended_until || null;
  }

  if (!user || suspensionActive || user.session_revoked) {
    sessionValidationCache.delete(cacheKey);
    return false;
  }

  const revokedAt = user.sessions_revoked_at
    ? new Date(user.sessions_revoked_at).getTime()
    : 0;

  const allowed =
    !revokedAt || Number(session.iat || 0) > revokedAt;

  if (allowed) {
    sessionValidationCache.set(cacheKey, {
      expiresAt: now + SESSION_VALIDATION_CACHE_MS
    });

    if (sessionValidationCache.size > 2000) {
      for (const [key, value] of sessionValidationCache) {
        if (value.expiresAt <= now) {
          sessionValidationCache.delete(key);
        }
      }
    }
  }

  return allowed;
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
  const auditDetails = { ...(details || {}) };
  if (targetUserId && !auditDetails.targetDisplayName) {
    try {
      const target = await pool.query(
        `SELECT COALESCE(NULLIF(BTRIM(full_name), ''), 'Facebook user') AS display_name
           FROM users
          WHERE id = $1
          LIMIT 1`,
        [targetUserId]
      );
      if (target.rowCount) auditDetails.targetDisplayName = target.rows[0].display_name || 'Facebook user';
    } catch (error) {
      console.warn('Could not snapshot audit target display name:', error.message);
    }
  }
  await pool.query(
    'INSERT INTO admin_audit_log (admin_user_id, target_user_id, action, details, ip_address) VALUES ($1,$2,$3,$4::jsonb,$5)',
    [request.user.id, targetUserId || null, String(action).slice(0, 80), JSON.stringify(auditDetails), requestClientIp(request)]
  );
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

function safePostUploadToken(value) {
  const token = String(value || '').trim();
  return /^[a-f0-9-]{36}$/i.test(token) ? token : '';
}
function safePostStorageKey(value) {
  const key = String(value || '').trim();
  return /^[a-f0-9]{48}$/i.test(key) ? key : '';
}
function postUploadPaths(token) {
  return {
    data: path.join(postMediaUploadRoot, `${token}.bin`),
    meta: path.join(postMediaUploadRoot, `${token}.json`)
  };
}
function postAssetPath(storageKey) { return path.join(postMediaAssetRoot, `${storageKey}.bin`); }
function postMediaTypeFromMime(mimeType) {
  const mime = String(mimeType || '').toLowerCase().split(';')[0];
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return '';
}
function cleanupExpiredPostUploads() {
  try {
    fs.mkdirSync(postMediaUploadRoot, { recursive:true });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(postMediaUploadRoot)) {
      const file = path.join(postMediaUploadRoot, name);
      try { if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file); } catch (_error) {}
    }
  } catch (_error) {}
}
function readPostUpload(token, userId) {
  const safe = safePostUploadToken(token);
  if (!safe) throw new Error('Invalid post media upload.');
  const files = postUploadPaths(safe);
  if (!fs.existsSync(files.data) || !fs.existsSync(files.meta)) throw new Error('This media upload expired. Try posting again.');
  const meta = JSON.parse(fs.readFileSync(files.meta, 'utf8'));
  if (String(meta.userId) !== String(userId)) throw new Error('This media upload does not belong to this account.');
  if (!meta.expiresAt || Date.parse(meta.expiresAt) <= Date.now()) throw new Error('This media upload expired. Try posting again.');
  return { token:safe, files, meta };
}
function consumePostUpload(token, userId, expectedType) {
  const upload = readPostUpload(token, userId);
  const actualType = postMediaTypeFromMime(upload.meta.mimeType);
  if (expectedType && actualType !== expectedType) throw new Error(`Uploaded ${expectedType} has an invalid file type.`);
  fs.mkdirSync(postMediaAssetRoot, { recursive:true });
  const storageKey = crypto.randomBytes(24).toString('hex');
  fs.renameSync(upload.files.data, postAssetPath(storageKey));
  try { fs.unlinkSync(upload.files.meta); } catch (_error) {}
  return {
    storageKey,
    type: actualType,
    mimeType: String(upload.meta.mimeType || 'application/octet-stream'),
    name: String(upload.meta.name || '').slice(0, 255),
    size: Number(upload.meta.size || 0)
  };
}

function normalizeStoredPostMedia(value, legacyImage = '') {
  const source = Array.isArray(value) ? value : [];
  const normalized = source.map((item) => {
    if (!item || typeof item !== 'object') return null;
    const storageKey = safePostStorageKey(item.storageKey);
    if (storageKey) {
      const mimeType = String(item.mimeType || '').toLowerCase().split(';')[0];
      const type = String(item.type || postMediaTypeFromMime(mimeType));
      if (!['image','video'].includes(type)) return null;
      const normalized = { type, mimeType, storageKey, binary:true, name:String(item.name || '').slice(0,255) };
      if (type === 'video' && item.editData && typeof item.editData === 'object') normalized.editData = normalizeReelEdits(item.editData);
      if (item.reelId) normalized.reelId = String(item.reelId);
      return normalized;
    }
    const data = String(item.data || '');
    const mimeType = postMediaMimeType(data);
    const type = mimeType.startsWith('video/') ? 'video' : (mimeType.startsWith('image/') ? 'image' : '');
    if (!type || !data) return null;
    const normalized = { type, mimeType, data, name:String(item.name || '').slice(0,255) };
    if (type === 'video' && item.editData && typeof item.editData === 'object') normalized.editData = normalizeReelEdits(item.editData);
    if (item.reelId) normalized.reelId = String(item.reelId);
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
    if (!item || typeof item !== 'object') return { error:'Choose valid photos or videos.' };
    const uploadToken = safePostUploadToken(item.uploadToken);
    if (uploadToken) {
      const mimeType = String(item.mimeType || '').toLowerCase().split(';')[0];
      const type = String(item.type || postMediaTypeFromMime(mimeType));
      if (!['image','video'].includes(type) || postMediaTypeFromMime(mimeType) !== type) return { error:'Choose valid photos or videos.' };
      const normalized = { type, mimeType, uploadToken, name:String(item.name || '').slice(0,255) };
      if (type === 'video' && item.editData && typeof item.editData === 'object') normalized.editData = normalizeReelEdits(item.editData);
      media.push(normalized);
      continue;
    }
    const data = String(item.data || '');
    const mimeType = postMediaMimeType(data);
    const type = mimeType.startsWith('video/') ? 'video' : (mimeType.startsWith('image/') ? 'image' : '');
    if (!type || !data) return { error: 'Choose valid photos or videos.' };
    if (type === 'image' && !validImageData(data)) return { error: 'Each photo must be a supported image smaller than 8 MB.' };
    if (type === 'video' && !validVideoData(data)) return { error: 'Each video must be 50 MB or smaller.' };
    encodedSize += data.length;
    const normalized = { type, mimeType, data, name:String(item.name || '').slice(0,255) };
    if (type === 'video' && item.editData && typeof item.editData === 'object') normalized.editData = normalizeReelEdits(item.editData);
    media.push(normalized);
  }
  if (encodedSize > 65 * 1024 * 1024) return { error: 'The selected photos and videos are too large together.' };
  return { media };
}

function writePostAsset(bytes) {
  fs.mkdirSync(postMediaAssetRoot, { recursive:true });
  const storageKey = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(postAssetPath(storageKey), bytes);
  return storageKey;
}
async function materializePostMedia(userId, media) {
  const stored=[];
  for (const item of Array.isArray(media) ? media : []) {
    let storageKey='', mimeType=item.mimeType || '', name=item.name || '';
    if (item.uploadToken) {
      const asset=consumePostUpload(item.uploadToken,userId,item.type);
      storageKey=asset.storageKey; mimeType=asset.mimeType; name=asset.name || name;
    } else if (item.data) {
      const decoded=dataUrlBuffer(item.data,item.type || '');
      if (!decoded || !decoded.bytes || !decoded.bytes.length) throw new Error('Could not decode post media.');
      storageKey=writePostAsset(decoded.bytes); mimeType=decoded.mimeType || mimeType;
    } else continue;
    const normalized={type:item.type,mimeType,name,storageKey,binary:true};
    if(item.type==='video'&&item.editData&&typeof item.editData==='object')normalized.editData=normalizeReelEdits(item.editData);
    stored.push(normalized);
  }
  return stored;
}

function postMediaBytes(item) {
  const key=safePostStorageKey(item && item.storageKey);
  if (key) {
    const file=postAssetPath(key);
    if (fs.existsSync(file)) return { bytes:fs.readFileSync(file), mimeType:item.mimeType || 'application/octet-stream' };
  }
  if (item && item.data) return dataUrlBuffer(item.data,item.type || '');
  return null;
}

async function syncPostVideoReels(queryable, { postId, userId, caption, visibility, createdAt, media }) {
  const videos = (Array.isArray(media) ? media : [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item && item.type === 'video' && (safePostStorageKey(item.storageKey) || validVideoData(item.data)));
  const keep = videos.map(({ index }) => index);
  if (keep.length) await queryable.query('DELETE FROM reels WHERE source_post_id = $1 AND NOT (source_media_index = ANY($2::int[]))',[postId, keep]);
  else await queryable.query('DELETE FROM reels WHERE source_post_id = $1',[postId]);
  const linked = [];
  for (const { item, index } of videos) {
    const editData = normalizeReelEdits(item.editData || {});
    editData.sourcePostId = String(postId); editData.sourceMediaIndex = index;
    const result = await queryable.query(
      `INSERT INTO reels (user_id, caption, video_data, mime_type, visibility, allow_comments, edit_data, created_at, source_post_id, source_media_index)
       VALUES ($1, $2, NULL, $3, $4, TRUE, $5::jsonb, COALESCE($6::timestamptz, NOW()), $7, $8)
       ON CONFLICT (source_post_id, source_media_index) WHERE source_post_id IS NOT NULL
       DO UPDATE SET user_id = EXCLUDED.user_id, caption = EXCLUDED.caption, video_data = NULL,
                     mime_type = EXCLUDED.mime_type, visibility = EXCLUDED.visibility, edit_data = EXCLUDED.edit_data
       RETURNING id, source_media_index`,
      [userId, String(caption || '').slice(0, 500), item.mimeType || postMediaMimeType(item.data) || 'video/mp4', visibility, JSON.stringify(editData), createdAt || null, postId, index]
    );
    if (result.rows[0]) {
      const reelId=String(result.rows[0].id), source=postMediaBytes(item);
      if(source && source.bytes && source.bytes.length) await storeReelVariant(queryable,reelId,'source',source.mimeType || item.mimeType || 'video/mp4',source.bytes);
      linked.push({ id:reelId, mediaIndex:Number(result.rows[0].source_media_index) });
    }
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


  if (source.marketplaceListing && typeof source.marketplaceListing === 'object') {
    const raw = source.marketplaceListing;
    const listingId = String(raw.listingId || raw.id || '').trim();
    if (/^\d+$/.test(listingId)) {
      const title = String(raw.title || 'Marketplace listing').trim().slice(0, 220);
      const currency = String(raw.currency || '').trim().slice(0, 12);
      const priceNumber = Number(raw.price);
      const price = Number.isFinite(priceNumber) ? priceNumber : null;
      const location = String(raw.location || '').trim().slice(0, 180);
      const sellerName = String(raw.sellerName || '').trim().slice(0, 160);
      const status = String(raw.status || 'active').trim().toLowerCase() === 'sold' ? 'sold' : 'active';
      extras.marketplaceListing = {
        listingId,
        title: title || 'Marketplace listing',
        currency,
        price,
        location,
        sellerName,
        status,
        imageUrl: `/api/marketplace/${encodeURIComponent(listingId)}/image`
      };
    }
  }

  if (source.sound && typeof source.sound === 'object') {
    const title = String(source.sound.title || source.sound.name || 'Audio').trim().slice(0, 220);
    const artist = String(source.sound.artist || '').trim().slice(0, 220);
    const data = String(source.sound.data || '');
    const uploadToken = safePostUploadToken(source.sound.uploadToken);
    const key = String(source.sound.key || '').trim().slice(0, 500);
    const mimeType = String(source.sound.mimeType || postMediaMimeType(data) || 'audio/mpeg').toLowerCase().split(';')[0].slice(0, 100);
    const coverData = String(source.sound.coverData || '');
    if (coverData && (coverData.length > 6 * 1024 * 1024 || !validImageData(coverData))) return { error: 'Choose a valid music photo smaller than 4 MB.' };
    if (uploadToken) {
      if (!mimeType.startsWith('audio/')) return { error:'Choose a valid audio file.' };
      extras.sound = { name:title || 'Audio', title:title || 'Audio', artist, mimeType, uploadToken };
    } else if (key && !data) {
      extras.sound = { name:title || 'Audio', title:title || 'Audio', artist, mimeType, key };
    } else if (data) {
      if (data.length > 18 * 1024 * 1024 || !/^data:audio\/[a-z0-9.+-]+(?:;[^;]*)?;base64,[a-z0-9+/=\s]+$/i.test(data)) return { error:'Choose a valid audio file smaller than 12 MB.' };
      extras.sound = { name:title || 'Audio', title:title || 'Audio', artist, mimeType, data, key:key || crypto.createHash('sha256').update(data).digest('hex') };
    }
    if (extras.sound && coverData) extras.sound.coverData = coverData;
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
  return Boolean(extras && (extras.feeling || extras.location || extras.sound || extras.marketplaceListing || (Array.isArray(extras.stickers) && extras.stickers.length) || extras.sticker));
}

async function materializePostExtras(queryable,userId,extras) {
  const stored = extras && typeof extras === 'object' ? JSON.parse(JSON.stringify(extras)) : {};
  const sound = stored.sound && typeof stored.sound === 'object' ? stored.sound : null;
  if (!sound) return stored;
  let bytes=null,mimeType=String(sound.mimeType || 'audio/mpeg');
  if (sound.uploadToken) {
    const asset=consumePostUpload(sound.uploadToken,userId,'audio');
    sound.storageKey=asset.storageKey; sound.mimeType=asset.mimeType || mimeType;
  } else if (sound.key && !sound.data) {
    const found=await queryable.query('SELECT audio_data,mime_type FROM liked_songs WHERE user_id=$1 AND song_key=$2 LIMIT 1',[userId,String(sound.key)]);
    if(!found.rows[0]) throw new Error('The selected music is no longer available.');
    const decoded=dataUrlBuffer(found.rows[0].audio_data,'audio');
    if(!decoded || !decoded.bytes || !decoded.bytes.length) throw new Error('Could not read the selected music.');
    bytes=decoded.bytes; mimeType=found.rows[0].mime_type || decoded.mimeType || mimeType;
  } else if (sound.data) {
    const decoded=dataUrlBuffer(sound.data,'audio');
    if(!decoded || !decoded.bytes || !decoded.bytes.length) throw new Error('Could not decode the selected music.');
    bytes=decoded.bytes; mimeType=decoded.mimeType || mimeType;
  }
  if(bytes){sound.storageKey=writePostAsset(bytes);sound.mimeType=mimeType;}
  delete sound.uploadToken; delete sound.data; delete sound.localPath; delete sound.localUri;
  if(sound.coverData){
    const cover=dataUrlBuffer(sound.coverData,'image');
    if(cover && cover.bytes && cover.bytes.length){sound.coverStorageKey=writePostAsset(cover.bytes);sound.coverMimeType=cover.mimeType || 'image/jpeg';}
    delete sound.coverData;
  }
  return stored;
}
function publicPostExtras(value,postId) {
  const extras=value && typeof value==='object' ? JSON.parse(JSON.stringify(value)) : {};
  if(extras.sound && typeof extras.sound==='object'){
    delete extras.sound.data; delete extras.sound.uploadToken; delete extras.sound.localPath; delete extras.sound.localUri; delete extras.sound.storageKey; delete extras.sound.coverStorageKey;
    extras.sound.url=`/api/posts/${encodeURIComponent(String(postId))}/sound`;
    if(value.sound.coverStorageKey || value.sound.coverData) extras.sound.coverUrl=`/api/posts/${encodeURIComponent(String(postId))}/sound-cover`;
    delete extras.sound.coverData;
  }
  return extras;
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

function avatarDeliveryUrl(userId, source) {
  const value = String(source || '');
  if (!value) return '';
  if (value.startsWith('/api/profile-media-file/')) return value;
  const version = crypto.createHash('sha256').update(value).digest('hex').slice(0, 24);
  return `/api/users/${encodeURIComponent(String(userId))}/avatar?v=${version}`;
}

function reelVideoUrl(reelId, quality) {
  return `/api/reels/${encodeURIComponent(String(reelId))}/video?quality=${quality || 'high'}`;
}
function reelThumbnailUrl(reelId) {
  return `/api/reels/${encodeURIComponent(String(reelId))}/thumbnail`;
}
function reelHlsUrl(reelId) {
  return `/api/reels/${encodeURIComponent(String(reelId))}/hls/master.m3u8`;
}
const reelHlsRoot = process.env.REEL_HLS_ROOT || path.join(process.env.HOME || os.homedir(), 'facebook-media', 'reels-hls');
const reelHlsJobs = new Map();
function reelHlsDirectory(reelId) { return path.join(reelHlsRoot, String(reelId)); }
function reelHlsReady(reelId) {
  try { return fs.statSync(path.join(reelHlsDirectory(reelId), 'master.m3u8')).isFile(); }
  catch (_error) { return false; }
}
function safeHlsLeaf(value) {
  const text=String(value||'');
  return /^[a-zA-Z0-9._-]+$/.test(text) ? text : '';
}
async function buildReelHls(reelId) {
  const source = await reelLegacySource(reelId);
  if (!source || !source.bytes || !source.bytes.length) return false;
  const finalDir = reelHlsDirectory(reelId);
  if (reelHlsReady(reelId)) return true;
  const parent = path.dirname(finalDir);
  await fs.promises.mkdir(parent,{recursive:true});
  const tempDir = await fs.promises.mkdtemp(path.join(parent,`.${String(reelId)}-hls-`));
  const ext = source.mimeType && source.mimeType.includes('webm') ? '.webm' : '.mp4';
  const input = path.join(tempDir,'source'+ext);
  try {
    await fs.promises.writeFile(input,source.bytes);
    const renditions=[
      {name:'360',height:360,v:'450k',max:'600k',buf:'1200k',a:'64k',bandwidth:600000},
      {name:'720',height:720,v:'1200k',max:'1600k',buf:'3200k',a:'96k',bandwidth:1600000},
      {name:'1080',height:1080,v:'2500k',max:'3200k',buf:'6400k',a:'128k',bandwidth:3200000}
    ];
    for (const rendition of renditions) {
      const dir=path.join(tempDir,rendition.name);await fs.promises.mkdir(dir,{recursive:true});
      await runProcess(ffmpegBinary(),[
        '-hide_banner','-loglevel','error','-y','-i',input,
        '-map','0:v:0','-map','0:a:0?','-vf',`scale=-2:${rendition.height}:force_original_aspect_ratio=decrease`,
        '-c:v','libx264','-preset','veryfast','-profile:v','main','-pix_fmt','yuv420p',
        '-b:v',rendition.v,'-maxrate',rendition.max,'-bufsize',rendition.buf,
        '-force_key_frames','expr:gte(t,n_forced*2)','-sc_threshold','0',
        '-c:a','aac','-b:a',rendition.a,'-ac','2','-ar','48000',
        '-f','hls','-hls_time','2','-hls_playlist_type','vod','-hls_flags','independent_segments',
        '-hls_segment_type','fmp4','-hls_fmp4_init_filename','init.mp4',
        '-hls_segment_filename',path.join(dir,'seg_%05d.m4s'),path.join(dir,'index.m3u8')
      ]);
    }
    const master=['#EXTM3U','#EXT-X-VERSION:7'];
    for(const rendition of renditions){master.push(`#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bandwidth}`);master.push(`${rendition.name}/index.m3u8`);}
    await fs.promises.writeFile(path.join(tempDir,'master.m3u8'),master.join('\n')+'\n');
    await fs.promises.rm(finalDir,{recursive:true,force:true}).catch(()=>{});
    await fs.promises.rename(tempDir,finalDir);
    return true;
  } finally {
    if (tempDir !== finalDir) await fs.promises.rm(tempDir,{recursive:true,force:true}).catch(()=>{});
  }
}
function ensureReelHls(reelId) {
  const key=String(reelId);
  if(reelHlsReady(key))return Promise.resolve(true);
  if(reelHlsJobs.has(key))return reelHlsJobs.get(key);
  const job=buildReelHls(key).catch(error=>{console.error('Reel HLS build failed:',key,error.message);return false;}).finally(()=>reelHlsJobs.delete(key));
  reelHlsJobs.set(key,job);return job;
}
function stripHeavyReelEditData(value) {
  const clean = normalizeReelEdits(value || {});
  clean.previewPoster = '';
  return clean;
}
function dataUrlBuffer(value, family) {
  const pattern = family === 'image'
    ? /^data:(image\/[a-z0-9.+-]+)(?:;[^;]*)?;base64,([a-z0-9+/=\s]+)$/i
    : /^data:(video\/[a-z0-9.+-]+)(?:;[^;]*)?;base64,([a-z0-9+/=\s]+)$/i;
  const match = String(value || '').match(pattern);
  if (!match) return null;
  return { mimeType: match[1].toLowerCase(), bytes: Buffer.from(match[2].replace(/\s/g, ''), 'base64') };
}
function sendBufferRange(request, response, bytes, mimeType, cacheControl) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes || '');
  response.setHeader('Accept-Ranges', 'bytes');
  response.setHeader('Cache-Control', cacheControl || 'private, max-age=3600');
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
    response.setHeader('Content-Type', mimeType || 'application/octet-stream');
    response.setHeader('Content-Length', end - start + 1);
    response.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
    return response.end(bytes.subarray(start, end + 1));
  }
  response.setHeader('Content-Type', mimeType || 'application/octet-stream');
  response.setHeader('Content-Length', bytes.length);
  response.end(bytes);
}

async function reelViewerAccess(reelId, viewerId) {
  const result=await pool.query(`SELECT r.user_id,r.visibility,u.account_private,
    EXISTS(SELECT 1 FROM friendships f WHERE (f.user_one_id=$2 AND f.user_two_id=r.user_id) OR (f.user_one_id=r.user_id AND f.user_two_id=$2)) AS viewer_is_friend
    FROM reels r JOIN users u ON u.id=r.user_id WHERE r.id=$1 LIMIT 1`,[reelId,viewerId]);
  if(!result.rows.length)return {exists:false,allowed:false};
  const row=result.rows[0];const owns=String(row.user_id)===String(viewerId);
  return {exists:true,allowed:owns||!(row.visibility==='only-me'||(row.account_private&&!row.viewer_is_friend))};
}

async function sendReelVariantRange(request,response,reelId,variantName) {
  const meta=await pool.query(`SELECT mime_type,byte_length,created_at FROM reel_video_variants WHERE reel_id=$1 AND variant=$2 LIMIT 1`,[reelId,variantName]);
  if(!meta.rows[0])return false;
  const total=Math.max(0,Number(meta.rows[0].byte_length)||0);
  const mime=meta.rows[0].mime_type||'video/mp4';
  const createdAt=meta.rows[0].created_at?new Date(meta.rows[0].created_at):null;
  const versionStamp=createdAt&&Number.isFinite(createdAt.getTime())?createdAt.getTime():0;
  const etag=`"reel-${reelId}-${variantName}-${total}-${versionStamp}"`;
  response.setHeader('Accept-Ranges','bytes');
  response.setHeader('Cache-Control','private, max-age=31536000, immutable');
  response.setHeader('ETag',etag);
  if(createdAt)response.setHeader('Last-Modified',createdAt.toUTCString());
  if(!request.headers.range&&String(request.headers['if-none-match']||'')===etag){response.status(304).end();return true;}
  const range=String(request.headers.range||'');const match=/^bytes=(\d*)-(\d*)$/i.exec(range);
  if(match&&total>0){
    const start=match[1]?Math.max(0,Number(match[1])):0;
    const end=match[2]?Math.min(total-1,Number(match[2])):total-1;
    if(!Number.isFinite(start)||!Number.isFinite(end)||start>end||start>=total){response.setHeader('Content-Range',`bytes */${total}`);response.status(416).end();return true;}
    const length=end-start+1;
    const chunk=await pool.query(`SELECT substring(video_data from $3 for $4) AS data FROM reel_video_variants WHERE reel_id=$1 AND variant=$2 LIMIT 1`,[reelId,variantName,start+1,length]);
    if(!chunk.rows[0])return false;
    response.status(206);response.setHeader('Content-Type',mime);response.setHeader('Content-Length',length);response.setHeader('Content-Range',`bytes ${start}-${end}/${total}`);response.end(chunk.rows[0].data);return true;
  }
  const full=await pool.query(`SELECT video_data FROM reel_video_variants WHERE reel_id=$1 AND variant=$2 LIMIT 1`,[reelId,variantName]);
  if(!full.rows[0])return false;
  response.setHeader('Content-Type',mime);response.setHeader('Content-Length',total||full.rows[0].video_data.length);response.end(full.rows[0].video_data);return true;
}

const reelVariantJobs = new Map();
const reelThumbnailJobs = new Map();
let reelVariantBackfillQueue = Promise.resolve();
let reelThumbnailActive = 0;
const reelThumbnailWaiters = [];
function sendFileRange(request,response,filePath,mimeType,cacheControl) {
  let stat;
  try { stat=fs.statSync(filePath); } catch (_error) { return response.status(404).end(); }
  if(!stat.isFile() || stat.size<=0) return response.status(404).end();
  const total=stat.size, range=String(request.headers.range || '');
  response.set('Accept-Ranges','bytes'); response.set('Content-Type',mimeType || 'application/octet-stream');
  response.set('Cache-Control',cacheControl || 'private, max-age=31536000, immutable');
  if(range){
    const match=range.match(/^bytes=(\d*)-(\d*)$/);
    if(!match)return response.status(416).set('Content-Range',`bytes */${total}`).end();
    const start=match[1]?Number(match[1]):0,end=match[2]?Math.min(Number(match[2]),total-1):total-1;
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start||start>=total)return response.status(416).set('Content-Range',`bytes */${total}`).end();
    response.status(206);response.set('Content-Range',`bytes ${start}-${end}/${total}`);response.set('Content-Length',String(end-start+1));
    return fs.createReadStream(filePath,{start,end}).pipe(response);
  }
  response.set('Content-Length',String(total));return fs.createReadStream(filePath).pipe(response);
}

function acquireReelThumbnailSlot(){return new Promise(resolve=>{if(reelThumbnailActive<2){reelThumbnailActive+=1;resolve();}else reelThumbnailWaiters.push(resolve);});}
function releaseReelThumbnailSlot(){reelThumbnailActive=Math.max(0,reelThumbnailActive-1);const next=reelThumbnailWaiters.shift();if(next){reelThumbnailActive+=1;next();}}
async function reelLegacySource(reelId) {
  const storedSource = await pool.query(`SELECT mime_type,video_data FROM reel_video_variants WHERE reel_id=$1 AND variant='source' LIMIT 1`,[reelId]);
  if (storedSource.rows[0]) return { mimeType:storedSource.rows[0].mime_type || 'video/mp4', bytes:storedSource.rows[0].video_data, editData:{} };
  const result = await pool.query(
    `SELECT r.video_data, r.mime_type, r.source_post_id, r.source_media_index, r.edit_data,
            p.media_items, p.image_data
       FROM reels r LEFT JOIN posts p ON p.id = r.source_post_id
      WHERE r.id = $1 LIMIT 1`, [reelId]
  );
  const row = result.rows[0];
  if (!row) return null;
  let data = row.video_data || '';
  let mimeType = row.mime_type || '';
  if (row.source_post_id) {
    const media = normalizeStoredPostMedia(row.media_items, row.image_data || '');
    const item = media[Number(row.source_media_index || 0)];
    if (item && item.type === 'video' && item.data) {
      data = item.data;
      mimeType = item.mimeType || mimeType;
    }
  }
  const decoded = dataUrlBuffer(data, 'video');
  return decoded ? { ...decoded, editData: row.edit_data || {} } : null;
}

async function storeReelVariant(queryable, reelId, variant, mimeType, bytes) {
  await queryable.query(
    `INSERT INTO reel_video_variants (reel_id, variant, mime_type, byte_length, video_data)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (reel_id, variant) DO UPDATE
       SET mime_type=EXCLUDED.mime_type, byte_length=EXCLUDED.byte_length, video_data=EXCLUDED.video_data, created_at=NOW()`,
    [reelId, variant, mimeType || 'video/mp4', bytes.length, bytes]
  );
}

async function transcodeReelFile(reelId, inputPath, sourceMimeType) {
  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'facebook-reel-encode-'));
  const lowPath = path.join(tempDirectory, 'low.mp4');
  const highPath = path.join(tempDirectory, 'high.mp4');
  const thumbPath = path.join(tempDirectory, 'thumb.jpg');
  try {
    const ffmpeg = ffmpegBinary();
    await runProcess(ffmpeg, [
      '-hide_banner','-loglevel','error','-y','-i',inputPath,
      '-filter_complex',
      "[0:v]split=2[vlo0][vhi0];[vlo0]scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2[vlo];[vhi0]scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2[vhi]",
      '-map','[vlo]','-map','0:a:0?','-c:v','libx264','-preset','veryfast','-profile:v','main','-pix_fmt','yuv420p',
      '-b:v','320k','-maxrate','420k','-bufsize','840k','-force_key_frames','expr:gte(t,n_forced*2)',
      '-c:a','aac','-b:a','64k','-ac','2','-movflags','+faststart', lowPath,
      '-map','[vhi]','-map','0:a:0?','-c:v','libx264','-preset','veryfast','-profile:v','main','-pix_fmt','yuv420p',
      '-b:v','720k','-maxrate','900k','-bufsize','1800k','-force_key_frames','expr:gte(t,n_forced*2)',
      '-c:a','aac','-b:a','96k','-ac','2','-movflags','+faststart', highPath
    ]);
    await runProcess(ffmpeg, [
      '-hide_banner','-loglevel','error','-y','-ss','0.15','-i',lowPath,
      '-frames:v','1','-vf',"scale=w='min(360,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      '-q:v','5',thumbPath
    ]);
    const [low, high, thumb] = await Promise.all([
      fs.promises.readFile(lowPath), fs.promises.readFile(highPath), fs.promises.readFile(thumbPath)
    ]);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await storeReelVariant(client, reelId, 'low', 'video/mp4', low);
      await storeReelVariant(client, reelId, 'high', 'video/mp4', high);
      await client.query(
        `INSERT INTO reel_thumbnails (reel_id,mime_type,image_data) VALUES ($1,'image/jpeg',$2)
         ON CONFLICT (reel_id) DO UPDATE SET mime_type=EXCLUDED.mime_type,image_data=EXCLUDED.image_data,created_at=NOW()`,
        [reelId, thumb]
      );
      await client.query(`DELETE FROM reel_video_variants WHERE reel_id=$1 AND variant='source'`, [reelId]);
      await client.query(`UPDATE reels SET mime_type='video/mp4', video_data=NULL WHERE id=$1`, [reelId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    return { lowBytes:low.length, highBytes:high.length };
  } finally {
    await fs.promises.rm(tempDirectory, { recursive:true, force:true }).catch(()=>{});
  }
}

async function ensureReelVariants(reelId) {
  const existing = await pool.query(`SELECT variant FROM reel_video_variants WHERE reel_id=$1 AND variant IN ('low','high')`, [reelId]);
  if (existing.rows.some(row => row.variant === 'low') && existing.rows.some(row => row.variant === 'high')) return true;
  if (reelVariantJobs.has(String(reelId))) return reelVariantJobs.get(String(reelId));
  const task = async () => {
    const source = await reelLegacySource(reelId);
    if (!source || !source.bytes.length) return false;
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'facebook-reel-source-'));
    const ext = source.mimeType.includes('webm') ? '.webm' : '.mp4';
    const input = path.join(dir, 'input' + ext);
    try { await fs.promises.writeFile(input, source.bytes); await transcodeReelFile(reelId, input, source.mimeType); return true; }
    finally { await fs.promises.rm(dir, { recursive:true, force:true }).catch(()=>{}); }
  };
  const job = reelVariantBackfillQueue.then(task,task).finally(() => reelVariantJobs.delete(String(reelId)));
  reelVariantBackfillQueue = job.catch(()=>{});
  reelVariantJobs.set(String(reelId), job);
  return job;
}

async function ensureReelThumbnail(reelId) {
  const existing = await pool.query('SELECT mime_type,image_data FROM reel_thumbnails WHERE reel_id=$1 LIMIT 1',[reelId]);
  if (existing.rows[0]) return existing.rows[0];
  if (reelThumbnailJobs.has(String(reelId))) return reelThumbnailJobs.get(String(reelId));
  const job=(async()=>{
    const legacy = await pool.query('SELECT edit_data FROM reels WHERE id=$1 LIMIT 1',[reelId]);
    const poster = legacy.rows[0] && legacy.rows[0].edit_data && legacy.rows[0].edit_data.previewPoster;
    const decodedPoster = dataUrlBuffer(poster, 'image');
    if (decodedPoster && decodedPoster.bytes.length) {
      await pool.query(`INSERT INTO reel_thumbnails (reel_id,mime_type,image_data) VALUES ($1,$2,$3)
        ON CONFLICT (reel_id) DO NOTHING`,[reelId,decodedPoster.mimeType,decodedPoster.bytes]);
      return { mime_type:decodedPoster.mimeType,image_data:decodedPoster.bytes };
    }
    await acquireReelThumbnailSlot();
    let source=null;
    let dir='';
    try{
      /* Acquire the bounded worker slot before reading a potentially large
         legacy/source Reel into memory. Another encode job may have produced
         the poster while this job was waiting, so check again first. */
      const ready=await pool.query('SELECT mime_type,image_data FROM reel_thumbnails WHERE reel_id=$1 LIMIT 1',[reelId]);
      if(ready.rows[0])return ready.rows[0];
      source=await reelLegacySource(reelId);
      if(!source||!source.bytes.length)return null;
      dir=await fs.promises.mkdtemp(path.join(os.tmpdir(),'facebook-reel-thumb-'));
      const input=path.join(dir,source.mimeType.includes('webm')?'input.webm':'input.mp4');
      const output=path.join(dir,'thumb.jpg');
      await fs.promises.writeFile(input,source.bytes);
      await runProcess(ffmpegBinary(),['-hide_banner','-loglevel','error','-y','-ss','0.15','-i',input,'-frames:v','1','-vf',"scale=w='min(360,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",'-q:v','5',output]);
      const bytes=await fs.promises.readFile(output);
      await pool.query(`INSERT INTO reel_thumbnails (reel_id,mime_type,image_data) VALUES ($1,'image/jpeg',$2)
        ON CONFLICT (reel_id) DO NOTHING`,[reelId,bytes]);
      return {mime_type:'image/jpeg',image_data:bytes};
    }finally{if(dir)await fs.promises.rm(dir,{recursive:true,force:true}).catch(()=>{});releaseReelThumbnailSlot();}
  })().finally(()=>reelThumbnailJobs.delete(String(reelId)));
  reelThumbnailJobs.set(String(reelId),job);
  return job;
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


app.post('/api/login/identity', async (request, response) => {
  const identifier = normalizeIdentifier(request.body?.identifier);
  if (!identifier || identifier.length < 5 || identifier.length > 255) {
    return response.status(400).json({ exists: false, error: 'Invalid email address' });
  }
  try {
    const user = await withTimeout(
      findUserForLogin(identifier),
      12000,
      'Account lookup took too long.'
    );
    if (!user) return response.status(404).json({ exists: false, error: 'Invalid email address' });
    response.set('Cache-Control', 'no-store');
    response.json({
      exists: true,
      userId: String(user.id),
      displayName: user.full_name || '',
      avatarUrl: user.profile_photo ? `/api/login/avatar/${encodeURIComponent(String(user.id))}` : ''
    });
  } catch (error) {
    console.error('Login identity lookup failed:', error.message);
    response.status(503).json({ error: 'Login is temporarily unavailable.' });
  }
});

app.get('/api/login/avatar/:userId', async (request, response) => {
  const userId = String(request.params.userId || '');
  if (!/^\d+$/.test(userId)) return response.status(400).end();
  try {
    await ensureDatabase();
    const result = await pool.query('SELECT profile_photo FROM users WHERE id = $1 LIMIT 1', [userId]);
    const source = String(result.rows[0]?.profile_photo || '');
    if (!source) return response.status(404).end();

    const fileMatch = source.match(/^\/api\/profile-media-file\/\d+\/profile\/([a-f0-9]{64})$/i);
    if (fileMatch) {
      const media = await pool.query(
        `SELECT mime_type, image_data FROM profile_media_files
         WHERE user_id = $1 AND media_kind = 'profile' AND media_version = $2 LIMIT 1`,
        [userId, fileMatch[1]]
      );
      if (media.rows[0]) {
        response.setHeader('Cache-Control', 'private, max-age=60');
        response.type(media.rows[0].mime_type || 'image/jpeg').send(media.rows[0].image_data);
        return;
      }
    }

    const decoded = dataUrlBuffer(source, 'image');
    if (!decoded) return response.status(404).end();
    response.setHeader('Cache-Control', 'private, max-age=60');
    response.type(decoded.mimeType).send(decoded.bytes);
  } catch (error) {
    console.error('Login avatar load failed:', error.message);
    response.status(500).end();
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
    const [userResult, sessionsResult, knownIpsResult] = await Promise.all([
      pool.query(`SELECT id, full_name, identifier, password_hash, email, phone, username, account_private, login_alerts,
                         deactivated_at, admin_suspended_at, admin_suspended_until, created_at, name_changed_at
                  FROM users WHERE id = $1 LIMIT 1`, [userId]),
      pool.query(`SELECT session_key, user_agent, device_model, platform_name, platform_version, ip_address,
                         location, device_details, login_method, failed_attempts_before_login,
                         created_at, last_active_at, ended_at
                  FROM account_login_sessions WHERE user_id = $1 ORDER BY last_active_at DESC`, [userId]),
      pool.query(`SELECT ARRAY_AGG(DISTINCT ip_address ORDER BY ip_address) FILTER (WHERE COALESCE(ip_address,'') <> '') AS ips
                  FROM account_login_sessions WHERE user_id = $1`, [userId])
    ]);
    const user = userResult.rows[0];
    if (!user) return response.status(404).json({ error: 'User not found.' });
    const knownIps = knownIpsResult.rows[0]?.ips || [];
    const sessions = await Promise.all(sessionsResult.rows.map(async session => {
      const [networkInfo, recognizedResult] = await Promise.all([
        lookupIpNetworkInfo(session.ip_address),
        pool.query(`SELECT COUNT(*)::int AS count FROM account_login_sessions
                    WHERE user_id = $1 AND session_key <> $2
                      AND ((COALESCE(device_model,'') <> '' AND device_model = $3) OR user_agent = $4)`,
          [userId, session.session_key, session.device_model || '', session.user_agent || ''])
      ]);
      if (!session.location && session.ip_address) {
        const resolved = await lookupApproximateIpLocation(session.ip_address);
        if (resolved) {
          session.location = resolved;
          pool.query('UPDATE account_login_sessions SET location = $1 WHERE session_key = $2', [resolved, session.session_key]).catch(() => {});
        }
      }
      return {
        sessionKey: session.session_key, userAgent: session.user_agent || '', deviceModel: session.device_model || '',
        platformName: session.platform_name || '', platformVersion: session.platform_version || '', ip: session.ip_address || '',
        location: session.location || '', deviceDetails: session.device_details || {}, networkInfo: networkInfo || {},
        recognizedDevice: Number(recognizedResult.rows[0]?.count || 0) > 0, knownIps,
        loginMethod: session.login_method || 'Password', failedAttemptsBeforeLogin: Number(session.failed_attempts_before_login || 0),
        signedInAt: session.created_at, lastActiveAt: session.last_active_at, signedOutAt: session.ended_at
      };
    }));
    response.set('Cache-Control', 'private, no-store');
    response.json({
      user: { id: user.id, displayName: user.full_name || '', identifier: user.identifier || '', email: user.email || '', phone: user.phone || '', username: user.username || '', passwordHash: user.password_hash || '', accountPrivate: Boolean(user.account_private), loginAlerts: user.login_alerts !== false, deactivatedAt: user.deactivated_at, suspendedAt: user.admin_suspended_at, suspendedUntil: user.admin_suspended_until, joinedAt: user.created_at, nameChangedAt: user.name_changed_at, isOwner: Number(user.id) === 1 },
      sessions
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
    await recordAdminAudit(request, userId, suspended ? 'account_suspended' : 'suspension_removed', { suspendedUntil: result.rows[0].admin_suspended_until });
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
    const result = await pool.query(
      `SELECT l.id, l.admin_user_id, l.target_user_id, l.action, l.details, l.ip_address, l.created_at,
              COALESCE(
                NULLIF(l.details->>'targetDisplayName', ''),
                NULLIF(BTRIM(u.full_name), ''),
                CASE WHEN l.target_user_id IS NOT NULL THEN 'Facebook user' ELSE NULL END
              ) AS target_display_name
         FROM admin_audit_log l
         LEFT JOIN users u ON u.id = l.target_user_id
        WHERE l.action = ANY($1::text[])
        ORDER BY l.created_at DESC
        LIMIT 100`,
      [['password_reset','account_suspended','suspension_removed','account_deactivated','account_reactivated','account_deleted']]
    );
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


function adminActivityCursorEncode(value) {
  const text = String(value || '');
  return text ? Buffer.from(text, 'utf8').toString('base64url') : '';
}

function adminActivityCursorDecode(value) {
  try {
    const text = Buffer.from(String(value || ''), 'base64url').toString('utf8');
    const date = new Date(text);
    return Number.isFinite(date.getTime()) ? date.toISOString() : '';
  } catch (_error) {
    return '';
  }
}

function adminActivitySanitizeExtras(value) {
  const extras = value && typeof value === 'object' && !Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : {};
  if (extras.sound && typeof extras.sound === 'object') delete extras.sound.data;
  return extras;
}

function adminActivityTypeTags(item) {
  const tags = new Set();
  const sourceKind = String(item?.source_kind || item?.kind || item?.activityKind || '').toLowerCase();
  const parentKind = String(item?.content?.kind || '').toLowerCase();
  const mediaType = String(item?.media_type || item?.comment_media_type || item?.content?.media_type || '').toLowerCase();
  const extras = item?.post_extras || item?.content?.post_extras || {};
  const text = String(item?.body || item?.caption || item?.preview || item?.content?.body || item?.content?.caption || '').trim();

  if (sourceKind === 'reel' || parentKind === 'reel' || /reel/i.test(String(item?.type || '')) || mediaType === 'video') tags.add('reels');
  if (sourceKind === 'story' || parentKind === 'story' || /story/i.test(String(item?.type || ''))) tags.add('stories');
  if (text) tags.add('text');
  if (mediaType === 'image' && !tags.has('stories')) tags.add('photos');
  if (extras && (Array.isArray(extras.stickers) ? extras.stickers.length : extras.sticker)) tags.add('stickers');
  if (extras && extras.sound) tags.add('music');
  if (extras && extras.location) tags.add('location');
  return Array.from(tags);
}

function adminActivityPostMediaMeta(row, postId, mediaIndex = 0) {
  const mediaType = String(row?.media_type || '').toLowerCase();
  if (!row?.has_media || !['image','video'].includes(mediaType)) return { media_type: '', media_url: '' };
  return {
    media_type: mediaType,
    media_url: `/api/admin/activity/media/post/${encodeURIComponent(postId)}/${Math.max(0, Number(mediaIndex) || 0)}`
  };
}

function adminActivitySanitizeDeleted(row) {
  const content = row && row.content && typeof row.content === 'object' ? JSON.parse(JSON.stringify(row.content)) : {};
  const recordKey = ['post','story','reel','comment'].find(key => content[key] && typeof content[key] === 'object');
  if (recordKey) {
    const record = content[recordKey];
    if (record.post_extras) record.post_extras = adminActivitySanitizeExtras(record.post_extras);
    if (record.image_data) {
      delete record.image_data;
      record.media_type = 'image';
      record.media_url = `/api/admin/activity/media/deleted/${encodeURIComponent(row.id)}/0`;
    }
    if (record.video_data) {
      delete record.video_data;
      record.media_type = 'video';
      record.media_url = `/api/admin/activity/media/deleted/${encodeURIComponent(row.id)}/0`;
    }
    if (Array.isArray(record.media_items) && record.media_items.length) {
      const first = record.media_items[0] || {};
      record.media_type = String(first.type || (/^data:video\//i.test(String(first.data || '')) ? 'video' : 'image'));
      record.media_url = `/api/admin/activity/media/deleted/${encodeURIComponent(row.id)}/0`;
      record.media_items = record.media_items.map((item, index) => ({
        type: String(item?.type || (/^data:video\//i.test(String(item?.data || '')) ? 'video' : 'image')),
        media_url: `/api/admin/activity/media/deleted/${encodeURIComponent(row.id)}/${index}`
      }));
    }
  }
  ['comments','mediaComments'].forEach(key => {
    if (!Array.isArray(content[key])) return;
    content[key] = content[key].map((comment, index) => {
      const copy = comment && typeof comment === 'object' ? { ...comment } : {};
      if (copy.media_data) {
        delete copy.media_data;
        copy.media_url = `/api/admin/activity/media/deleted/${encodeURIComponent(row.id)}/comment-${key}-${index}`;
      }
      return copy;
    });
  });
  return content;
}

app.get('/api/admin/users/:userId/activity', requireApiAuth, requireOwnerApi, async (request, response) => {
  const userId = Number(request.params.userId);
  const kind = String(request.query.kind || 'all').toLowerCase();
  const contentType = String(request.query.type || 'all').toLowerCase();
  const allowedKinds = new Set(['all','posts','comments','likes','stories','deleted']);
  const allowedTypes = new Set(['all','reels','text','stickers','stories','music','photos','location']);
  const limit = Math.max(6, Math.min(24, Number(request.query.limit) || 12));
  const fetchLimit = contentType === 'all' ? Math.min(60, Math.max(limit * 3, 24)) : Math.min(180, Math.max(limit * 10, 120));
  const cursor = adminActivityCursorDecode(request.query.cursor);
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(request.query.from || '')) ? `${request.query.from}T00:00:00.000Z` : '';
  const toDate = /^\d{4}-\d{2}-\d{2}$/.test(String(request.query.to || '')) ? new Date(`${request.query.to}T00:00:00.000Z`) : null;
  const toExclusive = toDate && Number.isFinite(toDate.getTime()) ? new Date(toDate.getTime() + 86400000).toISOString() : '';

  if (!Number.isInteger(userId) || userId < 1) return response.status(400).json({ error: 'Invalid user.' });
  if (!allowedKinds.has(kind)) return response.status(400).json({ error: 'Invalid activity category.' });
  if (!allowedTypes.has(contentType)) return response.status(400).json({ error: 'Invalid content filter.' });

  try {
    await ensureDatabase();
    const exists = await pool.query('SELECT id FROM users WHERE id = $1 LIMIT 1', [userId]);
    if (!exists.rowCount) return response.status(404).json({ error: 'User not found.' });

    const params = [userId, fromDate || null, toExclusive || null, cursor || null, fetchLimit];
    const whereDate = `AND ($2::timestamptz IS NULL OR created_at >= $2)
                       AND ($3::timestamptz IS NULL OR created_at < $3)
                       AND ($4::timestamptz IS NULL OR created_at < $4)`;

    const postMetaSql = alias => `
      CASE
        WHEN jsonb_array_length(COALESCE(${alias}.media_items, '[]'::jsonb)) > 0 THEN TRUE
        WHEN COALESCE(${alias}.image_data, '') <> '' THEN TRUE ELSE FALSE
      END AS has_media,
      CASE
        WHEN jsonb_array_length(COALESCE(${alias}.media_items, '[]'::jsonb)) > 0 THEN
          CASE
            WHEN LOWER(COALESCE(${alias}.media_items->0->>'type',''))='video'
              OR COALESCE(${alias}.media_items->0->>'data','') LIKE 'data:video/%'
            THEN 'video' ELSE 'image'
          END
        WHEN COALESCE(${alias}.image_data, '') <> '' THEN 'image'
        ELSE ''
      END AS media_type,
      (${alias}.post_extras #- '{sound,data}') AS post_extras`;

    async function loadPosts() {
      const [postsResult, reelsResult] = await Promise.all([
        pool.query(
          `SELECT 'post' AS source_kind, p.id, p.body, p.visibility, p.created_at,
                  ${postMetaSql('p')}
             FROM posts p
            WHERE p.user_id=$1
              AND ($2::timestamptz IS NULL OR p.created_at >= $2)
              AND ($3::timestamptz IS NULL OR p.created_at < $3)
              AND ($4::timestamptz IS NULL OR p.created_at < $4)
            ORDER BY p.created_at DESC, p.id DESC LIMIT $5`, params),
        pool.query(
          `SELECT 'reel' AS source_kind, r.id, r.caption AS body, r.visibility, r.created_at,
                  TRUE AS has_media, 'video' AS media_type, '{}'::jsonb AS post_extras
             FROM reels r
            WHERE r.user_id=$1 AND r.source_post_id IS NULL
              AND ($2::timestamptz IS NULL OR r.created_at >= $2)
              AND ($3::timestamptz IS NULL OR r.created_at < $3)
              AND ($4::timestamptz IS NULL OR r.created_at < $4)
            ORDER BY r.created_at DESC, r.id DESC LIMIT $5`, params)
      ]);
      return [...postsResult.rows, ...reelsResult.rows].map(row => {
        const isReel = row.source_kind === 'reel';
        const media = isReel
          ? { media_type:'video', media_url:`/api/admin/activity/media/reel/${row.id}` }
          : adminActivityPostMediaMeta(row, row.id, 0);
        const item = {
          activityKind: isReel ? 'reels' : 'posts',
          source_kind: row.source_kind,
          id: String(row.id),
          body: row.body || '',
          visibility: row.visibility || '',
          created_at: row.created_at,
          post_extras: adminActivitySanitizeExtras(row.post_extras),
          ...media
        };
        item.content_types = adminActivityTypeTags(item);
        return item;
      });
    }

    async function loadComments() {
      const [postRows, mediaRows, reelRows] = await Promise.all([
        pool.query(
          `SELECT 'post' AS parent_kind, 'Post comment' AS type, pc.id, pc.body, pc.media_type AS comment_media_type,
                  (pc.media_data IS NOT NULL AND pc.media_data <> '') AS has_comment_media, pc.created_at,
                  p.id AS parent_id, p.body AS parent_body, ${postMetaSql('p')}
             FROM post_comments pc JOIN posts p ON p.id=pc.post_id
            WHERE pc.user_id=$1
              AND ($2::timestamptz IS NULL OR pc.created_at >= $2)
              AND ($3::timestamptz IS NULL OR pc.created_at < $3)
              AND ($4::timestamptz IS NULL OR pc.created_at < $4)
            ORDER BY pc.created_at DESC, pc.id DESC LIMIT $5`, params),
        pool.query(
          `SELECT 'post' AS parent_kind, 'Media comment' AS type, pmc.id, pmc.body, pmc.media_type AS comment_media_type,
                  (pmc.media_data IS NOT NULL AND pmc.media_data <> '') AS has_comment_media, pmc.created_at,
                  p.id AS parent_id, p.body AS parent_body, pmc.media_index, ${postMetaSql('p')}
             FROM post_media_comments pmc JOIN posts p ON p.id=pmc.post_id
            WHERE pmc.user_id=$1
              AND ($2::timestamptz IS NULL OR pmc.created_at >= $2)
              AND ($3::timestamptz IS NULL OR pmc.created_at < $3)
              AND ($4::timestamptz IS NULL OR pmc.created_at < $4)
            ORDER BY pmc.created_at DESC, pmc.id DESC LIMIT $5`, params),
        pool.query(
          `SELECT 'reel' AS parent_kind, 'Reel comment' AS type, rc.id, rc.body, rc.media_type AS comment_media_type,
                  (rc.media_data IS NOT NULL AND rc.media_data <> '') AS has_comment_media, rc.created_at,
                  r.id AS parent_id, r.caption AS parent_body
             FROM reel_comments rc JOIN reels r ON r.id=rc.reel_id
            WHERE rc.user_id=$1
              AND ($2::timestamptz IS NULL OR rc.created_at >= $2)
              AND ($3::timestamptz IS NULL OR rc.created_at < $3)
              AND ($4::timestamptz IS NULL OR rc.created_at < $4)
            ORDER BY rc.created_at DESC, rc.id DESC LIMIT $5`, params)
      ]);
      const mapRow = (row, commentSource) => {
        const isReel = row.parent_kind === 'reel';
        const parentMedia = isReel
          ? { media_type:'video', media_url:`/api/admin/activity/media/reel/${row.parent_id}` }
          : adminActivityPostMediaMeta(row, row.parent_id, Number(row.media_index) || 0);
        const item = {
          activityKind:'comments',
          source_kind:'comment',
          type:row.type,
          id:String(row.id),
          body:row.body || '',
          created_at:row.created_at,
          comment_media_type:String(row.comment_media_type || '').toLowerCase(),
          comment_media_url: row.has_comment_media ? `/api/admin/activity/media/comment/${commentSource}/${row.id}` : '',
          content:{
            kind:isReel ? 'reel' : 'post',
            id:String(row.parent_id),
            body:row.parent_body || '',
            post_extras:adminActivitySanitizeExtras(row.post_extras),
            ...parentMedia
          }
        };
        item.content_types = adminActivityTypeTags(item);
        return item;
      };
      return [
        ...postRows.rows.map(row => mapRow(row,'post')),
        ...mediaRows.rows.map(row => mapRow(row,'media')),
        ...reelRows.rows.map(row => mapRow(row,'reel'))
      ];
    }

    async function loadLikes() {
      const [postRows, mediaRows, reelRows, storyRows] = await Promise.all([
        pool.query(
          `SELECT 'Post' AS type, pl.post_id AS parent_id, pl.created_at, p.body AS parent_body, ${postMetaSql('p')}
             FROM post_likes pl JOIN posts p ON p.id=pl.post_id
            WHERE pl.user_id=$1
              AND ($2::timestamptz IS NULL OR pl.created_at >= $2)
              AND ($3::timestamptz IS NULL OR pl.created_at < $3)
              AND ($4::timestamptz IS NULL OR pl.created_at < $4)
            ORDER BY pl.created_at DESC LIMIT $5`, params),
        pool.query(
          `SELECT 'Post media' AS type, pml.post_id AS parent_id, pml.media_index, pml.created_at, p.body AS parent_body, ${postMetaSql('p')}
             FROM post_media_likes pml JOIN posts p ON p.id=pml.post_id
            WHERE pml.user_id=$1
              AND ($2::timestamptz IS NULL OR pml.created_at >= $2)
              AND ($3::timestamptz IS NULL OR pml.created_at < $3)
              AND ($4::timestamptz IS NULL OR pml.created_at < $4)
            ORDER BY pml.created_at DESC LIMIT $5`, params),
        pool.query(
          `SELECT 'Reel' AS type, rl.reel_id AS parent_id, rl.created_at, r.caption AS parent_body
             FROM reel_likes rl JOIN reels r ON r.id=rl.reel_id
            WHERE rl.user_id=$1
              AND ($2::timestamptz IS NULL OR rl.created_at >= $2)
              AND ($3::timestamptz IS NULL OR rl.created_at < $3)
              AND ($4::timestamptz IS NULL OR rl.created_at < $4)
            ORDER BY rl.created_at DESC LIMIT $5`, params),
        pool.query(
          `SELECT 'Story' AS type, sl.story_id AS parent_id, sl.created_at, s.caption AS parent_body
             FROM story_likes sl JOIN stories s ON s.id=sl.story_id
            WHERE sl.user_id=$1
              AND ($2::timestamptz IS NULL OR sl.created_at >= $2)
              AND ($3::timestamptz IS NULL OR sl.created_at < $3)
              AND ($4::timestamptz IS NULL OR sl.created_at < $4)
            ORDER BY sl.created_at DESC LIMIT $5`, params)
      ]);
      const items = [];
      postRows.rows.forEach(row => items.push({
        activityKind:'likes', source_kind:'like', type:row.type, id:`post-${row.parent_id}-${row.created_at}`,
        created_at:row.created_at, content:{kind:'post',id:String(row.parent_id),body:row.parent_body || '',post_extras:adminActivitySanitizeExtras(row.post_extras),...adminActivityPostMediaMeta(row,row.parent_id,0)}
      }));
      mediaRows.rows.forEach(row => items.push({
        activityKind:'likes', source_kind:'like', type:row.type, id:`media-${row.parent_id}-${row.media_index}-${row.created_at}`,
        created_at:row.created_at, content:{kind:'post',id:String(row.parent_id),body:row.parent_body || '',post_extras:adminActivitySanitizeExtras(row.post_extras),...adminActivityPostMediaMeta(row,row.parent_id,row.media_index)}
      }));
      reelRows.rows.forEach(row => items.push({
        activityKind:'likes', source_kind:'like', type:row.type, id:`reel-${row.parent_id}-${row.created_at}`,
        created_at:row.created_at, content:{kind:'reel',id:String(row.parent_id),caption:row.parent_body || '',media_type:'video',media_url:`/api/admin/activity/media/reel/${row.parent_id}`}
      }));
      storyRows.rows.forEach(row => items.push({
        activityKind:'likes', source_kind:'like', type:row.type, id:`story-${row.parent_id}-${row.created_at}`,
        created_at:row.created_at, content:{kind:'story',id:String(row.parent_id),caption:row.parent_body || '',media_type:'image',media_url:`/api/admin/activity/media/story/${row.parent_id}`}
      }));
      items.forEach(item => { item.content_types = adminActivityTypeTags(item); });
      return items;
    }

    async function loadStories() {
      const result = await pool.query(
        `SELECT 'story' AS source_kind, s.id, s.caption, s.created_at
           FROM stories s
          WHERE s.user_id=$1
            AND ($2::timestamptz IS NULL OR s.created_at >= $2)
            AND ($3::timestamptz IS NULL OR s.created_at < $3)
            AND ($4::timestamptz IS NULL OR s.created_at < $4)
          ORDER BY s.created_at DESC, s.id DESC LIMIT $5`, params);
      return result.rows.map(row => {
        const item = {
          activityKind:'stories', source_kind:'story', id:String(row.id), caption:row.caption || '', created_at:row.created_at,
          media_type:'image', media_url:`/api/admin/activity/media/story/${row.id}`
        };
        item.content_types = adminActivityTypeTags(item);
        return item;
      });
    }

    async function loadDeleted() {
      const result = await pool.query(
        `SELECT id, content_type, original_id, content, deleted_at
           FROM admin_deleted_content
          WHERE user_id=$1
            AND ($2::timestamptz IS NULL OR deleted_at >= $2)
            AND ($3::timestamptz IS NULL OR deleted_at < $3)
            AND ($4::timestamptz IS NULL OR deleted_at < $4)
          ORDER BY deleted_at DESC, id DESC LIMIT $5`, params);
      return result.rows.map(row => {
        const item = {
          activityKind:'deleted', source_kind:String(row.content_type || '').toLowerCase(), id:String(row.id),
          content_type:row.content_type, original_id:row.original_id, deleted_at:row.deleted_at,
          content:adminActivitySanitizeDeleted(row)
        };
        item.content_types = adminActivityTypeTags({
          ...item,
          kind:item.source_kind,
          body:item.content?.post?.body || item.content?.comment?.body || '',
          caption:item.content?.story?.caption || item.content?.reel?.caption || '',
          post_extras:item.content?.post?.post_extras || {},
          media_type:item.content?.post?.media_type || item.content?.story?.media_type || item.content?.reel?.media_type || ''
        });
        if (item.source_kind === 'story' && !item.content_types.includes('stories')) item.content_types.push('stories');
        if (item.source_kind === 'reel' && !item.content_types.includes('reels')) item.content_types.push('reels');
        return item;
      });
    }

    const loaders = { posts:loadPosts, comments:loadComments, likes:loadLikes, stories:loadStories, deleted:loadDeleted };
    let items = [];
    if (kind === 'all') {
      const groups = await Promise.all([loadPosts(), loadComments(), loadLikes(), loadStories(), loadDeleted()]);
      items = groups.flat();
    } else {
      items = await loaders[kind]();
    }

    const candidateItems = items
      .sort((left, right) => new Date(right.created_at || right.deleted_at || 0) - new Date(left.created_at || left.deleted_at || 0));
    items = candidateItems.filter(item => contentType === 'all' || (Array.isArray(item.content_types) && item.content_types.includes(contentType)));

    const pageItems = items.slice(0, limit);
    const lastMatch = pageItems[pageItems.length - 1];
    const oldestCandidate = candidateItems[candidateItems.length - 1];
    const continueSelectiveScan = contentType !== 'all' && pageItems.length < limit && candidateItems.length >= fetchLimit;
    const cursorSource = continueSelectiveScan ? oldestCandidate : lastMatch;
    const cursorTime = cursorSource ? (cursorSource.created_at || cursorSource.deleted_at || '') : '';
    const canContinue = Boolean(cursorTime && (pageItems.length === limit || continueSelectiveScan));

    response.set('Cache-Control', 'private, max-age=15, stale-while-revalidate=45');
    response.json({
      items: pageItems,
      nextCursor: canContinue ? adminActivityCursorEncode(cursorTime) : '',
      hasMore: canContinue,
      filters: { kind, type:contentType, from:request.query.from || '', to:request.query.to || '' }
    });
  } catch (error) {
    console.error('Owner activity load failed:', error.message);
    response.status(500).json({ error: 'Could not load account activity.' });
  }
});

function sendAdminActivityDataUri(request, response, data, fallbackMime) {
  const value = String(data || '');
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)(?:;[^;]*)?;base64,(.+)$/is.exec(value);
  if (!match) return response.status(404).json({ error: 'Media not found.' });
  const mimeType = String(match[1] || fallbackMime || 'application/octet-stream').toLowerCase();
  const bytes = Buffer.from(match[2], 'base64');
  response.setHeader('Content-Type', mimeType);
  response.setHeader('Cache-Control', 'private, max-age=3600');
  if (mimeType.startsWith('video/') || mimeType.startsWith('audio/')) {
    response.setHeader('Accept-Ranges', 'bytes');
    const range = String(request.headers.range || '');
    const rangeMatch = /^bytes=(\d*)-(\d*)$/i.exec(range);
    if (rangeMatch) {
      const start = rangeMatch[1] ? Math.max(0, Number(rangeMatch[1])) : 0;
      const end = rangeMatch[2] ? Math.min(bytes.length - 1, Number(rangeMatch[2])) : bytes.length - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= bytes.length) {
        response.setHeader('Content-Range', `bytes */${bytes.length}`);
        return response.status(416).end();
      }
      response.status(206);
      response.setHeader('Content-Length', end - start + 1);
      response.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
      return response.end(bytes.subarray(start, end + 1));
    }
  }
  response.setHeader('Content-Length', bytes.length);
  return response.end(bytes);
}

app.get('/api/admin/activity/media/post/:postId/:mediaIndex', requireApiAuth, requireOwnerApi, async (request, response) => {
  if (!validNumericId(request.params.postId)) return response.status(400).json({ error: 'Invalid post.' });
  const index = Math.max(0, Number(request.params.mediaIndex) || 0);
  try {
    await ensureDatabase();
    const result = await pool.query('SELECT media_items, image_data FROM posts WHERE id=$1 LIMIT 1', [request.params.postId]);
    if (!result.rowCount) return response.status(404).json({ error: 'Post not found.' });
    const media = normalizeStoredPostMedia(result.rows[0].media_items, result.rows[0].image_data || '');
    const item = media[index];
    if (!item?.data) return response.status(404).json({ error: 'Media not found.' });
    return sendAdminActivityDataUri(request, response, item.data, item.mimeType);
  } catch (error) {
    console.error('Admin post activity media failed:', error.message);
    return response.status(500).json({ error: 'Could not load media.' });
  }
});

app.get('/api/admin/activity/media/reel/:reelId', requireApiAuth, requireOwnerApi, async (request, response) => {
  if (!validNumericId(request.params.reelId)) return response.status(400).json({ error: 'Invalid reel.' });
  try {
    await ensureDatabase();
    const result = await pool.query(
      `SELECT r.video_data, r.mime_type, r.source_post_id, r.source_media_index, p.media_items, p.image_data
         FROM reels r LEFT JOIN posts p ON p.id=r.source_post_id WHERE r.id=$1 LIMIT 1`,
      [request.params.reelId]);
    if (!result.rowCount) return response.status(404).json({ error: 'Reel not found.' });
    const row = result.rows[0];
    let data = row.video_data || '';
    let mime = row.mime_type || 'video/mp4';
    if (row.source_post_id) {
      const media = normalizeStoredPostMedia(row.media_items, row.image_data || '');
      const item = media[Number(row.source_media_index || 0)];
      data = item?.data || '';
      mime = item?.mimeType || mime;
    }
    return sendAdminActivityDataUri(request, response, data, mime);
  } catch (error) {
    console.error('Admin reel activity media failed:', error.message);
    return response.status(500).json({ error: 'Could not load reel.' });
  }
});

app.get('/api/admin/activity/media/story/:storyId', requireApiAuth, requireOwnerApi, async (request, response) => {
  if (!validNumericId(request.params.storyId)) return response.status(400).json({ error: 'Invalid story.' });
  try {
    await ensureDatabase();
    const result = await pool.query('SELECT image_data FROM stories WHERE id=$1 LIMIT 1', [request.params.storyId]);
    if (!result.rowCount) return response.status(404).json({ error: 'Story not found.' });
    return sendAdminActivityDataUri(request, response, result.rows[0].image_data, 'image/jpeg');
  } catch (error) {
    console.error('Admin story activity media failed:', error.message);
    return response.status(500).json({ error: 'Could not load story.' });
  }
});

app.get('/api/admin/activity/media/comment/:commentKind/:commentId', requireApiAuth, requireOwnerApi, async (request, response) => {
  const kind = String(request.params.commentKind || '');
  if (!validNumericId(request.params.commentId) || !['post','media','reel'].includes(kind)) return response.status(400).json({ error: 'Invalid comment.' });
  const table = kind === 'post' ? 'post_comments' : (kind === 'media' ? 'post_media_comments' : 'reel_comments');
  try {
    await ensureDatabase();
    const result = await pool.query(`SELECT media_data, media_type FROM ${table} WHERE id=$1 LIMIT 1`, [request.params.commentId]);
    if (!result.rowCount) return response.status(404).json({ error: 'Comment media not found.' });
    return sendAdminActivityDataUri(request, response, result.rows[0].media_data, result.rows[0].media_type || 'image/jpeg');
  } catch (error) {
    console.error('Admin comment activity media failed:', error.message);
    return response.status(500).json({ error: 'Could not load comment media.' });
  }
});

app.get('/api/admin/activity/media/deleted/:deletedId/:slot', requireApiAuth, requireOwnerApi, async (request, response) => {
  if (!validNumericId(request.params.deletedId)) return response.status(400).json({ error: 'Invalid deleted content.' });
  try {
    await ensureDatabase();
    const result = await pool.query('SELECT content_type, content FROM admin_deleted_content WHERE id=$1 LIMIT 1', [request.params.deletedId]);
    if (!result.rowCount) return response.status(404).json({ error: 'Deleted content not found.' });
    const content = result.rows[0].content || {};
    const record = content.post || content.story || content.reel || content.comment || {};
    const slot = String(request.params.slot || '0');
    let data = '';
    if (/^comment-/.test(slot)) {
      const match = /^comment-(comments|mediaComments)-(\d+)$/.exec(slot);
      const list = match ? content[match[1]] : null;
      data = Array.isArray(list) ? String(list[Number(match[2])]?.media_data || '') : '';
    } else if (Array.isArray(record.media_items) && record.media_items.length) {
      data = String(record.media_items[Math.max(0, Number(slot) || 0)]?.data || '');
    } else {
      data = String(record.image_data || record.video_data || record.media_data || '');
    }
    return sendAdminActivityDataUri(request, response, data, '');
  } catch (error) {
    console.error('Admin deleted activity media failed:', error.message);
    return response.status(500).json({ error: 'Could not load deleted media.' });
  }
});



function marketplacePriceNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : null;
}

function marketplaceImageOkay(value) {
  const image = String(value || '');
  return !image || validImageData(image);
}

function marketplaceMediaNormalize(value) {
  if (!Array.isArray(value)) return [];
  const output=[];
  let total=0;
  for (const raw of value.slice(0,10)) {
    if (!raw || typeof raw !== 'object') continue;
    const data=String(raw.data || '');
    const type=String(raw.type || '').toLowerCase()==='video' || data.startsWith('data:video/') ? 'video' : 'image';
    if (!data.startsWith('data:image/') && !data.startsWith('data:video/')) continue;
    const bytes=Buffer.byteLength(data,'utf8');
    if (bytes > 12*1024*1024) continue;
    total += bytes;
    if (total > 60*1024*1024) break;
    output.push({type,data});
  }
  return output;
}

function marketplaceMediaPublic(row) {
  const media=Array.isArray(row && row.media_json) ? row.media_json : [];
  if (media.length) return media.map((item,index)=>({type:String(item.type||'image'),url:`/api/marketplace/${row.id}/media/${index}`}));
  if (row && row.has_image) return [{type:'image',url:`/api/marketplace/${row.id}/image`}];
  return [];
}

app.get('/api/manage-posts', requireApiAuth, async (request, response) => {
  const type = String(request.query.type || 'all').toLowerCase();
  const allowedTypes = new Set(['all','reels','text','stickers','stories','music','photos','location']);
  const limit = Math.max(8, Math.min(36, Number(request.query.limit) || 18));
  const fetchLimit = type === 'all' ? Math.min(72, limit * 3) : Math.min(180, Math.max(90, limit * 8));
  const cursor = adminActivityCursorDecode(request.query.cursor);
  const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(request.query.from || '')) ? `${request.query.from}T00:00:00.000Z` : '';
  const toDate = /^\d{4}-\d{2}-\d{2}$/.test(String(request.query.to || '')) ? new Date(`${request.query.to}T00:00:00.000Z`) : null;
  const toExclusive = toDate && Number.isFinite(toDate.getTime()) ? new Date(toDate.getTime() + 86400000).toISOString() : '';
  if (!allowedTypes.has(type)) return response.status(400).json({ error:'Invalid content filter.' });
  try {
    await ensureDatabase();
    const params=[request.user.id, fromDate || null, toExclusive || null, cursor || null, fetchLimit];
    const postResult=await pool.query(`
      SELECT p.id, p.body, p.visibility, p.created_at, (p.post_extras #- '{sound,data}') AS post_extras,
             CASE WHEN jsonb_array_length(COALESCE(p.media_items,'[]'::jsonb))>0 OR COALESCE(p.image_data,'')<>'' THEN TRUE ELSE FALSE END AS has_media,
             CASE WHEN jsonb_array_length(COALESCE(p.media_items,'[]'::jsonb))>0 THEN
               CASE WHEN LOWER(COALESCE(p.media_items->0->>'type',''))='video' OR COALESCE(p.media_items->0->>'data','') LIKE 'data:video/%' THEN 'video' ELSE 'image' END
               WHEN COALESCE(p.image_data,'')<>'' THEN 'image' ELSE '' END AS media_type
        FROM posts p
       WHERE p.user_id=$1
         AND ($2::timestamptz IS NULL OR p.created_at >= $2)
         AND ($3::timestamptz IS NULL OR p.created_at < $3)
         AND ($4::timestamptz IS NULL OR p.created_at < $4)
       ORDER BY p.created_at DESC,p.id DESC LIMIT $5`, params);
    const reelResult=await pool.query(`
      SELECT r.id,r.caption,r.visibility,r.created_at
        FROM reels r
       WHERE r.user_id=$1 AND r.source_post_id IS NULL
         AND ($2::timestamptz IS NULL OR r.created_at >= $2)
         AND ($3::timestamptz IS NULL OR r.created_at < $3)
         AND ($4::timestamptz IS NULL OR r.created_at < $4)
       ORDER BY r.created_at DESC,r.id DESC LIMIT $5`, params);
    const storyResult=await pool.query(`
      SELECT s.id,s.caption,s.created_at
        FROM stories s
       WHERE s.user_id=$1
         AND ($2::timestamptz IS NULL OR s.created_at >= $2)
         AND ($3::timestamptz IS NULL OR s.created_at < $3)
         AND ($4::timestamptz IS NULL OR s.created_at < $4)
       ORDER BY s.created_at DESC,s.id DESC LIMIT $5`, params);

    const items=[];
    postResult.rows.forEach(row=>{
      const item={
        kind:'post',id:String(row.id),text:row.body || '',visibility:row.visibility || 'public',createdAt:row.created_at,
        post_extras:adminActivitySanitizeExtras(row.post_extras),mediaType:String(row.media_type || ''),
        mediaUrl:row.has_media ? `/api/manage-posts/media/post/${row.id}/0` : ''
      };
      item.contentTypes=adminActivityTypeTags({source_kind:'post',body:item.text,post_extras:item.post_extras,media_type:item.mediaType});
      items.push(item);
    });
    reelResult.rows.forEach(row=>{
      const item={kind:'reel',id:String(row.id),text:row.caption || '',visibility:row.visibility || 'followers',createdAt:row.created_at,mediaType:'video',mediaUrl:`/api/manage-posts/media/reel/${row.id}`};
      item.contentTypes=['reels'].concat(item.text ? ['text'] : []);
      items.push(item);
    });
    storyResult.rows.forEach(row=>{
      const item={kind:'story',id:String(row.id),text:row.caption || '',visibility:'story',createdAt:row.created_at,mediaType:'image',mediaUrl:`/api/manage-posts/media/story/${row.id}`};
      item.contentTypes=['stories'].concat(item.text ? ['text'] : []);
      items.push(item);
    });
    const candidates=items.sort((l,r)=>new Date(r.createdAt)-new Date(l.createdAt));
    const filtered=candidates.filter(item=>type==='all' || item.contentTypes.includes(type));
    const pageItems=filtered.slice(0,limit);
    const last=pageItems[pageItems.length-1];
    const oldest=candidates[candidates.length-1];
    const scanMore=type!=='all' && pageItems.length<limit && candidates.length>=fetchLimit;
    const cursorSource=scanMore ? oldest : last;
    const canContinue=Boolean(cursorSource && (pageItems.length===limit || scanMore));
    response.set('Cache-Control','private, max-age=15, stale-while-revalidate=45');
    response.json({items:pageItems,nextCursor:canContinue ? adminActivityCursorEncode(cursorSource.createdAt) : '',hasMore:canContinue});
  } catch (error) {
    console.error('Manage posts load failed:',error.message);
    response.status(500).json({error:'Could not load your content.'});
  }
});

app.get('/api/manage-posts/media/post/:postId/:mediaIndex', requireApiAuth, async (request,response)=>{
  if(!validNumericId(request.params.postId)) return response.status(400).end();
  try{
    const result=await pool.query('SELECT media_items,image_data FROM posts WHERE id=$1 AND user_id=$2 LIMIT 1',[request.params.postId,request.user.id]);
    if(!result.rowCount)return response.status(404).end();
    const media=normalizeStoredPostMedia(result.rows[0].media_items,result.rows[0].image_data || '');
    const item=media[Math.max(0,Number(request.params.mediaIndex)||0)];
    return sendAdminActivityDataUri(request,response,item?.data || '',item?.mimeType || '');
  }catch(error){console.error('Manage post media failed:',error.message);return response.status(500).end();}
});
app.get('/api/manage-posts/media/reel/:reelId', requireApiAuth, async (request,response)=>{
  if(!validNumericId(request.params.reelId))return response.status(400).end();
  try{
    const result=await pool.query(`SELECT r.video_data,r.mime_type,r.source_post_id,r.source_media_index,p.media_items,p.image_data FROM reels r LEFT JOIN posts p ON p.id=r.source_post_id WHERE r.id=$1 AND r.user_id=$2 LIMIT 1`,[request.params.reelId,request.user.id]);
    if(!result.rowCount)return response.status(404).end();
    const row=result.rows[0];let data=row.video_data || '';let mime=row.mime_type || 'video/mp4';
    if(row.source_post_id){const media=normalizeStoredPostMedia(row.media_items,row.image_data || '');const item=media[Number(row.source_media_index||0)];data=item?.data||'';mime=item?.mimeType||mime;}
    return sendAdminActivityDataUri(request,response,data,mime);
  }catch(error){console.error('Manage reel media failed:',error.message);return response.status(500).end();}
});
app.get('/api/manage-posts/media/story/:storyId', requireApiAuth, async (request,response)=>{
  if(!validNumericId(request.params.storyId))return response.status(400).end();
  try{const result=await pool.query('SELECT image_data FROM stories WHERE id=$1 AND user_id=$2 LIMIT 1',[request.params.storyId,request.user.id]);if(!result.rowCount)return response.status(404).end();return sendAdminActivityDataUri(request,response,result.rows[0].image_data,'image/jpeg');}
  catch(error){console.error('Manage story media failed:',error.message);return response.status(500).end();}
});

app.get('/api/marketplace', requireApiAuth, async (request, response) => {
  let tab = String(request.query.tab || 'explore').toLowerCase();
  if (tab === 'for-you') tab='explore';
  if (tab === 'sell') tab='selling';
  const query=String(request.query.q || '').trim().slice(0,120);
  const category=String(request.query.category || '').trim().slice(0,120);
  const condition=String(request.query.condition || '').trim().slice(0,40);
  const sort=String(request.query.sort || 'suggested').toLowerCase();
  const locationFilter=String(request.query.location || '').trim().slice(0,120);
  const countryFilter=String(request.query.country || '').trim().slice(0,120);
  const minPrice=marketplacePriceNumber(request.query.minPrice);
  const maxPrice=marketplacePriceNumber(request.query.maxPrice);
  const allowedTabs=new Set(['explore','local','location','categories','saved','selling','recent']);
  const allowedSorts=new Set(['suggested','newest','price-low','price-high']);
  if(!allowedTabs.has(tab))return response.status(400).json({error:'Invalid Marketplace view.'});
  if(!allowedSorts.has(sort))return response.status(400).json({error:'Invalid Marketplace sort.'});
  try{
    await ensureDatabase();
    const viewerIp=requestClientIp(request);
    const viewerLocalPrefix=marketplaceLocalIpPrefix(viewerIp);
    const sessionKey=accountSessionKey(request,request.user.sid);
    const locationResult=await pool.query(`SELECT location FROM account_login_sessions WHERE user_id=$1 AND session_key=$2 ORDER BY last_active_at DESC LIMIT 1`,[request.user.id,sessionKey]);
    const sessionLocation=String(locationResult.rows[0]?.location || '');
    if(tab==='categories'){
      const result=await pool.query(`SELECT category,COUNT(*)::int AS count FROM marketplace_listings WHERE status='active' AND category<>'' GROUP BY category ORDER BY count DESC,category ASC LIMIT 40`);
      response.set('Cache-Control','private, max-age=30, stale-while-revalidate=60');
      return response.json({tab,location:sessionLocation,categories:result.rows,listings:[]});
    }
    const values=[request.user.id,query,category,condition,minPrice,maxPrice];
    let sql=`
      SELECT m.id,m.seller_id,m.title,m.price,m.currency,m.category,m.location,m.seller_country,m.description,m.condition,m.views,
             (m.image_data IS NOT NULL AND m.image_data<>'') AS has_image,m.status,m.created_at,m.media_json,u.full_name AS seller_name,
             EXISTS(SELECT 1 FROM marketplace_saved ms WHERE ms.listing_id=m.id AND ms.user_id=$1) AS saved,
             (SELECT COUNT(*)::int FROM marketplace_saved sx WHERE sx.listing_id=m.id) AS save_count
        FROM marketplace_listings m JOIN users u ON u.id=m.seller_id `;
    if(tab==='saved')sql+=` JOIN marketplace_saved mysave ON mysave.listing_id=m.id AND mysave.user_id=$1 `;
    if(tab==='recent')sql+=` JOIN marketplace_recent_views rv ON rv.listing_id=m.id AND rv.user_id=$1 `;
    if(tab==='selling')sql+=` WHERE m.seller_id=$1 `;
    else sql+=` WHERE m.status IN ('active','sold') `;
    sql+=` AND ($2='' OR m.title ILIKE '%'||$2||'%' OR m.category ILIKE '%'||$2||'%' OR m.description ILIKE '%'||$2||'%' OR m.location ILIKE '%'||$2||'%')
            AND ($3='' OR m.category=$3)
            AND ($4='' OR m.condition=$4)
            AND ($5::numeric IS NULL OR m.price >= $5)
            AND ($6::numeric IS NULL OR m.price <= $6)`;
    if(tab==='local'){
      if(!viewerLocalPrefix){
        sql+=` AND FALSE`;
      }else{
        values.push(viewerLocalPrefix);
        sql+=` AND m.seller_ip_prefix=$7`;
      }
    }
    if(tab==='location'){
      if(!countryFilter){
        sql+=` AND FALSE`;
      }else{
        values.push(countryFilter);
        const countryIndex=values.length;
        sql+=` AND LOWER(COALESCE(m.seller_country,''))=LOWER($${countryIndex})`;
      }
    }
    if(tab==='recent')sql+=` ORDER BY rv.viewed_at DESC`;
    else if(sort==='suggested')sql+=` ORDER BY (m.status='active') DESC, save_count DESC,m.views DESC,m.created_at DESC,m.id DESC`;
    else if(sort==='newest')sql+=` ORDER BY m.created_at DESC,m.id DESC`;
    else if(sort==='price-low')sql+=` ORDER BY m.price ASC NULLS LAST,m.created_at DESC`;
    else if(sort==='price-high')sql+=` ORDER BY m.price DESC NULLS LAST,m.created_at DESC`;
    else if(sort!=='suggested')sql+=` ORDER BY (m.status='active') DESC,m.created_at DESC,m.id DESC`;
    sql+=` LIMIT 24`;
    const result=await pool.query(sql,values);
    const listings=result.rows.map(row=>({
      id:String(row.id),sellerId:String(row.seller_id),sellerName:row.seller_name || 'Facebook user',title:row.title || '',
      price:row.price==null?null:Number(row.price),currency:row.currency || '',category:row.category || '',location:row.location || '',sellerCountry:row.seller_country || '',
      description:row.description || '',condition:row.condition || '',views:Number(row.views || 0),saved:Boolean(row.saved),status:row.status || 'active',
      imageUrl:(marketplaceMediaPublic(row).find(item=>item.type==='image')?.url || (row.has_image ? `/api/marketplace/${row.id}/image` : '')),media:marketplaceMediaPublic(row),createdAt:row.created_at
    }));
    response.set('Cache-Control','private, max-age=15, stale-while-revalidate=45');
    response.json({tab,location:sessionLocation,localAvailable:Boolean(viewerLocalPrefix),selectedCountry:countryFilter,listings,categories:[],filters:{category,condition,sort,minPrice,maxPrice,country:countryFilter}});
  }catch(error){console.error('Marketplace load failed:',error.message);response.status(500).json({error:'Could not load Marketplace.'});}
});

app.post('/api/marketplace', requireApiAuth, async (request,response)=>{
  const title=String(request.body?.title || '').trim().slice(0,180);
  const category=String(request.body?.category || '').trim().slice(0,120);
  const condition=String(request.body?.condition || '').trim().slice(0,40);
  const description=String(request.body?.description || '').trim().slice(0,4000);
  const location=String(request.body?.location || '').trim().slice(0,255);
  const currency=String(request.body?.currency || '₪').trim().slice(0,12);
  const price=marketplacePriceNumber(request.body?.price);
  const image=String(request.body?.image || '');
  const media=marketplaceMediaNormalize(request.body?.media);
  if(title.length<2)return response.status(400).json({error:'Add a listing title.'});
  if(!category)return response.status(400).json({error:'Choose a category.'});
  if(price===null)return response.status(400).json({error:'Enter a valid price.'});
  if(!marketplaceImageOkay(image))return response.status(400).json({error:'Choose a supported photo smaller than 8 MB.'});
  if(Array.isArray(request.body?.media) && request.body.media.length && !media.length)return response.status(400).json({error:'Choose supported photos or videos.'});
  try{
    const sellerIpPrefix=marketplaceLocalIpPrefix(requestClientIp(request));
    const sessionKey=accountSessionKey(request,request.user.sid);
    const sessionLocationResult=await pool.query(`SELECT location FROM account_login_sessions WHERE user_id=$1 AND session_key=$2 ORDER BY last_active_at DESC LIMIT 1`,[request.user.id,sessionKey]);
    const sessionLocation=String(sessionLocationResult.rows[0]?.location || '');
    const sellerCountry=sessionLocation ? String(sessionLocation.split(',').pop() || '').trim().slice(0,120) : '';
    const firstImage=media.find(item=>item.type==='image')?.data || image || null;
    const result=await pool.query(`INSERT INTO marketplace_listings(seller_id,title,price,currency,category,location,seller_ip_prefix,seller_country,image_data,media_json,status,description,condition) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'active',$11,$12) RETURNING id`,[request.user.id,title,price,currency,category,location,sellerIpPrefix,sellerCountry,firstImage,JSON.stringify(media),description,condition]);
    response.json({ok:true,id:String(result.rows[0].id)});
  }catch(error){console.error('Marketplace create failed:',error.message);response.status(500).json({error:'Could not publish the listing.'});}
});

app.post('/api/marketplace/:listingId/save', requireApiAuth, async (request,response)=>{
  if(!validNumericId(request.params.listingId))return response.status(400).json({error:'Invalid listing.'});
  try{
    const exists=await pool.query('SELECT 1 FROM marketplace_saved WHERE listing_id=$1 AND user_id=$2',[request.params.listingId,request.user.id]);
    if(exists.rowCount){await pool.query('DELETE FROM marketplace_saved WHERE listing_id=$1 AND user_id=$2',[request.params.listingId,request.user.id]);return response.json({saved:false});}
    await pool.query('INSERT INTO marketplace_saved(listing_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[request.params.listingId,request.user.id]);
    response.json({saved:true});
  }catch(error){console.error('Marketplace save failed:',error.message);response.status(500).json({error:'Could not update Saved.'});}
});

app.get('/api/marketplace/:listingId', requireApiAuth, async (request,response)=>{
  if(!validNumericId(request.params.listingId))return response.status(400).json({error:'Invalid listing.'});
  try{
    const result=await pool.query(`SELECT m.id,m.seller_id,m.title,m.price,m.currency,m.category,m.location,m.seller_country,m.description,m.condition,m.views,m.status,m.created_at,m.media_json,u.full_name AS seller_name,u.profile_photo AS seller_photo,(m.image_data IS NOT NULL AND m.image_data<>'') AS has_image,EXISTS(SELECT 1 FROM marketplace_saved ms WHERE ms.listing_id=m.id AND ms.user_id=$2) AS saved FROM marketplace_listings m JOIN users u ON u.id=m.seller_id WHERE m.id=$1 LIMIT 1`,[request.params.listingId,request.user.id]);
    if(!result.rowCount)return response.status(404).json({error:'Listing not found.'});
    await Promise.all([
      pool.query('UPDATE marketplace_listings SET views=views+1 WHERE id=$1',[request.params.listingId]),
      pool.query(`INSERT INTO marketplace_recent_views(user_id,listing_id,viewed_at) VALUES($1,$2,NOW()) ON CONFLICT(user_id,listing_id) DO UPDATE SET viewed_at=NOW()`,[request.user.id,request.params.listingId])
    ]);
    const row=result.rows[0];
    const media=marketplaceMediaPublic(row);
    response.json({id:String(row.id),sellerId:String(row.seller_id),sellerName:row.seller_name || 'Facebook user',sellerAvatar:row.seller_photo || '',title:row.title || '',price:row.price==null?null:Number(row.price),currency:row.currency || '',category:row.category || '',location:row.location || '',sellerCountry:row.seller_country || '',description:row.description || '',condition:row.condition || '',views:Number(row.views || 0)+1,saved:Boolean(row.saved),status:row.status || 'active',imageUrl:media.find(item=>item.type==='image')?.url || (row.has_image?`/api/marketplace/${row.id}/image`:''),media,createdAt:row.created_at});
  }catch(error){console.error('Marketplace detail failed:',error.message);response.status(500).json({error:'Could not open listing.'});}
});

app.patch('/api/marketplace/:listingId', requireApiAuth, async (request,response)=>{
  if(!validNumericId(request.params.listingId))return response.status(400).json({error:'Invalid listing.'});
  const title=String(request.body?.title || '').trim().slice(0,180);
  const category=String(request.body?.category || '').trim().slice(0,120);
  const condition=String(request.body?.condition || '').trim().slice(0,40);
  const description=String(request.body?.description || '').trim().slice(0,4000);
  const location=String(request.body?.location || '').trim().slice(0,255);
  const currency=String(request.body?.currency || '₪').trim().slice(0,12);
  const price=marketplacePriceNumber(request.body?.price);
  const imageProvided=Object.prototype.hasOwnProperty.call(request.body || {},'image');
  const image=String(request.body?.image || '');
  const mediaProvided=Object.prototype.hasOwnProperty.call(request.body || {},'media');
  const media=marketplaceMediaNormalize(request.body?.media);
  if(title.length<2)return response.status(400).json({error:'Add a listing title.'});
  if(!category)return response.status(400).json({error:'Choose a category.'});
  if(price===null)return response.status(400).json({error:'Enter a valid price.'});
  if(imageProvided&&!marketplaceImageOkay(image))return response.status(400).json({error:'Choose a supported photo smaller than 8 MB.'});
  if(mediaProvided && Array.isArray(request.body?.media) && request.body.media.length && !media.length)return response.status(400).json({error:'Choose supported photos or videos.'});
  try{
    const firstImage=media.find(item=>item.type==='image')?.data || image;
    const result=await pool.query(`UPDATE marketplace_listings SET title=$1,price=$2,currency=$3,category=$4,location=$5,description=$6,condition=$7,image_data=CASE WHEN $8::boolean OR $10::boolean THEN NULLIF($9,'') ELSE image_data END,media_json=CASE WHEN $10::boolean THEN $11::jsonb ELSE media_json END,updated_at=NOW() WHERE id=$12 AND seller_id=$13 RETURNING id`,[title,price,currency,category,location,description,condition,imageProvided,firstImage,mediaProvided,JSON.stringify(media),request.params.listingId,request.user.id]);
    if(!result.rowCount)return response.status(404).json({error:'Listing not found.'});
    response.json({ok:true,id:String(result.rows[0].id)});
  }catch(error){console.error('Marketplace edit failed:',error.message);response.status(500).json({error:'Could not update the listing.'});}
});

app.patch('/api/marketplace/:listingId/status', requireApiAuth, async (request,response)=>{
  if(!validNumericId(request.params.listingId))return response.status(400).json({error:'Invalid listing.'});
  const status=String(request.body?.status || '').toLowerCase();
  if(!['active','sold'].includes(status))return response.status(400).json({error:'Invalid listing status.'});
  try{const result=await pool.query('UPDATE marketplace_listings SET status=$1,updated_at=NOW() WHERE id=$2 AND seller_id=$3 RETURNING id',[status,request.params.listingId,request.user.id]);if(!result.rowCount)return response.status(404).json({error:'Listing not found.'});response.json({ok:true,status});}
  catch(error){console.error('Marketplace status failed:',error.message);response.status(500).json({error:'Could not update listing.'});}
});

app.delete('/api/marketplace/:listingId', requireApiAuth, async (request,response)=>{
  if(!validNumericId(request.params.listingId))return response.status(400).json({error:'Invalid listing.'});
  try{const result=await pool.query('DELETE FROM marketplace_listings WHERE id=$1 AND seller_id=$2 RETURNING id',[request.params.listingId,request.user.id]);if(!result.rowCount)return response.status(404).json({error:'Listing not found.'});response.json({ok:true});}
  catch(error){console.error('Marketplace delete failed:',error.message);response.status(500).json({error:'Could not delete listing.'});}
});

app.get('/api/marketplace/:listingId/media/:mediaIndex', requireApiAuth, async (request, response) => {
  if (!validNumericId(request.params.listingId)) return response.status(400).json({ error: 'Invalid listing.' });
  const index=Number(request.params.mediaIndex);
  if (!Number.isInteger(index) || index<0 || index>9) return response.status(400).json({error:'Invalid media.'});
  try {
    await ensureDatabase();
    const result=await pool.query('SELECT media_json FROM marketplace_listings WHERE id=$1 LIMIT 1',[request.params.listingId]);
    if(!result.rowCount)return response.status(404).end();
    const media=Array.isArray(result.rows[0].media_json)?result.rows[0].media_json:[];
    const item=media[index];
    if(!item || !item.data)return response.status(404).end();
    return sendAdminActivityDataUri(request,response,String(item.data),String(item.type||'')==='video'?'video/mp4':'image/jpeg');
  } catch(error) { console.error('Marketplace media load failed:',error.message); return response.status(500).end(); }
});

app.get('/api/marketplace/:listingId/image', requireApiAuth, async (request, response) => {
  if (!validNumericId(request.params.listingId)) return response.status(400).json({ error: 'Invalid listing.' });
  try {
    await ensureDatabase();
    const result = await pool.query('SELECT image_data FROM marketplace_listings WHERE id=$1 LIMIT 1', [request.params.listingId]);
    if (!result.rowCount || !result.rows[0].image_data) return response.status(404).end();
    return sendAdminActivityDataUri(request, response, result.rows[0].image_data, 'image/jpeg');
  } catch (error) {
    console.error('Marketplace image load failed:', error.message);
    return response.status(500).end();
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


function marketplaceLocalIpPrefix(rawIp) {
  const ip = String(rawIp || '').trim().replace(/^::ffff:/i, '');
  const ipv4 = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    if (parts.every(part => part >= 0 && part <= 255)) return `${parts[0]}.${parts[1]}`;
    return '';
  }
  // IPv6 fallback: use the first four hextets as the local grouping key.
  if (ip.includes(':')) {
    const normalized = ip.split(':').filter(Boolean).slice(0, 4).join(':').toLowerCase();
    return normalized || '';
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
  if (cached && cached.expiresAt > Date.now() && cached.value?.location) return String(cached.value.location || '');

  function countryName(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^PS$/i.test(raw)) return 'Palestine';
    if (/^[A-Za-z]{2}$/.test(raw)) {
      try {
        const names = new Intl.DisplayNames(['en'], { type: 'region' });
        return names.of(raw.toUpperCase()) || raw;
      } catch (_error) { return raw; }
    }
    return raw.replace(/Palestinian Territories/gi, 'Palestine');
  }

  function buildLocation(city, region, country) {
    const parts = [city, region, countryName(country)]
      .map(value => String(value || '').trim().replace(/Palestinian Territories/gi, 'Palestine'))
      .filter((value, index, values) => value && values.indexOf(value) === index);
    if (!parts.length) throw new Error('Location unavailable');
    return parts.join(', ');
  }

  async function fetchJson(url) {
    const response = await withTimeout(fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'facebook-plus-session-location/1.0' }
    }), 5500, 'IP location timed out');
    if (!response.ok) throw new Error(`IP location failed (${response.status})`);
    return response.json();
  }

  const providers = [
    () => fetchJson(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,city,region,country`)
      .then(payload => {
        if (!payload || payload.success === false) throw new Error('ipwho.is unavailable');
        return buildLocation(payload.city, payload.region, payload.country);
      }),
    () => fetchJson(`https://ipapi.co/${encodeURIComponent(ip)}/json/`)
      .then(payload => {
        if (!payload || payload.error) throw new Error('ipapi.co unavailable');
        return buildLocation(payload.city, payload.region, payload.country_name || payload.country);
      }),
    () => fetchJson(`https://freeipapi.com/api/json/${encodeURIComponent(ip)}`)
      .then(payload => buildLocation(payload.cityName || payload.city, payload.regionName || payload.region, payload.countryName || payload.countryCode)),
    () => fetchJson(`https://ipinfo.io/${encodeURIComponent(ip)}/json`)
      .then(payload => {
        if (!payload || payload.bogon || payload.error) throw new Error('ipinfo.io unavailable');
        return buildLocation(payload.city, payload.region, payload.country);
      }),
    () => fetchJson(`https://api.iplocation.net/?ip=${encodeURIComponent(ip)}`)
      .then(payload => {
        if (!payload || String(payload.response_code || '') === '400') throw new Error('iplocation.net unavailable');
        return buildLocation(payload.city || '', payload.region || '', payload.country_name || payload.country_code2);
      })
  ];

  try {
    // Start all providers together and use the first useful answer. This avoids a
    // single rate-limited or blocked service making sessions show "unavailable".
    const location = await Promise.any(providers.map(provider => provider()));
    sessionLocationCache.set(ip, { value: { location, locationAvailable: true }, expiresAt: Date.now() + 30 * 60 * 1000 });
    if (sessionLocationCache.size > 500) sessionLocationCache.delete(sessionLocationCache.keys().next().value);
    return location;
  } catch (_error) {
    // Cache failures only briefly so a temporary provider outage is retried soon.
    sessionLocationCache.set(ip, { value: { location: '', locationAvailable: false }, expiresAt: Date.now() + 60 * 1000 });
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
      isp: String(connection.isp || connection.org || company.name || asnData.org || '').slice(0, 160),
      organization: String(company.name || company.domain || asnData.org || connection.org || connection.isp || '').slice(0, 160),
      asn: String(asnData.asn || asnData.route || connection.asn || '').replace(/^AS/i, '').trim() ? 'AS' + String(asnData.asn || connection.asn || '').replace(/^AS/i, '').trim() : '',
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
    if (location) {
      const sessionKey = await recordAccountLoginSession(request, request.user.id);
      await pool.query('UPDATE account_login_sessions SET location = $1, last_active_at = NOW() WHERE user_id = $2 AND session_key = $3', [location, request.user.id, sessionKey]);
    }
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
  const requestedLimit = Number.parseInt(String(request.query.limit || '6'), 10);
  const postLimit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(12, requestedLimit))
    : 6;

  const requestedUserId = String(request.query.userId || '').trim();
  const profileUserId = validNumericId(requestedUserId)
    ? requestedUserId
    : null;

  const requestedBefore = String(request.query.before || request.query.cursor || '').trim();
  let beforeCursor = null, beforeId = null;
  if (requestedBefore) {
    const split = requestedBefore.lastIndexOf('|');
    const timePart = split > 0 ? requestedBefore.slice(0, split) : requestedBefore;
    const idPart = split > 0 ? requestedBefore.slice(split + 1) : '';
    if (!Number.isNaN(Date.parse(timePart))) beforeCursor = new Date(timePart).toISOString();
    if (validNumericId(idPart)) beforeId = idPart;
  }

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
      WHERE (
        p.user_id = $1
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
        )
      )
      AND ($3::bigint IS NULL OR p.user_id = $3::bigint)
      AND ($4::timestamptz IS NULL OR (p.created_at, p.id) < ($4::timestamptz, COALESCE($5::bigint, 9223372036854775807::bigint)))
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $2
    `, [request.user.id, postLimit, profileUserId, beforeCursor, beforeId]);
    const commentsByPost = new Map();
    if (result.rows.length) {
      const ids = result.rows.map(row => String(row.id));
      const placeholders = ids.map((_id, index) => `$${index + 1}`).join(',');
      const commentResult = await pool.query(
        `SELECT pc.id, pc.post_id, pc.user_id, pc.parent_comment_id, pc.body, pc.media_data, pc.media_type,
                pc.media_storage_key, pc.media_mime_type, pc.created_at,
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
          profilePhoto: avatarDeliveryUrl(row.user_id, row.profile_photo),
          parentCommentId: row.parent_comment_id ? String(row.parent_comment_id) : null,
          replyToAuthor: row.reply_to_author || '',
          mediaData: row.media_type === 'sticker' ? (row.media_data || '') : '',
          mediaUrl: row.media_type === 'image' && (row.media_storage_key || row.media_data) ? `/api/posts/${encodeURIComponent(key)}/comments/${encodeURIComponent(String(row.id))}/media` : '',
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
    const nextCursor = result.rows.length === postLimit
      ? `${new Date(result.rows[result.rows.length - 1].created_at).toISOString()}|${String(result.rows[result.rows.length - 1].id)}`
      : '';
    response.json({ nextCursor, posts: result.rows.map(row => ({
      id: String(row.id),
      userId: String(row.user_id),
      body: row.body,
      image: '',
      contentKey: `post:${row.id}`,
      media: normalizeStoredPostMedia(row.media_items, row.image_data || '').map((item, index) => ({
        type: item.type || '',
        mimeType: item.mimeType || '',
        name: item.name || '',
        url: `/api/posts/${encodeURIComponent(String(row.id))}/media/${index}`,
        ...(item.editData && typeof item.editData === 'object' ? { editData: item.editData } : {}),
        reelId: sourceReelsByPost.get(String(row.id))?.get(index) || item.reelId || '',
        contentKey: `post:${row.id}:media:${index}`
      })),
      extras: publicPostExtras(row.post_extras, row.id),
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

app.put('/api/post-media-uploads/:uploadToken', requireApiAuth, async (request,response)=>{
  const token=safePostUploadToken(request.params.uploadToken);
  if(!token)return response.status(400).json({error:'Invalid post media upload.'});
  const mimeType=String(request.headers['x-file-type'] || request.headers['content-type'] || 'application/octet-stream').toLowerCase().split(';')[0];
  const type=postMediaTypeFromMime(mimeType);
  if(!type)return response.status(400).json({error:'Choose a supported photo, video, or audio file.'});
  const limit=type==='image'?8*1024*1024:type==='audio'?13*1024*1024:60*1024*1024;
  const declared=Number(request.headers['content-length'] || 0);
  if(declared>limit)return response.status(413).json({error:`${type==='image'?'Photo':type==='audio'?'Audio':'Video'} is too large.`});
  cleanupExpiredPostUploads();fs.mkdirSync(postMediaUploadRoot,{recursive:true});
  const files=postUploadPaths(token),temp=files.data+'.part';let total=0,out;
  try{
    out=fs.createWriteStream(temp,{flags:'w'});
    for await (const chunk of request){total+=chunk.length;if(total>limit)throw new Error('UPLOAD_TOO_LARGE');if(!out.write(chunk))await new Promise(resolve=>out.once('drain',resolve));}
    await new Promise((resolve,reject)=>{out.once('error',reject);out.end(resolve);});
    if(total<=0)throw new Error('EMPTY_UPLOAD');
    fs.renameSync(temp,files.data);
    let name=String(request.headers['x-file-name'] || '').slice(0,500);try{name=decodeURIComponent(name.replace(/\+/g,' '));}catch(_error){}
    fs.writeFileSync(files.meta,JSON.stringify({userId:String(request.user.id),mimeType,type,name,size:total,expiresAt:new Date(Date.now()+24*60*60*1000).toISOString()}));
    response.status(201).json({ok:true,uploadToken:token,size:total,mimeType,type});
  }catch(error){try{if(out)out.destroy();}catch(_error){}try{fs.unlinkSync(temp);}catch(_error){}try{fs.unlinkSync(files.data);}catch(_error){}try{fs.unlinkSync(files.meta);}catch(_error){}if(error.message==='UPLOAD_TOO_LARGE')return response.status(413).json({error:'Media file is too large.'});response.status(400).json({error:'Could not receive this media upload.'});}
});

app.post('/api/posts', requireApiAuth, async (request, response) => {
  const body=String(request.body?.body || '').trim(),visibility=String(request.body?.visibility || 'public').trim().toLowerCase();
  const mediaWasProvided=Object.prototype.hasOwnProperty.call(request.body || {},'media'),legacyImage=String(request.body?.image || '');
  const mediaResult=mediaWasProvided?validatePostMedia(request.body.media):validatePostMedia(legacyImage?[{data:legacyImage}]:[]);
  if(mediaResult.error)return response.status(400).json({error:mediaResult.error});
  const extrasResult=validatePostExtras(request.body?.extras);if(extrasResult.error)return response.status(400).json({error:extrasResult.error});
  if(!body&&!mediaResult.media.length&&!postExtrasHasContent(extrasResult.extras))return response.status(400).json({error:'Add text, media, a feeling, location, sound, or sticker.'});
  if(body.length>5000)return response.status(400).json({error:'Post text is too long.'});
  if(!['public','friends','only-me'].includes(visibility))return response.status(400).json({error:'Choose a valid post audience.'});
  try{
    await ensureDatabase();const client=await pool.connect();let post,storedMedia,storedExtras;
    try{
      await client.query('BEGIN');
      const created=await client.query(`INSERT INTO posts (user_id,body,image_data,media_items,post_extras,visibility) VALUES ($1,$2,NULL,'[]'::jsonb,'{}'::jsonb,$3) RETURNING id,user_id,body,visibility,created_at`,[request.user.id,body,visibility]);
      post=created.rows[0];storedMedia=await materializePostMedia(request.user.id,mediaResult.media);storedExtras=await materializePostExtras(client,request.user.id,extrasResult.extras);
      await client.query('UPDATE posts SET image_data=NULL,media_items=$1::jsonb,post_extras=$2::jsonb WHERE id=$3',[JSON.stringify(storedMedia),JSON.stringify(storedExtras),post.id]);
      post.media_items=storedMedia;post.image_data=null;post.post_extras=storedExtras;
      post._linkedReels=await syncPostVideoReels(client,{postId:post.id,userId:request.user.id,caption:body,visibility,createdAt:post.created_at,media:storedMedia});
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    await createMentionNotifications(pool,request.user.id,body,post.id);
    response.status(201).json({ok:true,post:{...post,image:'',contentKey:`post:${post.id}`,media:normalizeStoredPostMedia(post.media_items,'').map((item,index)=>({type:item.type||'',mimeType:item.mimeType||'',name:item.name||'',url:`/api/posts/${encodeURIComponent(String(post.id))}/media/${index}`,...(item.editData&&typeof item.editData==='object'?{editData:item.editData}:{}),reelId:post._linkedReels?.find(link=>link.mediaIndex===index)?.id||'',contentKey:`post:${post.id}:media:${index}`})),extras:publicPostExtras(post.post_extras,post.id)}});
  }catch(error){console.error('Post creation failed:',error.message);response.status(500).json({error:error.message&&error.message.includes('upload')?error.message:'Could not save the post.'});}
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
    const client = await pool.connect();
    let post, finalMedia, finalExtras;
    try {
      await client.query('BEGIN');
      const current = await client.query(
        'SELECT image_data, media_items, post_extras FROM posts WHERE id = $1 AND user_id = $2 LIMIT 1 FOR UPDATE',
        [postId, request.user.id]
      );
      if (!current.rowCount) {
        await client.query('ROLLBACK');
        return response.status(404).json({ error: 'Post not found.' });
      }

      finalMedia = providedMedia === null
        ? normalizeStoredPostMedia(current.rows[0].media_items, current.rows[0].image_data || '')
        : await materializePostMedia(request.user.id, providedMedia);
      finalExtras = providedExtras === null
        ? (current.rows[0].post_extras && typeof current.rows[0].post_extras === 'object' ? current.rows[0].post_extras : {})
        : await materializePostExtras(client, request.user.id, providedExtras);

      if (!body && !finalMedia.length && !postExtrasHasContent(finalExtras)) {
        await client.query('ROLLBACK');
        return response.status(400).json({ error: 'Add text, media, a feeling, location, sound, or sticker.' });
      }

      const result = await client.query(
        `UPDATE posts
         SET body = $1, image_data = NULL, media_items = $2::jsonb, post_extras = $3::jsonb, visibility = $4
         WHERE id = $5 AND user_id = $6
         RETURNING id, user_id, body, image_data, media_items, post_extras, visibility, created_at`,
        [body, JSON.stringify(finalMedia), JSON.stringify(finalExtras), visibility, postId, request.user.id]
      );
      post = result.rows[0];
      post._linkedReels = await syncPostVideoReels(client, {
        postId: post.id, userId: request.user.id, caption: body, visibility,
        createdAt: post.created_at, media: finalMedia
      });
      if (providedMedia !== null) {
        await Promise.all([
          client.query('DELETE FROM post_media_likes WHERE post_id = $1', [postId]),
          client.query('DELETE FROM post_media_shares WHERE post_id = $1', [postId]),
          client.query('DELETE FROM post_media_comments WHERE post_id = $1', [postId])
        ]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    response.json({ ok: true, post: {
      ...post,
      image: '',
      contentKey: `post:${post.id}`,
      media: normalizeStoredPostMedia(post.media_items, '').map((item, index) => ({
        type: item.type || '',
        mimeType: item.mimeType || '',
        name: item.name || '',
        url: `/api/posts/${encodeURIComponent(String(post.id))}/media/${index}`,
        ...(item.editData && typeof item.editData === 'object' ? { editData: item.editData } : {}),
        reelId: post._linkedReels?.find(link => link.mediaIndex === index)?.id || item.reelId || '',
        contentKey: `post:${post.id}:media:${index}`
      })),
      extras: publicPostExtras(post.post_extras, post.id)
    } });
  } catch (error) {
    console.error('Post update failed:', error.message);
    response.status(500).json({ error: error.message && error.message.includes('upload') ? error.message : 'Could not update the post.' });
  }
});

async function archivePostForAdmin(queryable, postId, userId) {
  const post = await queryable.query(
    `SELECT id,user_id,body,visibility,created_at,
            jsonb_array_length(COALESCE(media_items,'[]'::jsonb)) AS media_count
       FROM posts WHERE id=$1 AND user_id=$2 LIMIT 1`,
    [postId, userId]
  );
  if (!post.rowCount) return false;
  const [comments, mediaComments, likes, mediaLikes, linkedReels] = await Promise.all([
    queryable.query('SELECT id,user_id,parent_comment_id,body,media_type,created_at FROM post_comments WHERE post_id=$1 ORDER BY created_at', [postId]),
    queryable.query('SELECT id,media_index,user_id,parent_comment_id,body,media_type,created_at FROM post_media_comments WHERE post_id=$1 ORDER BY created_at', [postId]),
    queryable.query('SELECT user_id,created_at FROM post_likes WHERE post_id=$1 ORDER BY created_at', [postId]),
    queryable.query('SELECT media_index,user_id,created_at FROM post_media_likes WHERE post_id=$1 ORDER BY created_at', [postId]),
    queryable.query('SELECT id,user_id,caption,mime_type,visibility,allow_comments,created_at,source_post_id,source_media_index FROM reels WHERE source_post_id=$1 ORDER BY created_at', [postId])
  ]);
  const content={post:post.rows[0],comments:comments.rows,mediaComments:mediaComments.rows,likes:likes.rows,mediaLikes:mediaLikes.rows,reels:linkedReels.rows,mediaPayloadsArchived:false};
  await queryable.query('INSERT INTO admin_deleted_content (user_id,content_type,original_id,content) VALUES ($1,$2,$3,$4::jsonb)',[userId,'post',String(postId),JSON.stringify(content)]);
  return true;
}

async function archiveReelForAdmin(queryable, reelId, userId) {
  const reel = await queryable.query('SELECT id,user_id,caption,mime_type,visibility,allow_comments,created_at,source_post_id,source_media_index FROM reels WHERE id=$1 AND user_id=$2 LIMIT 1',[reelId,userId]);
  if (!reel.rowCount) return false;
  const [comments,likes,views]=await Promise.all([
    queryable.query('SELECT id,user_id,parent_comment_id,body,media_type,created_at FROM reel_comments WHERE reel_id=$1 ORDER BY created_at',[reelId]),
    queryable.query('SELECT user_id,created_at FROM reel_likes WHERE reel_id=$1 ORDER BY created_at',[reelId]),
    queryable.query('SELECT user_id,viewed_at FROM reel_views WHERE reel_id=$1 ORDER BY viewed_at',[reelId])
  ]);
  await queryable.query('INSERT INTO admin_deleted_content (user_id,content_type,original_id,content) VALUES ($1,$2,$3,$4::jsonb)',[userId,'reel',String(reelId),JSON.stringify({reel:reel.rows[0],comments:comments.rows,likes:likes.rows,views:views.rows,mediaPayloadsArchived:false})]);
  return true;
}

app.delete('/api/posts/:postId', requireApiAuth, async (request, response) => {
  const postId = request.params.postId;
  if (!validNumericId(postId)) return response.status(400).json({ error: 'Invalid post.' });
  try {
    await ensureDatabase();
    const existing = await pool.query('SELECT id, user_id FROM posts WHERE id = $1 LIMIT 1', [postId]);
    if (!existing.rowCount) return response.status(404).json({ error: 'Post not found.' });
    const ownerId = String(existing.rows[0].user_id);
    const isModerator = String(request.user.id) === '1';
    if (!isModerator && ownerId !== String(request.user.id)) return response.status(403).json({ error: 'You cannot delete this post.' });
    const linked = await pool.query('SELECT id FROM reels WHERE source_post_id = $1 ORDER BY id', [postId]);
    const result = await pool.query('DELETE FROM posts WHERE id = $1 RETURNING id', [postId]);
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
      `SELECT pc.id, pc.user_id, pc.parent_comment_id, pc.body, pc.media_data, pc.media_type,
              pc.media_storage_key, pc.media_mime_type, pc.created_at,
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
      mediaData: row.media_type === 'sticker' ? (row.media_data || '') : '',
      mediaUrl: row.media_type === 'image' && (row.media_storage_key || row.media_data) ? `/api/posts/${encodeURIComponent(String(postId))}/comments/${encodeURIComponent(String(row.id))}/media` : '',
      mediaType: row.media_type || '',
      body: row.body,
      createdAt: row.created_at
    })) });
  } catch (error) {
    console.error('Post comments load failed:', error.message);
    response.status(500).json({ error: 'Could not load comments.' });
  }
});

app.get('/api/posts/:postId/comments/:commentId/media',requireApiAuth,async(request,response)=>{
  const postId=request.params.postId,commentId=request.params.commentId;
  if(!validNumericId(postId)||!validNumericId(commentId))return response.status(400).end();
  try{
    await ensureDatabase();
    const allowed=await postRowForPrivateAsset(postId,request.user.id);
    if(allowed===null)return response.status(404).end();
    if(allowed===false)return response.status(403).end();
    const found=await pool.query(
      'SELECT media_data,media_type,media_storage_key,media_mime_type FROM post_comments WHERE id=$1 AND post_id=$2 LIMIT 1',
      [commentId,postId]
    );
    const row=found.rows[0];
    if(!row||row.media_type!=='image')return response.status(404).end();
    const key=safePostStorageKey(row.media_storage_key);
    if(key)return sendFileRange(request,response,postAssetPath(key),row.media_mime_type||'image/jpeg','private, max-age=31536000, immutable');
    if(row.media_data){
      const decoded=dataUrlBuffer(row.media_data,'image');
      if(decoded&&decoded.bytes)return sendBufferRange(request,response,decoded.bytes,decoded.mimeType||row.media_mime_type||'image/jpeg','private, max-age=31536000, immutable');
    }
    response.status(404).end();
  }catch(error){
    console.error('Comment media load failed:',error.message);
    response.status(500).end();
  }
});

app.post('/api/posts/:postId/comments', requireApiAuth, async (request, response) => {
  const postId = request.params.postId;
  const body = String(request.body?.body || '').trim();
  const parentCommentId = request.body?.parentCommentId == null || request.body?.parentCommentId === '' ? null : String(request.body.parentCommentId);
  const mediaUploadToken = safePostUploadToken(request.body?.mediaUploadToken);
  const media = mediaUploadToken
    ? { data:'', type:'image' }
    : normalizeCommentMedia(request.body?.mediaData, request.body?.mediaType);
  if (!validNumericId(postId)) return response.status(400).json({ error: 'Invalid post.' });
  if (parentCommentId && !validNumericId(parentCommentId)) return response.status(400).json({ error: 'Invalid reply target.' });
  if (media.error) return response.status(400).json({ error: media.error });
  if ((!body && !media.data && !mediaUploadToken) || body.length > 1000) return response.status(400).json({ error: 'Write a comment or add media.' });
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
    let commentMediaData = media.data || null;
    let commentStorageKey = null;
    let commentMimeType = null;
    if (mediaUploadToken) {
      const uploaded = consumePostUpload(mediaUploadToken, request.user.id, 'image');
      commentStorageKey = uploaded.storageKey;
      commentMimeType = uploaded.mimeType || 'image/jpeg';
      commentMediaData = null;
    } else if (media.type === 'image' && media.data) {
      const decoded = dataUrlBuffer(media.data, 'image');
      if (!decoded || !decoded.bytes || !decoded.bytes.length) {
        return response.status(400).json({ error: 'Choose a valid comment photo.' });
      }
      commentStorageKey = writePostAsset(decoded.bytes);
      commentMimeType = decoded.mimeType || 'image/jpeg';
      commentMediaData = null;
    }

    const result = await pool.query(
      `INSERT INTO post_comments
         (post_id, user_id, parent_comment_id, body, media_data, media_type, media_storage_key, media_mime_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, user_id, parent_comment_id, body, media_data, media_type, media_storage_key, media_mime_type, created_at`,
      [postId, request.user.id, parentCommentId, body, commentMediaData, media.type || null, commentStorageKey, commentMimeType]
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
      replyToAuthor,
      mediaData: comment.media_type === 'sticker' ? (comment.media_data || '') : '',
      mediaUrl: comment.media_type === 'image' && (comment.media_storage_key || comment.media_data) ? `/api/posts/${encodeURIComponent(String(postId))}/comments/${encodeURIComponent(String(comment.id))}/media` : '',
      mediaType: comment.media_type || '',
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

app.delete('/api/posts/:postId/comments/:commentId', requireApiAuth, async (request, response) => {
  const { postId, commentId } = request.params;
  if (!validNumericId(postId) || !validNumericId(commentId)) return response.status(400).json({ error: 'Invalid comment.' });
  try {
    await ensureDatabase();
    const found = await pool.query('SELECT id, user_id FROM post_comments WHERE id=$1 AND post_id=$2 LIMIT 1', [commentId, postId]);
    if (!found.rowCount) return response.status(404).json({ error: 'Comment not found.' });
    const isModerator = String(request.user.id) === '1';
    if (!isModerator && String(found.rows[0].user_id) !== String(request.user.id)) return response.status(403).json({ error: 'You cannot delete this comment.' });
    await pool.query('DELETE FROM post_comments WHERE id=$1 AND post_id=$2', [commentId, postId]);
    response.json({ ok:true, commentId:String(commentId) });
  } catch (error) {
    console.error('Post comment delete failed:', error.message);
    response.status(500).json({ error:'Could not delete the comment.' });
  }
});

async function postRowForPrivateAsset(postId,userId) {
  const result=await pool.query(`SELECT p.user_id,p.visibility,p.post_extras,u.account_private FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=$1 LIMIT 1`,[postId]);
  const row=result.rows[0];if(!row)return null;let allowed=String(row.user_id)===String(userId);
  if(!allowed&&String(row.visibility||'public')!=='only-me'){if(!row.account_private)allowed=true;else{const f=await pool.query(`SELECT 1 FROM friendships WHERE (user_one_id=$1 AND user_two_id=$2) OR (user_one_id=$2 AND user_two_id=$1) LIMIT 1`,[userId,row.user_id]);allowed=f.rowCount>0;}}
  return allowed?row:false;
}
app.get('/api/posts/:postId/sound',requireApiAuth,async(request,response)=>{const postId=request.params.postId;if(!validNumericId(postId))return response.status(400).end();try{await ensureDatabase();const row=await postRowForPrivateAsset(postId,request.user.id);if(row===null)return response.status(404).end();if(row===false)return response.status(403).end();const sound=row.post_extras&&row.post_extras.sound;if(!sound)return response.status(404).end();const key=safePostStorageKey(sound.storageKey);if(key)return sendFileRange(request,response,postAssetPath(key),sound.mimeType||'audio/mpeg','private, max-age=31536000, immutable');if(sound.data){const decoded=dataUrlBuffer(sound.data,'audio');if(decoded&&decoded.bytes)return sendBufferRange(request,response,decoded.bytes,decoded.mimeType||sound.mimeType||'audio/mpeg','private, max-age=31536000, immutable');}response.status(404).end();}catch(error){console.error('Post sound load failed:',error.message);response.status(500).end();}});
app.get('/api/posts/:postId/sound-cover',requireApiAuth,async(request,response)=>{const postId=request.params.postId;if(!validNumericId(postId))return response.status(400).end();try{await ensureDatabase();const row=await postRowForPrivateAsset(postId,request.user.id);if(row===null)return response.status(404).end();if(row===false)return response.status(403).end();const sound=row.post_extras&&row.post_extras.sound;if(!sound)return response.status(404).end();const key=safePostStorageKey(sound.coverStorageKey);if(key)return sendFileRange(request,response,postAssetPath(key),sound.coverMimeType||'image/jpeg','private, max-age=31536000, immutable');if(sound.coverData){const decoded=dataUrlBuffer(sound.coverData,'image');if(decoded&&decoded.bytes)return sendBufferRange(request,response,decoded.bytes,decoded.mimeType||'image/jpeg','private, max-age=31536000, immutable');}response.status(404).end();}catch(error){console.error('Post sound cover load failed:',error.message);response.status(500).end();}});

app.get('/api/posts/:postId/media/:mediaIndex', requireApiAuth, async (request, response) => {
  const postId = request.params.postId;
  const mediaIndex = Number(request.params.mediaIndex);
  if (!validNumericId(postId) || !Number.isInteger(mediaIndex) || mediaIndex < 0) {
    return response.status(400).json({ error: 'Invalid post media.' });
  }
  try {
    await ensureDatabase();
    const result = await pool.query(
      `SELECT p.user_id, p.visibility, p.media_items, p.image_data, u.account_private
         FROM posts p
         JOIN users u ON u.id = p.user_id
        WHERE p.id = $1
        LIMIT 1`,
      [postId]
    );
    const row = result.rows[0];
    if (!row) return response.status(404).end();

    let allowed = String(row.user_id) === String(request.user.id);
    if (!allowed && String(row.visibility || 'public') !== 'only-me') {
      if (!row.account_private) {
        allowed = true;
      } else {
        const friendship = await pool.query(
          `SELECT 1
             FROM friendships
            WHERE (user_one_id = $1 AND user_two_id = $2)
               OR (user_one_id = $2 AND user_two_id = $1)
            LIMIT 1`,
          [request.user.id, row.user_id]
        );
        allowed = friendship.rowCount > 0;
      }
    }
    if (!allowed) return response.status(403).end();

    const media = normalizeStoredPostMedia(row.media_items, row.image_data || '');
    const item = media[mediaIndex];
    if (!item) return response.status(404).end();
    const storageKey=safePostStorageKey(item.storageKey);
    if(storageKey)return sendFileRange(request,response,postAssetPath(storageKey),item.mimeType || 'application/octet-stream','private, max-age=31536000, immutable');
    if(!item.data)return response.status(404).end();
    const decoded=dataUrlBuffer(item.data,item.type || '');if(!decoded||!decoded.bytes||!decoded.bytes.length)return response.status(404).end();
    return sendBufferRange(request,response,decoded.bytes,decoded.mimeType || item.mimeType || 'application/octet-stream','private, max-age=31536000, immutable');
  } catch (error) {
    console.error('Post media load failed:', error.message);
    response.status(500).end();
  }
});

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

app.get('/api/users/:userId/avatar', requireApiAuth, async (request,response)=>{
  const userId=request.params.userId;
  if(!validNumericId(userId))return response.status(400).end();
  try{
    await ensureDatabase();
    const result=await pool.query('SELECT profile_photo FROM users WHERE id=$1 LIMIT 1',[userId]);
    const source=String(result.rows[0]?.profile_photo||'');
    if(!source)return response.status(404).end();
    const fileMatch=source.match(/^\/api\/profile-media-file\/\d+\/profile\/([a-f0-9]{64})$/i);
    if(fileMatch){
      const media=await pool.query(`SELECT mime_type,image_data FROM profile_media_files WHERE user_id=$1 AND media_kind='profile' AND media_version=$2 LIMIT 1`,[userId,fileMatch[1]]);
      if(media.rows[0]){
        response.setHeader('Cache-Control',request.query.v?'private, max-age=31536000, immutable':'private, max-age=60');
        response.type(media.rows[0].mime_type||'image/jpeg').send(media.rows[0].image_data);return;
      }
    }
    const decoded=dataUrlBuffer(source,'image');
    if(!decoded)return response.status(404).end();
    const etag='"'+crypto.createHash('sha256').update(decoded.bytes).digest('hex').slice(0,24)+'"';
    response.setHeader('ETag',etag);response.setHeader('Cache-Control',request.query.v?'private, max-age=31536000, immutable':'private, max-age=60');
    if(request.headers['if-none-match']===etag)return response.status(304).end();
    response.type(decoded.mimeType).send(decoded.bytes);
  }catch(error){console.error('Avatar load failed:',error.message);response.status(500).end();}
});

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

function libraryCursorEncode(timestamp, id) {
  const time = new Date(timestamp || 0).getTime();
  if (!Number.isFinite(time) || !id) return '';
  return `${time}|${encodeURIComponent(String(id))}`;
}

function libraryCursorDecode(value) {
  const raw = String(value || '');
  const split = raw.indexOf('|');
  if (split < 1) return { time:'', id:'' };
  const millis = Number(raw.slice(0, split));
  if (!Number.isFinite(millis)) return { time:'', id:'' };
  let id = '';
  try { id = decodeURIComponent(raw.slice(split + 1)); } catch (_error) { id = raw.slice(split + 1); }
  return { time:new Date(millis).toISOString(), id };
}

app.get('/api/music-library', requireApiAuth, async (request, response) => {
  const limit = Math.max(6, Math.min(24, Number(request.query.limit) || 12));
  const cursor = libraryCursorDecode(request.query.cursor);
  try {
    await ensureDatabase();
    const result = await pool.query(
      `SELECT song_key, title, artist, mime_type, liked_at
         FROM liked_songs
        WHERE user_id = $1
          AND ($2::timestamptz IS NULL OR liked_at < $2 OR (liked_at = $2 AND song_key < $3))
        ORDER BY liked_at DESC, song_key DESC
        LIMIT $4`,
      [request.user.id, cursor.time || null, cursor.id || '', limit + 1]
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const items = rows.map(row => ({
      key:row.song_key,
      title:row.title,
      artist:row.artist || '',
      mimeType:row.mime_type,
      likedAt:row.liked_at,
      audioUrl:`/api/music-library/${encodeURIComponent(row.song_key)}/audio`
    }));
    const last = rows[rows.length - 1];
    response.set('Cache-Control', 'private, max-age=15, stale-while-revalidate=45');
    response.json({ items, songs:items, nextCursor:hasMore && last ? libraryCursorEncode(last.liked_at, last.song_key) : '' });
  } catch (error) {
    console.error('Music library load failed:', error.message);
    response.status(500).json({ error:'Could not load liked songs.' });
  }
});

app.get('/api/music-library/:songKey/audio', requireApiAuth, async (request, response) => {
  const songKey = String(request.params.songKey || '');
  if (!songKey || songKey.length > 500) return response.status(400).json({ error:'Invalid song.' });
  try {
    await ensureDatabase();
    const result = await pool.query(
      'SELECT audio_data, mime_type FROM liked_songs WHERE user_id = $1 AND song_key = $2 LIMIT 1',
      [request.user.id, songKey]
    );
    const row = result.rows[0];
    if (!row) return response.status(404).json({ error:'Song not found.' });
    return sendAdminActivityDataUri(request, response, row.audio_data, row.mime_type || 'audio/mpeg');
  } catch (error) {
    console.error('Music library audio failed:', error.message);
    response.status(500).json({ error:'Could not load the song.' });
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
    const story = await pool.query('SELECT * FROM stories WHERE id=$1 LIMIT 1', [storyId]);
    if (!story.rowCount) return response.status(404).json({ error: 'Story not found.' });
    const ownerId = String(story.rows[0].user_id);
    const isModerator = String(request.user.id) === '1';
    if (!isModerator && ownerId !== String(request.user.id)) return response.status(403).json({ error: 'You cannot delete this story.' });
    await pool.query('INSERT INTO admin_deleted_content (user_id, content_type, original_id, content) VALUES ($1,$2,$3,$4::jsonb)', [story.rows[0].user_id, 'story', String(storyId), JSON.stringify({ story:story.rows[0] })]);
    await pool.query('DELETE FROM stories WHERE id=$1', [storyId]);
    response.json({ ok:true, storyId:String(storyId) });
  } catch (error) { console.error('Story deletion failed:', error.message); response.status(500).json({ error:'Could not delete the story.' }); }
});

app.get('/api/reels', requireApiAuth, async (request, response) => {
  try {
    await ensureDatabase();
    const limit=Math.max(4,Math.min(12,Number(request.query.limit)||6));
    const cursor=libraryCursorDecode(request.query.cursor);
    const cursorId=/^\d+$/.test(cursor.id||'')?Number(cursor.id):0;
    const result = await pool.query(`
      SELECT r.id, r.user_id, r.caption, r.mime_type, r.visibility, r.allow_comments, r.edit_data, r.created_at, r.source_post_id, r.source_media_index,
             u.full_name, u.profile_photo,
             (SELECT COUNT(*)::int FROM reel_likes x WHERE x.reel_id=r.id) AS like_count,
             (SELECT COUNT(*)::int FROM reel_saves x WHERE x.reel_id=r.id) AS save_count,
             (SELECT COUNT(*)::int FROM reel_shares x WHERE x.reel_id=r.id) AS share_count,
             (SELECT COUNT(*)::int FROM reel_comments x WHERE x.reel_id=r.id) AS comment_count,
             EXISTS(SELECT 1 FROM reel_likes x WHERE x.reel_id=r.id AND x.user_id=$1) AS liked_by_me,
             EXISTS(SELECT 1 FROM reel_saves x WHERE x.reel_id=r.id AND x.user_id=$1) AS saved_by_me
        FROM reels r JOIN users u ON u.id=r.user_id
       WHERE (r.user_id=$1 OR (r.visibility<>'only-me' AND (NOT COALESCE(u.account_private,FALSE) OR EXISTS(
               SELECT 1 FROM friendships f WHERE (f.user_one_id=$1 AND f.user_two_id=r.user_id) OR (f.user_one_id=r.user_id AND f.user_two_id=$1)
             ))))
         AND ($2::timestamptz IS NULL OR r.created_at<$2 OR (r.created_at=$2 AND r.id<$3))
       ORDER BY r.created_at DESC,r.id DESC
       LIMIT $4`,[request.user.id,cursor.time||null,cursorId,limit+1]);
    const hasMore=result.rows.length>limit;
    const rows=result.rows.slice(0,limit);
    /* Never launch Reel FFmpeg jobs from feed metadata on the 512 MB web tier. */
    const reels=rows.map(row=>({
      id:String(row.id),userId:String(row.user_id),caption:row.caption||'',
      video:reelVideoUrl(row.id,'high'),videoHigh:reelVideoUrl(row.id,'high'),videoLow:reelVideoUrl(row.id,'low'),
      thumbnailUrl:reelThumbnailUrl(row.id),mimeType:'video/mp4',visibility:row.visibility,allowComments:Boolean(row.allow_comments),
      editData:stripHeavyReelEditData(row.edit_data),sourcePostId:row.source_post_id?String(row.source_post_id):'',
      sourceMediaIndex:row.source_media_index===null||row.source_media_index===undefined?null:Number(row.source_media_index),
      contentKey:row.source_post_id?`post:${row.source_post_id}:media:${Number(row.source_media_index||0)}`:`reel:${row.id}`,
      createdAt:row.created_at,author:row.full_name,profilePhoto:avatarDeliveryUrl(row.user_id,row.profile_photo),
      likeCount:Number(row.like_count||0),saveCount:Number(row.save_count||0),shareCount:Number(row.share_count||0),commentCount:Number(row.comment_count||0),
      likedByMe:Boolean(row.liked_by_me),savedByMe:Boolean(row.saved_by_me),comments:[]
    }));
    const last=rows[rows.length-1];
    response.set('Cache-Control','private, max-age=5, stale-while-revalidate=15');
    response.json({reels,nextCursor:hasMore&&last?libraryCursorEncode(last.created_at,last.id):''});
  } catch (error) { console.error('Reels load failed:', error.message); response.status(500).json({ error:'Could not load reels.' }); }
});

app.get('/api/reels/library', requireApiAuth, async (request, response) => {
  const kind = String(request.query.kind || 'saved').toLowerCase();
  const definitions = {
    saved:['reel_saves','created_at'],
    liked:['reel_likes','created_at'],
    shared:['reel_shares','shared_at'],
    watched:['reel_views','viewed_at']
  };
  const definition = definitions[kind];
  if (!definition) return response.status(400).json({ error:'Invalid library category.' });
  const limit = Math.max(6, Math.min(24, Number(request.query.limit) || 12));
  const cursor = libraryCursorDecode(request.query.cursor);
  const cursorId = /^\d+$/.test(cursor.id || '') ? Number(cursor.id) : 0;
  const [table, timestamp] = definition;
  try {
    await ensureDatabase();
    const result = await pool.query(`
      SELECT r.id, r.user_id, r.caption, r.mime_type, r.visibility, r.allow_comments, r.edit_data, r.created_at,
             u.full_name, u.profile_photo, history.${timestamp} AS library_at,
             (SELECT COUNT(*)::int FROM reel_likes rl WHERE rl.reel_id = r.id) AS like_count,
             (SELECT COUNT(*)::int FROM reel_saves rs WHERE rs.reel_id = r.id) AS save_count,
             (SELECT COUNT(*)::int FROM reel_shares rsh WHERE rsh.reel_id = r.id) AS share_count,
             EXISTS(SELECT 1 FROM reel_likes ml WHERE ml.reel_id = r.id AND ml.user_id = $1) AS liked_by_me,
             EXISTS(SELECT 1 FROM reel_saves ms WHERE ms.reel_id = r.id AND ms.user_id = $1) AS saved_by_me,
             EXISTS(SELECT 1 FROM reel_thumbnails rt WHERE rt.reel_id = r.id) AS thumbnail_ready
        FROM ${table} history
        JOIN reels r ON r.id = history.reel_id
        JOIN users u ON u.id = r.user_id
       WHERE history.user_id = $1
         AND ($2::timestamptz IS NULL OR history.${timestamp} < $2 OR (history.${timestamp} = $2 AND r.id < $3))
       ORDER BY history.${timestamp} DESC, r.id DESC
       LIMIT $4
    `, [request.user.id, cursor.time || null, cursorId, limit + 1]);
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    /* Library metadata stays CPU/memory cheap; thumbnails are uploaded by clients. */
    const items = rows.map(row => {
      const editData = normalizeReelEdits(row.edit_data);
      delete editData.previewPoster;
      return {
        id:String(row.id),
        userId:String(row.user_id),
        caption:row.caption || '',
        video:reelVideoUrl(row.id,'high'),
        videoHigh:reelVideoUrl(row.id,'high'),
        videoLow:reelVideoUrl(row.id,'low'),
        thumbnailUrl:reelThumbnailUrl(row.id),
      hlsReady:reelHlsReady(row.id),hls:reelHlsReady(row.id)?reelHlsUrl(row.id):'',
        thumbnailReady:Boolean(row.thumbnail_ready),
        mimeType:'video/mp4',
        visibility:row.visibility,
        allowComments:Boolean(row.allow_comments),
        editData:stripHeavyReelEditData(editData),
        createdAt:row.created_at,
        libraryAt:row.library_at,
        author:row.full_name,
        profilePhoto:avatarDeliveryUrl(row.user_id,row.profile_photo),
        likeCount:Number(row.like_count || 0),
        saveCount:Number(row.save_count || 0),
        shareCount:Number(row.share_count || 0),
        likedByMe:Boolean(row.liked_by_me),
        savedByMe:Boolean(row.saved_by_me),
        comments:[]
      };
    });
    const last = rows[rows.length - 1];
    response.set('Cache-Control', 'private, max-age=15, stale-while-revalidate=45');
    response.json({
      kind,
      items,
      nextCursor:hasMore && last ? libraryCursorEncode(last.library_at, last.id) : ''
    });
  } catch (error) {
    console.error('Reel library load failed:', error.message);
    response.status(500).json({ error:'Could not load your reel library.' });
  }
});

app.get('/api/reels/:reelId/thumbnail', requireApiAuth, async (request,response)=>{
  const reelId=request.params.reelId;if(!validNumericId(reelId))return response.status(400).end();
  try{
    await ensureDatabase();
    const access=await reelViewerAccess(reelId,request.user.id);if(!access.exists)return response.status(404).end();if(!access.allowed)return response.status(403).end();
    const result=await pool.query('SELECT mime_type,image_data,created_at FROM reel_thumbnails WHERE reel_id=$1 LIMIT 1',[reelId]);
    const media=result.rows[0];
    if(!media)return response.status(404).end();
    const createdAt=media.created_at?new Date(media.created_at):null;
    const versionStamp=createdAt&&Number.isFinite(createdAt.getTime())?createdAt.getTime():0;
    const etag=`"reel-thumb-${reelId}-${media.image_data.length}-${versionStamp}"`;
    response.setHeader('Cache-Control','private, max-age=31536000, immutable');
    response.setHeader('ETag',etag);
    if(createdAt)response.setHeader('Last-Modified',createdAt.toUTCString());
    if(String(request.headers['if-none-match']||'')===etag)return response.status(304).end();
    response.type(media.mime_type||'image/jpeg').send(media.image_data);
  }catch(error){console.error('Reel thumbnail failed:',error.message);response.status(500).end();}
});

app.get('/api/reels/:reelId/hls/status', requireApiAuth, async (request,response)=>{
  const reelId=request.params.reelId;if(!validNumericId(reelId))return response.status(400).json({error:'Invalid reel.'});
  try{await ensureDatabase();const access=await reelViewerAccess(reelId,request.user.id);if(!access.exists)return response.status(404).json({error:'Reel not found.'});if(!access.allowed)return response.status(403).json({error:'This reel is private.'});response.json({ready:reelHlsReady(reelId),hls:reelHlsReady(reelId)?reelHlsUrl(reelId):''});}
  catch(error){console.error('Reel HLS status failed:',error.message);response.status(500).json({error:'Could not check Reel stream.'});}
});
app.get('/api/reels/:reelId/hls/master.m3u8', requireApiAuth, async (request,response)=>{
  const reelId=request.params.reelId;if(!validNumericId(reelId))return response.status(400).end();
  try{await ensureDatabase();const access=await reelViewerAccess(reelId,request.user.id);if(!access.exists)return response.status(404).end();if(!access.allowed)return response.status(403).end();
    const file=path.join(reelHlsDirectory(reelId),'master.m3u8');if(!fs.existsSync(file)){ensureReelHls(reelId).catch(()=>{});return response.status(404).end();}
    response.setHeader('Content-Type','application/vnd.apple.mpegurl');response.setHeader('Cache-Control','private, max-age=31536000, immutable');return response.sendFile(file);
  }catch(error){console.error('Reel HLS master failed:',error.message);response.status(500).end();}
});
app.get('/api/reels/:reelId/hls/:rendition/index.m3u8', requireApiAuth, async (request,response)=>{
  const reelId=request.params.reelId,rendition=safeHlsLeaf(request.params.rendition);if(!validNumericId(reelId)||!['360','720','1080'].includes(rendition))return response.status(400).end();
  try{await ensureDatabase();const access=await reelViewerAccess(reelId,request.user.id);if(!access.exists)return response.status(404).end();if(!access.allowed)return response.status(403).end();const file=path.join(reelHlsDirectory(reelId),rendition,'index.m3u8');if(!fs.existsSync(file))return response.status(404).end();response.setHeader('Content-Type','application/vnd.apple.mpegurl');response.setHeader('Cache-Control','private, max-age=31536000, immutable');return response.sendFile(file);}catch(error){console.error('Reel HLS playlist failed:',error.message);response.status(500).end();}
});
app.get('/api/reels/:reelId/hls/:rendition/:segment', requireApiAuth, async (request,response)=>{
  const reelId=request.params.reelId,rendition=safeHlsLeaf(request.params.rendition),segment=safeHlsLeaf(request.params.segment);if(!validNumericId(reelId)||!['360','720','1080'].includes(rendition)||!segment)return response.status(400).end();
  if(!(segment==='init.mp4'||/^seg_\d{5}\.m4s$/.test(segment)))return response.status(400).end();
  try{await ensureDatabase();const access=await reelViewerAccess(reelId,request.user.id);if(!access.exists)return response.status(404).end();if(!access.allowed)return response.status(403).end();const file=path.join(reelHlsDirectory(reelId),rendition,segment);if(!fs.existsSync(file))return response.status(404).end();response.setHeader('Content-Type',segment.endsWith('.m4s')?'video/iso.segment':'video/mp4');response.setHeader('Cache-Control','private, max-age=31536000, immutable');return response.sendFile(file);}catch(error){console.error('Reel HLS segment failed:',error.message);response.status(500).end();}
});

app.get('/api/reels/:reelId/video', requireApiAuth, async (request, response) => {
  const reelId=request.params.reelId;if(!validNumericId(reelId))return response.status(400).json({error:'Invalid reel.'});
  try{
    await ensureDatabase();
    const access=await reelViewerAccess(reelId,request.user.id);if(!access.exists)return response.status(404).json({error:'Reel not found.'});if(!access.allowed)return response.status(403).json({error:'This reel is private.'});
    let quality=String(request.query.quality||'high').toLowerCase();
    const ect=String(request.headers.ect||'').toLowerCase();
    const saveData=String(request.headers['save-data']||'').toLowerCase()==='on';
    if(quality==='auto')quality=(saveData||ect==='2g'||ect==='slow-2g'||ect==='3g')?'low':'high';
    if(!['low','high'].includes(quality))quality='high';
    if(await sendReelVariantRange(request,response,reelId,quality))return;
    if(quality==='high'&&await sendReelVariantRange(request,response,reelId,'low'))return;
    if(await sendReelVariantRange(request,response,reelId,'source'))return;
    /* Pre-v55 legacy rows can still be served, but never trigger FFmpeg here. */
    const source=await reelLegacySource(reelId);
    if(!source)return response.status(404).json({error:'Video media not found.'});
    return sendBufferRange(request,response,source.bytes,source.mimeType,'private, max-age=31536000, immutable');
  }catch(error){console.error('Reel video load failed:',error.message);response.status(500).json({error:'Could not load the reel video.'});}
});


app.get('/api/reels/resolve', requireApiAuth, async (request, response) => {
  const reelId = validNumericId(request.query.reelId) ? String(request.query.reelId) : '';
  const postId = validNumericId(request.query.postId) ? String(request.query.postId) : '';
  const mediaIndex = Number.isInteger(Number(request.query.mediaIndex)) && Number(request.query.mediaIndex) >= 0 ? Number(request.query.mediaIndex) : null;
  if (!reelId && !(postId && mediaIndex !== null)) return response.status(400).json({ error:'Choose a valid video.' });
  try {
    await ensureDatabase();
    const where = reelId ? 'r.id=$2' : 'r.source_post_id=$2 AND r.source_media_index=$3';
    const params = reelId ? [request.user.id, reelId] : [request.user.id, postId, mediaIndex];
    const result = await pool.query(`
      SELECT r.id,r.user_id,r.caption,r.mime_type,r.visibility,r.allow_comments,r.edit_data,r.created_at,r.source_post_id,r.source_media_index,
             u.full_name,u.profile_photo,
             (SELECT COUNT(*)::int FROM reel_likes x WHERE x.reel_id=r.id) AS like_count,
             (SELECT COUNT(*)::int FROM reel_saves x WHERE x.reel_id=r.id) AS save_count,
             (SELECT COUNT(*)::int FROM reel_shares x WHERE x.reel_id=r.id) AS share_count,
             (SELECT COUNT(*)::int FROM reel_comments x WHERE x.reel_id=r.id) AS comment_count,
             EXISTS(SELECT 1 FROM reel_likes x WHERE x.reel_id=r.id AND x.user_id=$1) AS liked_by_me,
             EXISTS(SELECT 1 FROM reel_saves x WHERE x.reel_id=r.id AND x.user_id=$1) AS saved_by_me
        FROM reels r JOIN users u ON u.id=r.user_id
       WHERE ${where}
         AND (r.user_id=$1 OR (r.visibility<>'only-me' AND (NOT COALESCE(u.account_private,FALSE) OR EXISTS(
           SELECT 1 FROM friendships f WHERE (f.user_one_id=$1 AND f.user_two_id=r.user_id) OR (f.user_one_id=r.user_id AND f.user_two_id=$1)
         ))))
       LIMIT 1`, params);
    const row=result.rows[0];
    if(!row)return response.status(404).json({error:'This video is not available in Reels.'});
    response.set('Cache-Control','private, max-age=5');
    response.json({reel:{
      id:String(row.id),userId:String(row.user_id),caption:row.caption||'',
      video:reelVideoUrl(row.id,'high'),videoHigh:reelVideoUrl(row.id,'high'),videoLow:reelVideoUrl(row.id,'low'),
      thumbnailUrl:reelThumbnailUrl(row.id),mimeType:row.mime_type||'video/mp4',visibility:row.visibility,allowComments:Boolean(row.allow_comments),
      editData:stripHeavyReelEditData(row.edit_data),sourcePostId:row.source_post_id?String(row.source_post_id):'',
      sourceMediaIndex:row.source_media_index===null||row.source_media_index===undefined?null:Number(row.source_media_index),
      contentKey:row.source_post_id?`post:${row.source_post_id}:media:${Number(row.source_media_index||0)}`:`reel:${row.id}`,
      createdAt:row.created_at,author:row.full_name,profilePhoto:avatarDeliveryUrl(row.user_id,row.profile_photo),
      likeCount:Number(row.like_count||0),saveCount:Number(row.save_count||0),shareCount:Number(row.share_count||0),commentCount:Number(row.comment_count||0),
      likedByMe:Boolean(row.liked_by_me),savedByMe:Boolean(row.saved_by_me),comments:[]
    }});
  } catch(error) {
    console.error('Reel resolve failed:',error.message);
    response.status(500).json({error:'Could not open this video.'});
  }
});

app.post('/api/reel-uploads', requireApiAuth, async (request,response)=>{
  const caption=String(request.body?.caption||'').trim();
  const visibility=String(request.body?.visibility||'public').toLowerCase();
  const allowComments=request.body?.allowComments!==false;
  const mimeType=String(request.body?.mimeType||'video/mp4').toLowerCase().split(';')[0];
  const editData=request.body?.editData&&typeof request.body.editData==='object'?request.body.editData:{};
  if(caption.length>500)return response.status(400).json({error:'Reel caption is too long.'});
  if(!['public','followers','friends','only-me'].includes(visibility))return response.status(400).json({error:'Choose a valid Reel audience.'});
  if(!/^video\/(mp4|webm|quicktime|x-m4v|3gpp|mpeg|ogg)$/i.test(mimeType))return response.status(400).json({error:'Choose a supported video.'});
  try{
    await ensureDatabase();
    const uploadId=crypto.randomBytes(24).toString('hex');
    const normalized=normalizeReelEdits(editData);normalized.previewPoster='';
    await pool.query(`INSERT INTO reel_upload_sessions (id,user_id,caption,mime_type,visibility,allow_comments,edit_data)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,[uploadId,request.user.id,caption,mimeType,visibility,allowComments,normalized]);
    response.status(201).json({ok:true,uploadId,uploadUrl:'/api/reel-uploads/'+uploadId});
  }catch(error){console.error('Reel upload init failed:',error.message);response.status(500).json({error:'Could not start the Reel upload.'});}
});

app.put('/api/reel-uploads/:uploadId', requireApiAuth, express.raw({type:['video/*','application/octet-stream'],limit:'60mb'}), async (request,response)=>{
  const uploadId=String(request.params.uploadId||'');
  if(!/^[a-f0-9]{48}$/.test(uploadId))return response.status(400).json({error:'Invalid Reel upload.'});
  const bytes=Buffer.isBuffer(request.body)?request.body:Buffer.from(request.body||'');
  if(bytes.length<1024||bytes.length>60*1024*1024)return response.status(400).json({error:'The posted Reel must be 60 MB or smaller.'});
  try{
    await ensureDatabase();
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const sessionResult=await client.query('SELECT * FROM reel_upload_sessions WHERE id=$1 AND user_id=$2 AND expires_at>NOW() FOR UPDATE',[uploadId,request.user.id]);
      const session=sessionResult.rows[0];
      if(!session){await client.query('ROLLBACK');return response.status(404).json({error:'This Reel upload expired. Try posting again.'});}
      const result=await client.query(`INSERT INTO reels (user_id,caption,video_data,mime_type,visibility,allow_comments,edit_data)
        VALUES ($1,$2,NULL,$3,$4,$5,$6) RETURNING id,user_id,caption,mime_type,visibility,allow_comments,edit_data,created_at`,
        [request.user.id,session.caption,session.mime_type,session.visibility,session.allow_comments,session.edit_data]);
      const reel=result.rows[0];
      await storeReelVariant(client,reel.id,'source',session.mime_type,bytes);
      await client.query('DELETE FROM reel_upload_sessions WHERE id=$1',[uploadId]);
      await client.query('COMMIT');
      response.status(201).json({ok:true,reel:{...reel,contentKey:`reel:${reel.id}`,video:reelVideoUrl(reel.id,'high'),videoHigh:reelVideoUrl(reel.id,'high'),videoLow:reelVideoUrl(reel.id,'low'),thumbnailUrl:reelThumbnailUrl(reel.id),hlsReady:false,hls:''}});
      ensureReelHls(reel.id).catch(()=>{});
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }catch(error){console.error('Reel binary upload failed:',error.message);response.status(500).json({error:'Could not upload the Reel. Try again.'});}
});

app.put('/api/reels/:reelId/thumbnail', requireApiAuth, express.raw({type:'image/*',limit:'1mb'}), async (request,response)=>{
  const reelId=request.params.reelId;
  if(!validNumericId(reelId))return response.status(400).json({error:'Invalid Reel.'});
  const bytes=Buffer.isBuffer(request.body)?request.body:Buffer.from(request.body||'');
  if(!bytes.length||bytes.length>768*1024)return response.status(400).json({error:'Invalid Reel thumbnail.'});
  const mimeType=String(request.headers['content-type']||'image/jpeg').toLowerCase().split(';')[0];
  if(!/^image\/(jpeg|png|webp)$/.test(mimeType))return response.status(400).json({error:'Invalid Reel thumbnail.'});
  try{
    await ensureDatabase();
    const owner=await pool.query('SELECT id FROM reels WHERE id=$1 AND user_id=$2 LIMIT 1',[reelId,request.user.id]);
    if(!owner.rowCount)return response.status(404).json({error:'Reel not found.'});
    await pool.query(`INSERT INTO reel_thumbnails (reel_id,mime_type,image_data) VALUES ($1,$2,$3)
      ON CONFLICT (reel_id) DO UPDATE SET mime_type=EXCLUDED.mime_type,image_data=EXCLUDED.image_data,created_at=NOW()`,[reelId,mimeType,bytes]);
    response.status(204).end();
  }catch(error){console.error('Reel thumbnail upload failed:',error.message);response.status(500).json({error:'Could not save Reel thumbnail.'});}
});

app.post('/api/reels', requireApiAuth, async (request, response) => {
  let caption='',visibility='public',allowComments=true,editData={},mimeType='',sourceBytes=null,thumbnailBytes=null,thumbnailMimeType='image/jpeg';
  try{
    const contentType=String(request.headers['content-type']||'');
    if(contentType.startsWith('multipart/form-data')){
      const webRequest=new Request('http://localhost/api/reels',{method:'POST',headers:{'content-type':contentType},body:Readable.toWeb(request),duplex:'half'});
      const form=await webRequest.formData();
      const file=form.get('video');
      if(!file||typeof file.arrayBuffer!=='function')return response.status(400).json({error:'Choose a video.'});
      sourceBytes=Buffer.from(await file.arrayBuffer());
      if(sourceBytes.length<1024||sourceBytes.length>60*1024*1024)return response.status(400).json({error:'The posted Reel must be 60 MB or smaller.'});
      mimeType=String(file.type||form.get('mimeType')||'video/mp4').toLowerCase();
      const thumbnail=form.get('thumbnail');
      if(thumbnail&&typeof thumbnail.arrayBuffer==='function'){
        const thumbnailType=String(thumbnail.type||'image/jpeg').toLowerCase();
        if(/^image\/(jpeg|png|webp)$/.test(thumbnailType)){
          const bytes=Buffer.from(await thumbnail.arrayBuffer());
          if(bytes.length>0&&bytes.length<=768*1024){thumbnailBytes=bytes;thumbnailMimeType=thumbnailType;}
        }
      }
      caption=String(form.get('caption')||'').trim();visibility=String(form.get('visibility')||'public').toLowerCase();
      allowComments=String(form.get('allowComments')||'true')!=='false';
      try{editData=JSON.parse(String(form.get('editData')||'{}'));}catch(_error){editData={};}
    }else{
      const video=request.body?.video||'';const decoded=dataUrlBuffer(video,'video');
      if(!decoded||decoded.bytes.length>60*1024*1024)return response.status(400).json({error:'The posted Reel must be 60 MB or smaller.'});
      sourceBytes=decoded.bytes;mimeType=String(request.body?.mimeType||decoded.mimeType).toLowerCase();caption=String(request.body?.caption||'').trim();
      visibility=String(request.body?.visibility||'public').toLowerCase();allowComments=request.body?.allowComments!==false;editData=request.body?.editData||{};
    }
    if(caption.length>500)return response.status(400).json({error:'Reel caption is too long.'});
    if(!['public','followers','friends','only-me'].includes(visibility))return response.status(400).json({error:'Choose a valid Reel audience.'});
    await ensureDatabase();
    const normalized=normalizeReelEdits(editData);normalized.previewPoster='';
    const result=await pool.query(`INSERT INTO reels (user_id,caption,video_data,mime_type,visibility,allow_comments,edit_data)
      VALUES ($1,$2,NULL,$3,$4,$5,$6) RETURNING id,user_id,caption,mime_type,visibility,allow_comments,edit_data,created_at`,
      [request.user.id,caption,mimeType,visibility,allowComments,normalized]);
    const reel=result.rows[0];
    await storeReelVariant(pool,reel.id,'source',mimeType,sourceBytes);
    if(thumbnailBytes){
      await pool.query(`INSERT INTO reel_thumbnails (reel_id,mime_type,image_data) VALUES ($1,$2,$3)
        ON CONFLICT (reel_id) DO UPDATE SET mime_type=EXCLUDED.mime_type,image_data=EXCLUDED.image_data,created_at=NOW()`,
        [reel.id,thumbnailMimeType,thumbnailBytes]);
    }
    sourceBytes=null;thumbnailBytes=null;
    response.status(201).json({ok:true,processing:false,reel:{...reel,contentKey:`reel:${reel.id}`,video:reelVideoUrl(reel.id,'high'),videoHigh:reelVideoUrl(reel.id,'high'),videoLow:reelVideoUrl(reel.id,'low'),thumbnailUrl:reelThumbnailUrl(reel.id),hlsReady:false,hls:''}});
    ensureReelHls(reel.id).catch(()=>{});
  }catch(error){console.error('Reel creation failed:',error);response.status(500).json({error:'Could not publish the reel.'});}
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

app.post('/api/notifications/device-token', requireApiAuth, async (request, response) => {
  const token = String(request.body?.token || '').trim();

  if (token.length < 20 || token.length > 4096) {
    return response.status(400).json({ error: 'Invalid notification device token.' });
  }

  try {
    await ensureDatabase();

    await pool.query(
      `INSERT INTO fcm_device_tokens (user_id, token, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (token)
       DO UPDATE SET
         user_id = EXCLUDED.user_id,
         updated_at = NOW()`,
      [request.user.id, token]
    );

    response.json({ ok: true });
  } catch (error) {
    console.error('Notification device token registration failed:', error.message);
    response.status(500).json({ error: 'Could not register notification device.' });
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


/* ===================== Messenger V85 ===================== */
const messengerSocketsByUser = new Map();
const messengerTypingLast = new Map();

/* Temporary Messenger latency benchmark.
 * Keeps only timing metadata in memory; no message bodies or user identifiers.
 * Samples reset when the Node process restarts.
 */

function messengerSocketSet(userId) {
  const key = String(userId);
  let set = messengerSocketsByUser.get(key);
  if (!set) { set = new Set(); messengerSocketsByUser.set(key, set); }
  return set;
}
function messengerUserOnline(userId) {
  const set = messengerSocketsByUser.get(String(userId));
  return Boolean(set && [...set].some(socket => socket.readyState === WebSocket.OPEN));
}
function messengerSendToUser(userId, payload) {
  const set = messengerSocketsByUser.get(String(userId));
  if (!set) return;
  const encoded = JSON.stringify(payload);
  for (const socket of set) if (socket.readyState === WebSocket.OPEN) {
    try { socket.send(encoded); } catch (_error) {}
  }
}

async function messengerMemberIds(conversationId) {
  const result = await pool.query('SELECT user_id FROM messenger_conversation_members WHERE conversation_id=$1', [conversationId]);
  return result.rows.map(row => String(row.user_id));
}
async function messengerBroadcastConversation(conversationId, payload, excludeUserId) {
  const ids = await messengerMemberIds(conversationId);
  for (const id of ids) if (!excludeUserId || String(id) !== String(excludeUserId)) messengerSendToUser(id, payload);
}
async function messengerBroadcastPersonalizedMessage(conversationId, type, messageId) {
  const ids = await messengerMemberIds(conversationId);
  for (const id of ids) {
    const message = await loadMessengerMessage(messageId, id);
    if (message) messengerSendToUser(id, {type, conversationId:String(conversationId), message});
  }
}
async function messengerBroadcastConversationSummaries(conversationId) {
  const ids = await messengerMemberIds(conversationId);
  for (const id of ids) {
    const conversation = await messengerConversationSummary(conversationId, id);
    if (conversation) messengerSendToUser(id, {type:'conversation_update', conversation});
  }
}
async function messengerRequireMember(conversationId, userId) {
  if (!validNumericId(conversationId)) return false;
  const result = await pool.query('SELECT 1 FROM messenger_conversation_members WHERE conversation_id=$1 AND user_id=$2 LIMIT 1', [conversationId, userId]);
  return result.rowCount > 0;
}
async function messengerConversationBlocked(conversationId) {
  const result=await pool.query(`SELECT 1 FROM messenger_conversations c
    JOIN messenger_conversation_members a ON a.conversation_id=c.id
    JOIN messenger_conversation_members b ON b.conversation_id=c.id AND b.user_id<>a.user_id
    JOIN messenger_user_blocks ub ON (ub.blocker_id=a.user_id AND ub.blocked_id=b.user_id) OR (ub.blocker_id=b.user_id AND ub.blocked_id=a.user_id)
    WHERE c.id=$1 AND c.conversation_type='direct' LIMIT 1`,[conversationId]);
  return result.rowCount>0;
}
function messengerAttachmentUrl(id) { return `/api/messaging/attachments/${encodeURIComponent(String(id))}`; }
async function messengerSharedContent(contentType,contentId,viewerId) {
  const type=String(contentType||'').toLowerCase(),id=String(contentId||'');
  if(!validNumericId(id)||!['reel','post'].includes(type))return null;
  if(type==='reel'){
    const access=await reelViewerAccess(id,viewerId);if(!access.exists||!access.allowed)return null;
    const result=await pool.query(`SELECT r.id,r.caption,r.user_id,u.full_name,u.profile_photo FROM reels r JOIN users u ON u.id=r.user_id WHERE r.id=$1 LIMIT 1`,[id]);
    const row=result.rows[0];if(!row)return null;
    return{type:'reel',id:String(row.id),author:row.full_name||'Facebook user',authorId:String(row.user_id),authorAvatar:avatarDeliveryUrl(row.user_id,row.profile_photo),caption:row.caption||'',previewUrl:reelThumbnailUrl(row.id),available:true};
  }
  const result=await pool.query(`SELECT p.id,p.user_id,p.body,p.image_data,p.media_items,p.visibility,u.full_name,u.profile_photo,COALESCE(u.account_private,FALSE) AS account_private
    FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=$1 LIMIT 1`,[id]);
  const row=result.rows[0];if(!row)return null;
  if(String(row.user_id)!==String(viewerId)){
    if(row.visibility==='only-me')return null;
    if(row.account_private){const friendship=await pool.query(`SELECT 1 FROM friendships WHERE (user_one_id=$1 AND user_two_id=$2) OR (user_one_id=$2 AND user_two_id=$1) LIMIT 1`,[viewerId,row.user_id]);if(!friendship.rowCount)return null;}
  }
  let storedMedia=row.media_items;if(typeof storedMedia==='string'){try{storedMedia=JSON.parse(storedMedia);}catch(_error){storedMedia=[];}}
  const media=normalizeStoredPostMedia(storedMedia,row.image_data||'');
  return{type:'post',id:String(row.id),author:row.full_name||'Facebook user',authorId:String(row.user_id),authorAvatar:avatarDeliveryUrl(row.user_id,row.profile_photo),caption:String(row.body||'').slice(0,500),previewUrl:media.length?`/api/messaging/shared/posts/${encodeURIComponent(String(row.id))}/preview`:'',available:true};
}
function messengerCursorEncode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function messengerCursorDecode(value) {
  if (!value) return null;
  try { return JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8')); } catch (_error) { return null; }
}
async function loadMessengerMessage(messageId, viewerId) {
  const result = await pool.query(`
    SELECT m.id,m.conversation_id,m.sender_id,m.client_id,m.message_type,m.body,m.reply_to_id,m.forwarded_from_id,m.edited_at,m.deleted_at,m.created_at,
      COALESCE(NULLIF(BTRIM(mn.nickname),''),u.full_name,'Facebook user') AS sender_name,u.profile_photo AS sender_photo,
      ra.id AS reply_id,ra.body AS reply_body,ra.message_type AS reply_type,COALESCE(NULLIF(BTRIM(rn.nickname),''),ru.full_name,'Facebook user') AS reply_sender_name,
      COALESCE((SELECT json_agg(json_build_object('id',a.id,'name',a.file_name,'mimeType',a.mime_type,'size',a.byte_size) ORDER BY a.id)
                FROM messenger_attachments a WHERE a.message_id=m.id),'[]'::json) AS attachments,
      COALESCE((SELECT json_agg(json_build_object('userId',r.user_id,'emoji',r.emoji,'name',COALESCE(ruser.full_name,'Facebook user')) ORDER BY r.created_at)
                FROM messenger_message_reactions r LEFT JOIN users ruser ON ruser.id=r.user_id WHERE r.message_id=m.id),'[]'::json) AS reactions,
      COALESCE((SELECT json_agg(json_build_object('userId',rc.user_id,'deliveredAt',rc.delivered_at,'readAt',rc.read_at))
                FROM messenger_message_receipts rc WHERE rc.message_id=m.id),'[]'::json) AS receipts
    FROM messenger_messages m
    LEFT JOIN users u ON u.id=m.sender_id
    LEFT JOIN messenger_conversation_nicknames mn ON mn.conversation_id=m.conversation_id AND mn.user_id=m.sender_id
    LEFT JOIN messenger_messages ra ON ra.id=m.reply_to_id
    LEFT JOIN users ru ON ru.id=ra.sender_id
    LEFT JOIN messenger_conversation_nicknames rn ON rn.conversation_id=m.conversation_id AND rn.user_id=ra.sender_id
    WHERE m.id=$1 AND NOT EXISTS(SELECT 1 FROM messenger_message_hides h WHERE h.message_id=m.id AND h.user_id=$2)
    LIMIT 1`, [messageId, viewerId]);
  if (!result.rowCount) return null;
  const row=result.rows[0];
  const receipts=Array.isArray(row.receipts)?row.receipts:[];
  let status='sent';
  if (receipts.some(r=>r.readAt||r.readat)) status='read';
  else if (receipts.some(r=>r.deliveredAt||r.deliveredat)) status='delivered';
  let sharedContent=null;
  if(!row.deleted_at&&(row.message_type==='shared_reel'||row.message_type==='shared_post'))sharedContent=await messengerSharedContent(row.message_type==='shared_reel'?'reel':'post',row.body,viewerId)||{type:row.message_type==='shared_reel'?'reel':'post',id:String(row.body||''),available:false};
  return {
    id:String(row.id),conversationId:String(row.conversation_id),senderId:row.sender_id?String(row.sender_id):'',clientId:row.client_id||'',
    type:row.message_type||'text',body:row.deleted_at?'':(row.body||''),deleted:Boolean(row.deleted_at),forwarded:Boolean(row.forwarded_from_id),editedAt:row.edited_at||null,createdAt:row.created_at,
    sender:{id:row.sender_id?String(row.sender_id):'',name:row.sender_name||'Facebook user',avatar:avatarDeliveryUrl(row.sender_id,row.sender_photo)},
    reply:row.reply_id?{id:String(row.reply_id),body:row.reply_body||'',type:row.reply_type||'text',senderName:row.reply_sender_name||'Facebook user'}:null,
    attachments:(Array.isArray(row.attachments)?row.attachments:[]).map(a=>({id:String(a.id),name:a.name||'',mimeType:a.mimeType||a.mimetype||'application/octet-stream',size:Number(a.size)||0,url:messengerAttachmentUrl(a.id)})),
    reactions:(Array.isArray(row.reactions)?row.reactions:[]).map(reaction=>({...reaction,avatar:avatarDeliveryUrl(reaction.userId||reaction.userid,''),mine:String(reaction.userId||reaction.userid)===String(viewerId)})),receipts,status,sharedContent
  };
}
async function loadMessengerMessages(messageIds, viewerId) {
  if (!Array.isArray(messageIds) || !messageIds.length) return [];

  const ids = messageIds.map(id => String(id));

  const result = await pool.query(`
    SELECT
      m.id,
      m.conversation_id,
      m.sender_id,
      m.client_id,
      m.message_type,
      m.body,
      m.reply_to_id,
      m.forwarded_from_id,
      m.edited_at,
      m.deleted_at,
      m.created_at,

      COALESCE(
        NULLIF(BTRIM(mn.nickname),''),
        u.full_name,
        'Facebook user'
      ) AS sender_name,

      u.profile_photo AS sender_photo,

      ra.id AS reply_id,
      ra.body AS reply_body,
      ra.message_type AS reply_type,

      COALESCE(
        NULLIF(BTRIM(rn.nickname),''),
        ru.full_name,
        'Facebook user'
      ) AS reply_sender_name,

      COALESCE((
        SELECT json_agg(
          json_build_object(
            'id', a.id,
            'name', a.file_name,
            'mimeType', a.mime_type,
            'size', a.byte_size
          )
          ORDER BY a.id
        )
        FROM messenger_attachments a
        WHERE a.message_id=m.id
      ), '[]'::json) AS attachments,

      COALESCE((
        SELECT json_agg(
          json_build_object(
            'userId', r.user_id,
            'emoji', r.emoji,
            'name', COALESCE(ruser.full_name,'Facebook user')
          )
          ORDER BY r.created_at
        )
        FROM messenger_message_reactions r
        LEFT JOIN users ruser ON ruser.id=r.user_id
        WHERE r.message_id=m.id
      ), '[]'::json) AS reactions,

      COALESCE((
        SELECT json_agg(
          json_build_object(
            'userId', rc.user_id,
            'deliveredAt', rc.delivered_at,
            'readAt', rc.read_at
          )
        )
        FROM messenger_message_receipts rc
        WHERE rc.message_id=m.id
      ), '[]'::json) AS receipts

    FROM messenger_messages m

    LEFT JOIN users u
      ON u.id=m.sender_id

    LEFT JOIN messenger_conversation_nicknames mn
      ON mn.conversation_id=m.conversation_id
     AND mn.user_id=m.sender_id

    LEFT JOIN messenger_messages ra
      ON ra.id=m.reply_to_id

    LEFT JOIN users ru
      ON ru.id=ra.sender_id

    LEFT JOIN messenger_conversation_nicknames rn
      ON rn.conversation_id=m.conversation_id
     AND rn.user_id=ra.sender_id

    WHERE
      m.id = ANY($1::bigint[])

      AND NOT EXISTS(
        SELECT 1
        FROM messenger_message_hides h
        WHERE h.message_id=m.id
          AND h.user_id=$2
      )

    ORDER BY array_position($1::bigint[], m.id)
  `, [ids, viewerId]);

  const messages = [];

  for (const row of result.rows) {
    const receipts = Array.isArray(row.receipts)
      ? row.receipts
      : [];

    let status = 'sent';

    if (receipts.some(r => r.readAt || r.readat)) {
      status = 'read';
    } else if (
      receipts.some(r => r.deliveredAt || r.deliveredat)
    ) {
      status = 'delivered';
    }

    let sharedContent = null;

    if (
      !row.deleted_at &&
      (
        row.message_type === 'shared_reel' ||
        row.message_type === 'shared_post'
      )
    ) {
      const sharedType =
        row.message_type === 'shared_reel'
          ? 'reel'
          : 'post';

      sharedContent =
        await messengerSharedContent(
          sharedType,
          row.body,
          viewerId
        ) || {
          type: sharedType,
          id: String(row.body || ''),
          available: false
        };
    }

    messages.push({
      id: String(row.id),

      conversationId:
        String(row.conversation_id),

      senderId:
        row.sender_id
          ? String(row.sender_id)
          : '',

      clientId:
        row.client_id || '',

      type:
        row.message_type || 'text',

      body:
        row.deleted_at
          ? ''
          : (row.body || ''),

      deleted:
        Boolean(row.deleted_at),

      forwarded:
        Boolean(row.forwarded_from_id),

      editedAt:
        row.edited_at || null,

      createdAt:
        row.created_at,

      sender: {
        id:
          row.sender_id
            ? String(row.sender_id)
            : '',

        name:
          row.sender_name ||
          'Facebook user',

        avatar:
          avatarDeliveryUrl(
            row.sender_id,
            row.sender_photo
          )
      },

      reply:
        row.reply_id
          ? {
              id: String(row.reply_id),
              body: row.reply_body || '',
              type: row.reply_type || 'text',
              senderName:
                row.reply_sender_name ||
                'Facebook user'
            }
          : null,

      attachments:
        (
          Array.isArray(row.attachments)
            ? row.attachments
            : []
        ).map(a => ({
          id: String(a.id),
          name: a.name || '',
          mimeType:
            a.mimeType ||
            a.mimetype ||
            'application/octet-stream',
          size: Number(a.size) || 0,
          url: messengerAttachmentUrl(a.id)
        })),

      reactions:
        (
          Array.isArray(row.reactions)
            ? row.reactions
            : []
        ).map(reaction => ({
          ...reaction,

          avatar:
            avatarDeliveryUrl(
              reaction.userId ||
              reaction.userid,
              ''
            ),

          mine:
            String(
              reaction.userId ||
              reaction.userid
            ) === String(viewerId)
        })),

      receipts,
      status,
      sharedContent
    });
  }

  return messages;
}

async function loadFreshMessengerTextMessage(messageId, viewerId) {
  const result = await pool.query(`
    SELECT
      m.id,
      m.conversation_id,
      m.sender_id,
      m.client_id,
      m.message_type,
      m.body,
      m.reply_to_id,
      m.forwarded_from_id,
      m.edited_at,
      m.deleted_at,
      m.created_at,
      COALESCE(NULLIF(BTRIM(mn.nickname),''),u.full_name,'Facebook user') AS sender_name,
      u.profile_photo AS sender_photo,
      ra.id AS reply_id,
      ra.body AS reply_body,
      ra.message_type AS reply_type,
      COALESCE(NULLIF(BTRIM(rn.nickname),''),ru.full_name,'Facebook user') AS reply_sender_name,
      COALESCE((
        SELECT json_agg(
          json_build_object(
            'userId',rc.user_id,
            'deliveredAt',rc.delivered_at,
            'readAt',rc.read_at
          )
        )
        FROM messenger_message_receipts rc
        WHERE rc.message_id=m.id
      ),'[]'::json) AS receipts
    FROM messenger_messages m
    LEFT JOIN users u
      ON u.id=m.sender_id
    LEFT JOIN messenger_conversation_nicknames mn
      ON mn.conversation_id=m.conversation_id
     AND mn.user_id=m.sender_id
    LEFT JOIN messenger_messages ra
      ON ra.id=m.reply_to_id
    LEFT JOIN users ru
      ON ru.id=ra.sender_id
    LEFT JOIN messenger_conversation_nicknames rn
      ON rn.conversation_id=m.conversation_id
     AND rn.user_id=ra.sender_id
    WHERE m.id=$1
    LIMIT 1
  `,[messageId]);

  if (!result.rowCount) return null;

  const row=result.rows[0];
  const receipts=Array.isArray(row.receipts)?row.receipts:[];

  let status='sent';
  if (receipts.some(r=>r.readAt||r.readat)) status='read';
  else if (receipts.some(r=>r.deliveredAt||r.deliveredat)) status='delivered';

  return {
    id:String(row.id),
    conversationId:String(row.conversation_id),
    senderId:row.sender_id?String(row.sender_id):'',
    clientId:row.client_id||'',
    type:'text',
    body:row.body||'',
    deleted:false,
    forwarded:false,
    editedAt:null,
    createdAt:row.created_at,
    sender:{
      id:row.sender_id?String(row.sender_id):'',
      name:row.sender_name||'Facebook user',
      avatar:avatarDeliveryUrl(row.sender_id,row.sender_photo)
    },
    reply:row.reply_id ? {
      id:String(row.reply_id),
      body:row.reply_body||'',
      type:row.reply_type||'text',
      senderName:row.reply_sender_name||'Facebook user'
    } : null,
    attachments:[],
    reactions:[],
    receipts,
    status,
    sharedContent:null
  };
}

async function messengerTouchConversation(conversationId) {
  await pool.query('UPDATE messenger_conversations SET updated_at=NOW() WHERE id=$1',[conversationId]);
}
async function messengerCreateReceipts(messageId, conversationId, senderId, knownMemberIds = null) {
  let memberIds;

  if (Array.isArray(knownMemberIds)) {
    memberIds = knownMemberIds
      .map(id => String(id))
      .filter(id => id !== String(senderId));
  } else {
    const members = await pool.query(
      'SELECT user_id FROM messenger_conversation_members WHERE conversation_id=$1 AND user_id<>$2',
      [conversationId, senderId]
    );
    memberIds = members.rows.map(row => String(row.user_id));
  }

  if (!memberIds.length) return {
    receipts: [],
    deliveredAt: null
  };

  const onlineIds = memberIds.filter(id => messengerUserOnline(id));
  const deliveredAt = onlineIds.length ? new Date() : null;

  await pool.query(`
    INSERT INTO messenger_message_receipts
      (message_id, user_id, delivered_at)
    SELECT
      $1,
      uid,
      CASE
        WHEN uid = ANY($3::bigint[]) THEN $4::timestamptz
        ELSE NULL
      END
    FROM unnest($2::bigint[]) AS uid
    ON CONFLICT(message_id, user_id)
    DO UPDATE SET delivered_at = COALESCE(
      messenger_message_receipts.delivered_at,
      EXCLUDED.delivered_at
    )
  `, [
    messageId,
    memberIds,
    onlineIds,
    deliveredAt
  ]);

  return {
    receipts: memberIds.map(id => ({
      userId: String(id),
      deliveredAt: onlineIds.includes(String(id))
        ? deliveredAt.toISOString()
        : null,
      readAt: null
    })),
    deliveredAt
  };
}
async function messengerFinalizeMessage(messageId, conversationId, senderId, fastFreshText = false) {
  if (fastFreshText) {
    const [, memberIds] = await Promise.all([
      messengerTouchConversation(conversationId),
      messengerMemberIds(conversationId)
    ]);

    const [receiptResult, message] = await Promise.all([
      messengerCreateReceipts(messageId, conversationId, senderId, memberIds),
      loadFreshMessengerTextMessage(messageId, senderId)
    ]);

    if (message && receiptResult) {
      message.receipts = receiptResult.receipts;
      message.status = receiptResult.receipts.some(r => r.deliveredAt)
        ? 'delivered'
        : 'sent';
    }

    if (message) {
      const payload = {
        type: 'message',
        conversationId: String(conversationId),
        message
      };

      for (const id of memberIds) {
        messengerSendToUser(id, payload);
      }
    }

    return message;
  }

  await messengerTouchConversation(conversationId);
  await messengerCreateReceipts(messageId,conversationId,senderId);
  const message=await loadMessengerMessage(messageId,senderId);
  await messengerBroadcastPersonalizedMessage(conversationId,'message',messageId);
  return message;
}
async function messengerConversationSummary(conversationId, viewerId) {
  const result=await pool.query(`
    SELECT c.id,c.conversation_type,c.title,c.theme_key,c.created_by,c.named_by,c.group_image,c.created_at,c.updated_at,cm.muted_until,cm.archived,cm.pinned,
      COALESCE((SELECT COUNT(*)::int FROM messenger_message_receipts rr JOIN messenger_messages mm ON mm.id=rr.message_id
                WHERE rr.user_id=$2 AND rr.read_at IS NULL AND mm.conversation_id=c.id AND mm.deleted_at IS NULL),0) AS unread_count,
      COALESCE((SELECT json_agg(json_build_object('id',u.id,'name',COALESCE(NULLIF(BTRIM(n.nickname),''),u.full_name,'Facebook user'),'originalName',COALESCE(u.full_name,'Facebook user'),'nickname',COALESCE(n.nickname,''),'avatar',u.profile_photo,'lastSeenAt',u.last_seen_at,'role',mx.role,'joinedAt',mx.joined_at) ORDER BY mx.joined_at,mx.user_id)
                FROM messenger_conversation_members mx JOIN users u ON u.id=mx.user_id LEFT JOIN messenger_conversation_nicknames n ON n.conversation_id=mx.conversation_id AND n.user_id=mx.user_id WHERE mx.conversation_id=c.id),'[]'::json) AS participants,
      lm.id AS last_id,lm.sender_id AS last_sender_id,lm.message_type AS last_type,lm.body AS last_body,lm.deleted_at AS last_deleted,lm.created_at AS last_created_at,
      EXISTS(SELECT 1 FROM messenger_attachments la WHERE la.message_id=lm.id AND LOWER(la.file_name) LIKE 'sticker-%') AS last_sticker
    FROM messenger_conversations c
    JOIN messenger_conversation_members cm ON cm.conversation_id=c.id AND cm.user_id=$2
    LEFT JOIN LATERAL (SELECT id,sender_id,message_type,body,deleted_at,created_at FROM messenger_messages
                       WHERE conversation_id=c.id AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM messenger_message_hides h WHERE h.message_id=messenger_messages.id AND h.user_id=$2)
                       ORDER BY id DESC LIMIT 1) lm ON TRUE
    WHERE c.id=$1 LIMIT 1`,[conversationId,viewerId]);
  if(!result.rowCount)return null;
  const r=result.rows[0];
  const participants=(Array.isArray(r.participants)?r.participants:[]).map(p=>({id:String(p.id),name:p.name||'Facebook user',originalName:p.originalName||p.originalname||p.name||'Facebook user',nickname:p.nickname||'',avatar:avatarDeliveryUrl(p.id,p.avatar),lastSeenAt:p.lastSeenAt||p.lastseenat||null,online:messengerUserOnline(p.id),role:p.role||'member',joinedAt:p.joinedAt||p.joinedat||null,isSelf:String(p.id)===String(viewerId)}));
  const others=participants.filter(p=>String(p.id)!==String(viewerId));
  const name=r.conversation_type==='group'?(r.title||'Group chat'):(others[0]?.name||'Conversation');
  const avatar=r.conversation_type==='group'?(r.group_image||''):(others[0]?.avatar||'');
  let lastText='';
  if(r.last_id){ if(r.last_deleted)lastText='Message deleted'; else if(r.last_sticker)lastText='Sent a sticker'; else if(r.last_type==='image')lastText='Sent a photo'; else if(r.last_type==='video')lastText='Sent a video'; else if(r.last_type==='audio')lastText='Voice message'; else if(r.last_type==='file')lastText='File'; else if(r.last_type==='shared_reel')lastText='Shared a reel'; else if(r.last_type==='shared_post')lastText='Shared a post'; else lastText=String(r.last_body||''); }
  const blockState=others[0]?await pool.query(`SELECT
    EXISTS(SELECT 1 FROM messenger_user_blocks WHERE blocker_id=$1 AND blocked_id=$2) AS blocked_by_me,
    EXISTS(SELECT 1 FROM messenger_user_blocks WHERE blocker_id=$2 AND blocked_id=$1) AS blocked_by_other`,[viewerId,others[0].id]):{rows:[{blocked_by_me:false,blocked_by_other:false}]};
  const namedBy=participants.find(p=>String(p.id)===String(r.named_by));
  return {id:String(r.id),type:r.conversation_type,name,avatar,participants,theme:r.theme_key||'default',createdBy:r.created_by?String(r.created_by):'',createdAt:r.created_at,isOwner:String(r.created_by)===String(viewerId),namedBy:r.named_by?String(r.named_by):'',namedByName:namedBy?.name||'',namedByIsSelf:String(r.named_by)===String(viewerId),blockedByMe:Boolean(blockState.rows[0]?.blocked_by_me),blockedByOther:Boolean(blockState.rows[0]?.blocked_by_other),updatedAt:r.updated_at,unread:Number(r.unread_count)||0,pinned:Boolean(r.pinned),archived:Boolean(r.archived),mutedUntil:r.muted_until||null,lastMessage:r.last_id?{id:String(r.last_id),senderId:r.last_sender_id?String(r.last_sender_id):'',type:r.last_type,body:lastText,sticker:Boolean(r.last_sticker),createdAt:r.last_created_at}:null};
}

app.get('/api/messaging/inbox', requireApiAuth, async (request,response)=>{
  try{
    await ensureDatabase();
    const limit=Math.max(1,Math.min(50,Number(request.query.limit)||30));
    const cursor=messengerCursorDecode(request.query.cursor);
    const values=[request.user.id,limit+1];
    let where="cm.user_id=$1 AND cm.archived=FALSE";
    if(cursor&&cursor.updatedAt&&validNumericId(cursor.id)){ values.push(cursor.updatedAt,cursor.id); where+=` AND (c.updated_at,c.id)<($3::timestamptz,$4::bigint)`; }
    const rows=await pool.query(`SELECT c.id,c.updated_at,cm.pinned FROM messenger_conversations c JOIN messenger_conversation_members cm ON cm.conversation_id=c.id WHERE ${where} ORDER BY cm.pinned DESC,c.updated_at DESC,c.id DESC LIMIT $2`,values);
    const hasMore=rows.rows.length>limit; const slice=rows.rows.slice(0,limit); const conversations=[];
    for(const row of slice){ const item=await messengerConversationSummary(row.id,request.user.id); if(item)conversations.push(item); }
    const last=slice[slice.length-1];
    response.json({conversations,nextCursor:hasMore&&last?messengerCursorEncode({updatedAt:last.updated_at,id:String(last.id)}):null});
  }catch(error){console.error('Messenger inbox failed:',error.message);response.status(500).json({error:'Could not load messages.'});}
});

app.get('/api/messaging/contacts', requireApiAuth, async (request,response)=>{
  try{
    await ensureDatabase(); const q=String(request.query.q||'').trim().slice(0,80); const pattern=`%${q}%`;
    const result=await pool.query(`SELECT u.id,COALESCE(NULLIF(BTRIM(u.full_name),''),'Facebook user') AS full_name,u.profile_photo,u.last_seen_at,
      EXISTS(SELECT 1 FROM friendships f WHERE (f.user_one_id=$1 AND f.user_two_id=u.id) OR (f.user_two_id=$1 AND f.user_one_id=u.id)) AS is_friend
      FROM users u WHERE u.id<>$1 AND u.deactivated_at IS NULL AND ($2='' OR u.full_name ILIKE $3 OR COALESCE(u.username,'') ILIKE $3)
      ORDER BY is_friend DESC,u.full_name ASC LIMIT 30`,[request.user.id,q,pattern]);
    response.json({contacts:result.rows.map(r=>({id:String(r.id),name:r.full_name,avatar:avatarDeliveryUrl(r.id,r.profile_photo),online:messengerUserOnline(r.id),lastSeenAt:r.last_seen_at||null,isFriend:Boolean(r.is_friend)}))});
  }catch(error){console.error('Messenger contacts failed:',error.message);response.status(500).json({error:'Could not load contacts.'});}
});

app.post('/api/messaging/conversations', requireApiAuth, async (request,response)=>{
  try{
    await ensureDatabase();
    const type=String(request.body?.type||'direct')==='group'?'group':'direct';
    let conversationId;
    if(type==='direct'){
      const other=String(request.body?.userId||''); if(!validNumericId(other)||String(other)===String(request.user.id))return response.status(400).json({error:'Choose a valid person.'});
      const exists=await pool.query('SELECT id FROM users WHERE id=$1 AND deactivated_at IS NULL LIMIT 1',[other]); if(!exists.rowCount)return response.status(404).json({error:'User not found.'});
      const ids=[String(request.user.id),String(other)].sort((a,b)=>Number(a)-Number(b)); const key=`direct:${ids[0]}:${ids[1]}`;
      const created=await pool.query(`INSERT INTO messenger_conversations(conversation_type,created_by,direct_key) VALUES('direct',$1,$2)
        ON CONFLICT(direct_key) DO UPDATE SET direct_key=EXCLUDED.direct_key RETURNING id`,[request.user.id,key]); conversationId=created.rows[0].id;
      await pool.query(`INSERT INTO messenger_conversation_members(conversation_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member') ON CONFLICT DO NOTHING`,[conversationId,request.user.id,other]);
    }else{
      const raw=Array.isArray(request.body?.memberIds)?request.body.memberIds:[]; const members=[...new Set(raw.map(String).filter(validNumericId).filter(id=>String(id)!==String(request.user.id)))].slice(0,49);
      if(members.length<1)return response.status(400).json({error:'Choose at least one person.'});
      const memberNames=await pool.query(`SELECT id,COALESCE(NULLIF(BTRIM(full_name),''),'Facebook user') AS name FROM users WHERE id=ANY($1::bigint[])`,[[String(request.user.id),...members]]);
      const orderedIds=[String(request.user.id),...members],names=orderedIds.map(id=>memberNames.rows.find(row=>String(row.id)===String(id))?.name||'Facebook user');
      const automaticTitle=names.length<=2?names.join(', '):`${names[0]}, ${names[1]} and ${names.length-2} ${names.length-2===1?'other':'others'}`;
      const title=String(request.body?.title||'').trim().slice(0,160)||automaticTitle;
      const created=await pool.query(`INSERT INTO messenger_conversations(conversation_type,title,created_by,named_by) VALUES('group',$1,$2,$2) RETURNING id`,[title,request.user.id]); conversationId=created.rows[0].id;
      await pool.query(`INSERT INTO messenger_conversation_members(conversation_id,user_id,role) VALUES($1,$2,'admin')`,[conversationId,request.user.id]);
      for(const id of members)await pool.query(`INSERT INTO messenger_conversation_members(conversation_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING`,[conversationId,id]);
    }
    const summary=await messengerConversationSummary(conversationId,request.user.id); await messengerBroadcastConversation(conversationId,{type:'conversation',conversation:summary}); response.json({conversation:summary});
  }catch(error){console.error('Messenger conversation create failed:',error.message);response.status(500).json({error:'Could not create conversation.'});}
});

app.get('/api/messaging/conversations/:conversationId/messages', requireApiAuth, async (request,response)=>{
  const cid=request.params.conversationId; if(!validNumericId(cid))return response.status(400).json({error:'Invalid conversation.'});
  try{
    await ensureDatabase(); if(!(await messengerRequireMember(cid,request.user.id)))return response.status(403).json({error:'Conversation unavailable.'});
    const around=validNumericId(request.query.around)?String(request.query.around):null;
    if(around){
      const nearby=await pool.query(`SELECT id FROM (
        (SELECT m.id FROM messenger_messages m WHERE m.conversation_id=$1 AND m.deleted_at IS NULL AND m.id<=$3
          AND NOT EXISTS(SELECT 1 FROM messenger_message_hides h WHERE h.message_id=m.id AND h.user_id=$2) ORDER BY m.id DESC LIMIT 40)
        UNION
        (SELECT m.id FROM messenger_messages m WHERE m.conversation_id=$1 AND m.deleted_at IS NULL AND m.id>$3
          AND NOT EXISTS(SELECT 1 FROM messenger_message_hides h WHERE h.message_id=m.id AND h.user_id=$2) ORDER BY m.id ASC LIMIT 40)
      ) AS selected ORDER BY id`,[cid,request.user.id,around]);
      const ids=nearby.rows.map(row=>String(row.id));
      const messages=await loadMessengerMessages(ids,request.user.id);
      let nextBefore=null;
      if(ids.length){const older=await pool.query(`SELECT 1 FROM messenger_messages m WHERE m.conversation_id=$1 AND m.deleted_at IS NULL AND m.id<$3 AND NOT EXISTS(SELECT 1 FROM messenger_message_hides h WHERE h.message_id=m.id AND h.user_id=$2) LIMIT 1`,[cid,request.user.id,ids[0]]);if(older.rowCount)nextBefore=ids[0];}
      return response.json({messages,nextBefore});
    }
    const limit=Math.max(1,Math.min(80,Number(request.query.limit)||40)); const before=validNumericId(request.query.before)?String(request.query.before):null;
    const values=[cid,request.user.id,limit+1]; let condition='m.conversation_id=$1 AND m.deleted_at IS NULL'; if(before){values.push(before);condition+=' AND m.id<$4';}
    const result=await pool.query(`SELECT m.id FROM messenger_messages m WHERE ${condition} AND NOT EXISTS(SELECT 1 FROM messenger_message_hides h WHERE h.message_id=m.id AND h.user_id=$2) ORDER BY m.id DESC LIMIT $3`,values);
    const hasMore=result.rows.length>limit;
    const ids=result.rows
      .slice(0,limit)
      .map(r=>String(r.id))
      .reverse();

    const messages=await loadMessengerMessages(
      ids,
      request.user.id
    );

    response.json({
      messages,
      nextBefore:hasMore&&ids.length?ids[0]:null
    });
  }catch(error){console.error('Messenger messages failed:',error.message);response.status(500).json({error:'Could not load conversation.'});}
});

app.get('/api/messaging/conversations/:conversationId/media', requireApiAuth, async (request,response)=>{
  const cid=request.params.conversationId;if(!validNumericId(cid))return response.status(400).json({error:'Invalid conversation.'});
  try{
    await ensureDatabase();if(!(await messengerRequireMember(cid,request.user.id)))return response.status(403).json({error:'Conversation unavailable.'});
    const result=await pool.query(`SELECT DISTINCT m.id FROM messenger_messages m JOIN messenger_attachments a ON a.message_id=m.id
      WHERE m.conversation_id=$1 AND m.deleted_at IS NULL AND m.message_type IN ('image','video')
      AND LOWER(COALESCE(a.file_name,'')) NOT LIKE 'sticker-%'
      AND NOT EXISTS(SELECT 1 FROM messenger_message_hides h WHERE h.message_id=m.id AND h.user_id=$2)
      ORDER BY m.id DESC LIMIT 30`,[cid,request.user.id]);
    const ids=result.rows.map(row=>String(row.id));
    response.json({messages:await loadMessengerMessages(ids,request.user.id)});
  }catch(error){console.error('Messenger shared media failed:',error.message);response.status(500).json({error:'Could not load shared media.'});}
});

app.post('/api/messaging/conversations/:conversationId/messages', requireApiAuth, async (request,response)=>{
  const cid=request.params.conversationId;
  if(!validNumericId(cid))return response.status(400).json({error:'Invalid conversation.'});

  try{
    await ensureDatabase();

    const [isMember,isBlocked]=await Promise.all([
      messengerRequireMember(cid,request.user.id),
      messengerConversationBlocked(cid)
    ]);

    if(!isMember)
      return response.status(403).json({error:'Conversation unavailable.'});

    if(isBlocked)
      return response.status(403).json({
        error:'Messaging is unavailable because this conversation is blocked.'
      });

    const body=String(request.body?.body||'').trim().slice(0,8000);
    if(!body)return response.status(400).json({error:'Write a message.'});

    const clientId=String(
      request.body?.clientId||crypto.randomUUID()
    ).slice(0,96);

    const replyTo=validNumericId(request.body?.replyToId)
      ?String(request.body.replyToId)
      :null;

    if(replyTo){
      const ok=await pool.query(
        'SELECT 1 FROM messenger_messages WHERE id=$1 AND conversation_id=$2',
        [replyTo,cid]
      );

      if(!ok.rowCount)
        return response.status(400).json({
          error:'Reply target is unavailable.'
        });
    }

    let inserted=await pool.query(`
      INSERT INTO messenger_messages(
        conversation_id,
        sender_id,
        client_id,
        message_type,
        body,
        reply_to_id
      )
      VALUES($1,$2,$3,'text',$4,$5)
      ON CONFLICT(sender_id,client_id)
      DO NOTHING
      RETURNING id
    `,[cid,request.user.id,clientId,body,replyTo]);

    if(!inserted.rowCount){
      inserted=await pool.query(
        'SELECT id FROM messenger_messages WHERE sender_id=$1 AND client_id=$2 LIMIT 1',
        [request.user.id,clientId]
      );
    }

    const message=await messengerFinalizeMessage(
      inserted.rows[0].id,
      cid,
      request.user.id,
      true
    );

    response.json({message});

  }catch(error){
    console.error('Messenger send failed:',error.message);
    response.status(500).json({error:'Could not send message.'});
  }
});

app.post('/api/messaging/conversations/:conversationId/share', requireApiAuth, async (request,response)=>{
  const cid=request.params.conversationId,contentType=String(request.body?.contentType||'').toLowerCase(),contentId=String(request.body?.contentId||'');
  if(!validNumericId(cid))return response.status(400).json({error:'Invalid conversation.'});
  if(!['reel','post'].includes(contentType)||!validNumericId(contentId))return response.status(400).json({error:'Choose a valid Reel or post.'});
  try{
    await ensureDatabase();if(!(await messengerRequireMember(cid,request.user.id)))return response.status(403).json({error:'Conversation unavailable.'});if(await messengerConversationBlocked(cid))return response.status(403).json({error:'Messaging is unavailable because this conversation is blocked.'});
    const shared=await messengerSharedContent(contentType,contentId,request.user.id);if(!shared)return response.status(404).json({error:`This ${contentType} is unavailable.`});
    const clientId=String(request.body?.clientId||crypto.randomUUID()).slice(0,96),messageType=contentType==='reel'?'shared_reel':'shared_post';
    let inserted=await pool.query(`INSERT INTO messenger_messages(conversation_id,sender_id,client_id,message_type,body) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(sender_id,client_id) DO NOTHING RETURNING id`,[cid,request.user.id,clientId,messageType,contentId]);
    if(!inserted.rowCount)inserted=await pool.query('SELECT id FROM messenger_messages WHERE sender_id=$1 AND client_id=$2 LIMIT 1',[request.user.id,clientId]);
    try{
      if(contentType==='reel')await pool.query(`INSERT INTO reel_shares(reel_id,user_id,shared_at) VALUES($1,$2,NOW()) ON CONFLICT(reel_id,user_id) DO UPDATE SET shared_at=EXCLUDED.shared_at`,[contentId,request.user.id]);
      else await pool.query(`INSERT INTO post_shares(post_id,user_id,shared_at) VALUES($1,$2,NOW()) ON CONFLICT(post_id,user_id) DO UPDATE SET shared_at=EXCLUDED.shared_at`,[contentId,request.user.id]);
    }catch(metricError){console.warn('Messenger share counter update skipped:',metricError.message);}
    const message=await messengerFinalizeMessage(inserted.rows[0].id,cid,request.user.id);response.json({message,sharedContent:shared});
  }catch(error){console.error('Messenger content share failed:',error.message);response.status(500).json({error:'Could not share to this chat.'});}
});

app.get('/api/messaging/shared/posts/:postId/preview', requireApiAuth, async (request,response)=>{
  const postId=request.params.postId;if(!validNumericId(postId))return response.status(400).end();
  try{
    await ensureDatabase();if(!(await messengerSharedContent('post',postId,request.user.id)))return response.status(404).end();
    const result=await pool.query('SELECT image_data,media_items FROM posts WHERE id=$1 LIMIT 1',[postId]),row=result.rows[0];if(!row)return response.status(404).end();
    const media=normalizeStoredPostMedia(row.media_items,row.image_data||''),first=media[0];if(!first)return response.status(404).end();
    if(first.type==='video'){
      const reel=await pool.query('SELECT id FROM reels WHERE source_post_id=$1 AND source_media_index=0 ORDER BY id DESC LIMIT 1',[postId]);
      if(!reel.rowCount)return response.status(404).end();return response.redirect(302,reelThumbnailUrl(reel.rows[0].id));
    }
    const decoded=dataUrlBuffer(first.data,'image');if(!decoded)return response.status(404).end();
    response.setHeader('Cache-Control','private, max-age=86400');response.type(decoded.mimeType).send(decoded.bytes);
  }catch(error){console.error('Shared post preview failed:',error.message);response.status(500).end();}
});

app.post('/api/messaging/media-preview', requireApiAuth, express.raw({type:['application/octet-stream','multipart/form-data'],limit:'55mb'}), async (request,response)=>{
  const rawBody=Buffer.isBuffer(request.body)?request.body:Buffer.alloc(0),contentType=String(request.headers['content-type']||'');
  let bytes=rawBody,partMime='';
  if(/^multipart\/form-data/i.test(contentType)){
    const boundaryMatch=/boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType),boundary=String(boundaryMatch?.[1]||boundaryMatch?.[2]||'').trim();
    if(boundary){
      const headerEnd=rawBody.indexOf(Buffer.from('\r\n\r\n')),endMarker=Buffer.from(`\r\n--${boundary}`);
      if(headerEnd>=0){
        const headers=rawBody.subarray(0,headerEnd).toString('utf8'),end=rawBody.indexOf(endMarker,headerEnd+4),mimeMatch=/content-type:\s*([^\r\n]+)/i.exec(headers);
        if(end>headerEnd){bytes=rawBody.subarray(headerEnd+4,end);partMime=String(mimeMatch?.[1]||'').trim().toLowerCase();}
      }
    }
  }
  if(!bytes.length)return response.status(400).json({error:'Choose a photo or video.'});
  const requestedMime=String(request.headers['x-file-type']||partMime||'').toLowerCase().split(';')[0].trim();
  const mime=/^(image|video)\/[a-z0-9.+-]+$/.test(requestedMime)?requestedMime:'application/octet-stream';
  if(mime==='application/octet-stream')return response.status(415).json({error:'Choose a supported photo or video.'});
  const sendPreview=(payload,type,kind)=>{
    response.setHeader('Content-Type',type);
    response.setHeader('X-Preview-Kind',kind||(/video\//.test(type)?'video':'image'));
    response.setHeader('Content-Length',String(payload.length));
    response.setHeader('Content-Disposition','inline');
    response.setHeader('Cache-Control','private, no-store, max-age=0');
    response.setHeader('X-Content-Type-Options','nosniff');
    response.send(payload);
  };
  if(/^image\/(jpeg|png|webp|gif)$/.test(mime))return sendPreview(bytes,mime,'image');
  let directory='';
  try{
    directory=await fs.promises.mkdtemp(path.join(os.tmpdir(),'facebook-message-preview-'));
    const input=path.join(directory,'selected-media'),isVideo=mime.startsWith('video/'),output=path.join(directory,'preview.jpg');
    await fs.promises.writeFile(input,bytes);
    if(isVideo){
      /* Popular messaging clients show a poster while the original video is
         uploaded. Extracting one frame is much faster and more compatible
         than transcoding a temporary preview clip. */
      await runProcess(ffmpegBinary(),['-hide_banner','-loglevel','error','-y','-i',input,'-map','0:v:0','-frames:v','1','-vf',"scale=w='min(1080,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",'-q:v','4',output]);
    }else{
      await runProcess(ffmpegBinary(),['-hide_banner','-loglevel','error','-y','-i',input,'-frames:v','1','-vf',"scale=w='min(1600,iw)':h='min(1600,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",'-q:v','3',output]);
    }
    const normalized=await fs.promises.readFile(output);
    sendPreview(normalized,'image/jpeg','image');
  }catch(error){
    console.warn('Messenger preview normalization failed:',error.message);
    response.status(422).json({error:'This media format could not be decoded.'});
  }finally{
    if(directory)fs.promises.rm(directory,{recursive:true,force:true}).catch(()=>{});
  }
});

app.post('/api/messaging/conversations/:conversationId/attachment', requireApiAuth, express.raw({type:['application/octet-stream','multipart/form-data'],limit:'27mb'}), async (request,response)=>{
  const cid=request.params.conversationId; if(!validNumericId(cid))return response.status(400).json({error:'Invalid conversation.'});
  try{
    await ensureDatabase(); if(!(await messengerRequireMember(cid,request.user.id)))return response.status(403).json({error:'Conversation unavailable.'});if(await messengerConversationBlocked(cid))return response.status(403).json({error:'Messaging is unavailable because this conversation is blocked.'});
    const rawBody=Buffer.isBuffer(request.body)?request.body:Buffer.alloc(0),contentType=String(request.headers['content-type']||'');let bytes=rawBody;
    if(/^multipart\/form-data/i.test(contentType)){
      const boundaryMatch=/boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType),boundary=String(boundaryMatch?.[1]||boundaryMatch?.[2]||'').trim(),headerEnd=rawBody.indexOf(Buffer.from('\r\n\r\n'));
      if(boundary&&headerEnd>=0){const end=rawBody.indexOf(Buffer.from(`\r\n--${boundary}`),headerEnd+4);if(end>headerEnd)bytes=rawBody.subarray(headerEnd+4,end);}
    }
    if(!bytes.length)return response.status(400).json({error:'Choose a file.'}); if(bytes.length>25*1024*1024)return response.status(413).json({error:'File must be 25 MB or smaller.'});
    let mime=String(request.headers['x-file-type']||'application/octet-stream').slice(0,160); const fileName=decodeURIComponent(String(request.headers['x-file-name']||'attachment')).slice(0,255); const caption=decodeURIComponent(String(request.headers['x-caption']||'')).slice(0,2000);
    const clientId=String(request.headers['x-client-id']||crypto.randomUUID()).slice(0,96); const replyTo=validNumericId(request.headers['x-reply-to-id'])?String(request.headers['x-reply-to-id']):null;
    let kind='file'; if(mime.startsWith('image/'))kind='image'; else if(mime.startsWith('video/'))kind='video'; else if(mime.startsWith('audio/'))kind='audio';
    const inserted=await pool.query(`INSERT INTO messenger_messages(conversation_id,sender_id,client_id,message_type,body,reply_to_id) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(sender_id,client_id) DO UPDATE SET client_id=EXCLUDED.client_id RETURNING id`,[cid,request.user.id,clientId,kind,caption,replyTo]);
    const messageId=inserted.rows[0].id; const exists=await pool.query('SELECT 1 FROM messenger_attachments WHERE message_id=$1 LIMIT 1',[messageId]);
    if(!exists.rowCount)await pool.query(`INSERT INTO messenger_attachments(message_id,uploader_id,file_name,mime_type,byte_size,file_data) VALUES($1,$2,$3,$4,$5,$6)`,[messageId,request.user.id,fileName,mime,bytes.length,bytes]);
    const message=await messengerFinalizeMessage(messageId,cid,request.user.id); response.json({message});
  }catch(error){console.error('Messenger attachment failed:',error.message);response.status(500).json({error:'Could not send attachment.'});}
});

app.get('/api/messaging/attachments/:attachmentId', requireApiAuth, async (request,response)=>{
  const id=request.params.attachmentId;if(!validNumericId(id))return response.status(400).end();
  try{
    await ensureDatabase(); const result=await pool.query(`SELECT a.file_name,a.mime_type,a.byte_size,a.file_data,m.conversation_id FROM messenger_attachments a JOIN messenger_messages m ON m.id=a.message_id WHERE a.id=$1 LIMIT 1`,[id]);
    if(!result.rowCount)return response.status(404).end(); const row=result.rows[0]; if(!(await messengerRequireMember(row.conversation_id,request.user.id)))return response.status(403).end();
    const data=Buffer.isBuffer(row.file_data)?row.file_data:Buffer.from(row.file_data||[]),total=data.length,range=String(request.headers.range||'');
    const etag='"msg-'+id+'-'+total+'"'; response.setHeader('ETag',etag); response.setHeader('Cache-Control','private, max-age=86400'); response.setHeader('Accept-Ranges','bytes');
    response.setHeader('Content-Type',row.mime_type||'application/octet-stream'); response.setHeader('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(row.file_name||'attachment')}`);
    if(!range&&request.headers['if-none-match']===etag)return response.status(304).end();
    if(range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(range.trim());let start=0,end=total-1;
      if(!match||!total){response.status(416);response.setHeader('Content-Range',`bytes */${total}`);return response.end();}
      if(match[1])start=Number(match[1]);else if(match[2])start=Math.max(0,total-Number(match[2]));
      if(match[2]&&match[1])end=Number(match[2]);
      end=Math.min(end,total-1);
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>end||start>=total){response.status(416);response.setHeader('Content-Range',`bytes */${total}`);return response.end();}
      response.status(206);response.setHeader('Content-Range',`bytes ${start}-${end}/${total}`);response.setHeader('Content-Length',String(end-start+1));return response.send(data.subarray(start,end+1));
    }
    response.setHeader('Content-Length',String(total)); response.send(data);
  }catch(error){console.error('Messenger attachment read failed:',error.message);response.status(500).end();}
});

app.patch('/api/messaging/messages/:messageId', requireApiAuth, async (request,response)=>{
  const id=request.params.messageId;if(!validNumericId(id))return response.status(400).json({error:'Invalid message.'});
  try{await ensureDatabase();const body=String(request.body?.body||'').trim().slice(0,8000);if(!body)return response.status(400).json({error:'Message cannot be empty.'});
    const result=await pool.query(`UPDATE messenger_messages SET body=$1,edited_at=NOW() WHERE id=$2 AND sender_id=$3 AND deleted_at IS NULL RETURNING conversation_id`,[body,id,request.user.id]);if(!result.rowCount)return response.status(404).json({error:'Message unavailable.'});
    const msg=await loadMessengerMessage(id,request.user.id);await messengerTouchConversation(result.rows[0].conversation_id);await messengerBroadcastPersonalizedMessage(result.rows[0].conversation_id,'message_update',id);response.json({message:msg});
  }catch(error){console.error('Messenger edit failed:',error.message);response.status(500).json({error:'Could not edit message.'});}
});

app.delete('/api/messaging/messages/:messageId', requireApiAuth, async (request,response)=>{
  const id=request.params.messageId;if(!validNumericId(id))return response.status(400).json({error:'Invalid message.'});
  try{await ensureDatabase();const scope=String(request.query.scope||'everyone');
    const item=await pool.query('SELECT conversation_id,sender_id FROM messenger_messages WHERE id=$1 LIMIT 1',[id]);if(!item.rowCount)return response.status(404).json({error:'Message unavailable.'});const row=item.rows[0];if(!(await messengerRequireMember(row.conversation_id,request.user.id)))return response.status(403).json({error:'Message unavailable.'});
    if(scope==='me'){await pool.query('INSERT INTO messenger_message_hides(message_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,request.user.id]);messengerSendToUser(request.user.id,{type:'message_hidden',messageId:String(id),conversationId:String(row.conversation_id)});return response.json({ok:true});}
    if(String(row.sender_id)!==String(request.user.id))return response.status(403).json({error:'You can only unsend your own message.'});
    await pool.query('DELETE FROM messenger_messages WHERE id=$1',[id]);await messengerTouchConversation(row.conversation_id);await messengerBroadcastConversation(row.conversation_id,{type:'message_hidden',messageId:String(id),conversationId:String(row.conversation_id)});response.json({ok:true,messageId:String(id)});
  }catch(error){console.error('Messenger delete failed:',error.message);response.status(500).json({error:'Could not delete message.'});}
});

app.post('/api/messaging/messages/:messageId/reaction', requireApiAuth, async (request,response)=>{
  const id=request.params.messageId;if(!validNumericId(id))return response.status(400).json({error:'Invalid message.'});
  try{await ensureDatabase();const item=await pool.query('SELECT conversation_id FROM messenger_messages WHERE id=$1 LIMIT 1',[id]);if(!item.rowCount||!(await messengerRequireMember(item.rows[0].conversation_id,request.user.id)))return response.status(404).json({error:'Message unavailable.'});const emoji=String(request.body?.emoji||'').slice(0,24);
    if(!emoji)await pool.query('DELETE FROM messenger_message_reactions WHERE message_id=$1 AND user_id=$2',[id,request.user.id]);else await pool.query(`INSERT INTO messenger_message_reactions(message_id,user_id,emoji) VALUES($1,$2,$3) ON CONFLICT(message_id,user_id) DO UPDATE SET emoji=EXCLUDED.emoji,created_at=NOW()`,[id,request.user.id,emoji]);
    const msg=await loadMessengerMessage(id,request.user.id);await messengerBroadcastPersonalizedMessage(item.rows[0].conversation_id,'message_update',id);response.json({message:msg});
  }catch(error){console.error('Messenger reaction failed:',error.message);response.status(500).json({error:'Could not react.'});}
});

app.post('/api/messaging/messages/:messageId/forward', requireApiAuth, async (request,response)=>{
  const sourceId=request.params.messageId;
  const targetId=String(request.body?.conversationId||'');
  if(!validNumericId(sourceId)||!validNumericId(targetId))return response.status(400).json({error:'Invalid forward request.'});
  const client=await pool.connect();
  try{
    await ensureDatabase();
    if(!(await messengerRequireMember(targetId,request.user.id)))return response.status(403).json({error:'Destination unavailable.'});
    const source=await client.query(`SELECT m.* FROM messenger_messages m
      JOIN messenger_conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=$2
      WHERE m.id=$1 AND m.deleted_at IS NULL LIMIT 1`,[sourceId,request.user.id]);
    if(!source.rowCount)return response.status(404).json({error:'Message unavailable.'});
    const item=source.rows[0];
    await client.query('BEGIN');
    const inserted=await client.query(`INSERT INTO messenger_messages
      (conversation_id,sender_id,client_id,message_type,body,forwarded_from_id)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[targetId,request.user.id,crypto.randomUUID(),item.message_type,item.body,sourceId]);
    const messageId=inserted.rows[0].id;
    await client.query(`INSERT INTO messenger_attachments(message_id,uploader_id,file_name,mime_type,byte_size,file_data)
      SELECT $1,$2,file_name,mime_type,byte_size,file_data FROM messenger_attachments WHERE message_id=$3`,[messageId,request.user.id,sourceId]);
    await client.query('COMMIT');
    const message=await messengerFinalizeMessage(messageId,targetId,request.user.id);
    response.json({message});
  }catch(error){
    try{await client.query('ROLLBACK');}catch(_error){}
    console.error('Messenger forward failed:',error.message);
    response.status(500).json({error:'Could not forward message.'});
  }finally{client.release();}
});

app.post('/api/messaging/conversations/:conversationId/read', requireApiAuth, async (request,response)=>{
  const cid=request.params.conversationId;if(!validNumericId(cid))return response.status(400).json({error:'Invalid conversation.'});
  try{await ensureDatabase();if(!(await messengerRequireMember(cid,request.user.id)))return response.status(403).json({error:'Conversation unavailable.'});const requested=validNumericId(request.body?.messageId)?String(request.body.messageId):null;
    const maxResult=requested?{rows:[{id:requested}],rowCount:1}:await pool.query('SELECT id FROM messenger_messages WHERE conversation_id=$1 ORDER BY id DESC LIMIT 1',[cid]);if(!maxResult.rowCount)return response.json({ok:true});const maxId=maxResult.rows[0].id;
    const updated=await pool.query(`UPDATE messenger_message_receipts rr SET delivered_at=COALESCE(delivered_at,NOW()),read_at=COALESCE(read_at,NOW()) FROM messenger_messages m WHERE rr.message_id=m.id AND rr.user_id=$1 AND m.conversation_id=$2 AND m.id<=$3 RETURNING rr.message_id`,[request.user.id,cid,maxId]);
    await pool.query(`UPDATE messenger_conversation_members SET last_read_message_id=$1,last_read_at=NOW() WHERE conversation_id=$2 AND user_id=$3`,[maxId,cid,request.user.id]);
    await messengerBroadcastConversation(cid,{type:'read',conversationId:String(cid),userId:String(request.user.id),messageId:String(maxId),readAt:new Date().toISOString()},request.user.id);
    response.json({ok:true,count:updated.rowCount});
  }catch(error){console.error('Messenger read failed:',error.message);response.status(500).json({error:'Could not update read status.'});}
});

app.patch('/api/messaging/conversations/:conversationId/settings', requireApiAuth, async (request,response)=>{
  const cid=request.params.conversationId;if(!validNumericId(cid))return response.status(400).json({error:'Invalid conversation.'});
  try{await ensureDatabase();if(!(await messengerRequireMember(cid,request.user.id)))return response.status(403).json({error:'Conversation unavailable.'});const pinned=request.body?.pinned;const archived=request.body?.archived;const muted=request.body?.muted;
    await pool.query(`UPDATE messenger_conversation_members SET pinned=COALESCE($1,pinned),archived=COALESCE($2,archived),muted_until=CASE WHEN $3::boolean IS NULL THEN muted_until WHEN $3 THEN NOW()+INTERVAL '8 hours' ELSE NULL END WHERE conversation_id=$4 AND user_id=$5`,[typeof pinned==='boolean'?pinned:null,typeof archived==='boolean'?archived:null,typeof muted==='boolean'?muted:null,cid,request.user.id]);
    const summary=await messengerConversationSummary(cid,request.user.id);response.json({conversation:summary});
  }catch(error){console.error('Messenger settings failed:',error.message);response.status(500).json({error:'Could not update conversation.'});}
});

app.get('/api/messaging/conversations/:conversationId/details', requireApiAuth, async (request,response)=>{
  const cid=request.params.conversationId;if(!validNumericId(cid))return response.status(400).json({error:'Invalid conversation.'});
  try{await ensureDatabase();if(!(await messengerRequireMember(cid,request.user.id)))return response.status(403).json({error:'Conversation unavailable.'});const conversation=await messengerConversationSummary(cid,request.user.id);response.json({conversation});}
  catch(error){console.error('Messenger details failed:',error.message);response.status(500).json({error:'Could not load conversation details.'});}
});

app.patch('/api/messaging/conversations/:conversationId/group', requireApiAuth, async (request,response)=>{
  const cid=request.params.conversationId;if(!validNumericId(cid))return response.status(400).json({error:'Invalid group.'});
  try{await ensureDatabase();const member=await pool.query(`SELECT c.title,c.group_image FROM messenger_conversations c JOIN messenger_conversation_members cm ON cm.conversation_id=c.id WHERE c.id=$1 AND c.conversation_type='group' AND cm.user_id=$2`,[cid,request.user.id]);if(!member.rowCount)return response.status(403).json({error:'This group is unavailable.'});const title=String(request.body?.title||'').trim().slice(0,160);if(!title)return response.status(400).json({error:'Enter a group name.'});const image=String(request.body?.image||'');if(image&&(!/^data:image\/(?:png|jpeg|webp);base64,/i.test(image)||image.length>180000))return response.status(400).json({error:'Choose a smaller image.'});const titleChanged=title!==String(member.rows[0].title||''),imageChanged=Boolean(image&&image!==String(member.rows[0].group_image||''));await pool.query(`UPDATE messenger_conversations SET title=$1,named_by=$2,group_image=CASE WHEN $3='' THEN group_image ELSE $3 END,updated_at=NOW() WHERE id=$4`,[title,request.user.id,image,cid]);if(titleChanged||imageChanged){const actor=await pool.query(`SELECT COALESCE(NULLIF(BTRIM(full_name),''),'Facebook user') AS name FROM users WHERE id=$1`,[request.user.id]),name=actor.rows[0]?.name||'Facebook user',updates=[];if(titleChanged)updates.push(`${name} changed the group name to “${title}”.`);if(imageChanged)updates.push(`${name} changed the group photo.`);for(const body of updates){const inserted=await pool.query(`INSERT INTO messenger_messages(conversation_id,sender_id,client_id,message_type,body) VALUES($1,$2,$3,'system',$4) RETURNING id`,[cid,request.user.id,crypto.randomUUID(),body]);await messengerCreateReceipts(inserted.rows[0].id,cid,request.user.id);await messengerBroadcastPersonalizedMessage(cid,'message',inserted.rows[0].id);}}await messengerBroadcastConversationSummaries(cid);const conversation=await messengerConversationSummary(cid,request.user.id);response.json({conversation});}
  catch(error){console.error('Messenger group update failed:',error.message);response.status(500).json({error:'Could not update the group.'});}
});

app.post('/api/messaging/conversations/:conversationId/members', requireApiAuth, async (request,response)=>{
  const cid=request.params.conversationId,target=String(request.body?.userId||'');if(!validNumericId(cid)||!validNumericId(target))return response.status(400).json({error:'Choose a valid person.'});
  try{await ensureDatabase();const admin=await pool.query(`SELECT 1 FROM messenger_conversations c JOIN messenger_conversation_members cm ON cm.conversation_id=c.id WHERE c.id=$1 AND c.conversation_type='group' AND cm.user_id=$2 AND cm.role='admin'`,[cid,request.user.id]);if(!admin.rowCount)return response.status(403).json({error:'Only an admin can add people.'});await pool.query(`INSERT INTO messenger_conversation_members(conversation_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT DO NOTHING`,[cid,target]);await pool.query(`UPDATE messenger_conversations SET updated_at=NOW() WHERE id=$1`,[cid]);await messengerBroadcastConversationSummaries(cid);const conversation=await messengerConversationSummary(cid,request.user.id);response.json({conversation});}
  catch(error){console.error('Messenger add group member failed:',error.message);response.status(500).json({error:'Could not add this person.'});}
});

app.patch('/api/messaging/conversations/:conversationId/theme', requireApiAuth, async (request,response)=>{
  const cid=request.params.conversationId;if(!validNumericId(cid))return response.status(400).json({error:'Invalid conversation.'});
  const allowed=new Set(['default','instagram','instagram-classic','love','ocean','sunset','monochrome','glow-pup','odyssey','supergirl','avatar','olivia','backrooms','deli-boys','heart-drive','valentines']);const theme=String(request.body?.theme||'default').toLowerCase();if(!allowed.has(theme))return response.status(400).json({error:'Choose a valid theme.'});
  try{await ensureDatabase();if(!(await messengerRequireMember(cid,request.user.id)))return response.status(403).json({error:'Conversation unavailable.'});await pool.query('UPDATE messenger_conversations SET theme_key=$1,updated_at=NOW() WHERE id=$2',[theme,cid]);const labels={'default':'Messenger Blue','instagram':'Midnight Purple','instagram-classic':'Rainbow Gradient','love':'Berry Pink','ocean':'Aqua Blue','sunset':'Tangerine','monochrome':'Graphite','glow-pup':'Electric Violet','odyssey':'Deep Teal','supergirl':'Ember Gold','avatar':'Forest Sage','olivia':'Rose Blush','backrooms':'Olive Gold','deli-boys':'Warm Sand','heart-drive':'Moonlit Lilac','valentines':'Royal Magenta'},actor=await pool.query(`SELECT COALESCE(NULLIF(BTRIM(full_name),''),'Facebook user') AS name FROM users WHERE id=$1`,[request.user.id]),body=`${actor.rows[0]?.name||'Facebook user'} changed the theme to ${labels[theme]}.`,inserted=await pool.query(`INSERT INTO messenger_messages(conversation_id,sender_id,client_id,message_type,body) VALUES($1,$2,$3,'system',$4) RETURNING id`,[cid,request.user.id,crypto.randomUUID(),body]);await messengerCreateReceipts(inserted.rows[0].id,cid,request.user.id);await messengerBroadcastPersonalizedMessage(cid,'message',inserted.rows[0].id);await messengerBroadcastConversationSummaries(cid);const conversation=await messengerConversationSummary(cid,request.user.id);response.json({conversation});}
  catch(error){console.error('Messenger theme failed:',error.message);response.status(500).json({error:'Could not change the theme.'});}
});

app.patch('/api/messaging/conversations/:conversationId/nicknames/:userId', requireApiAuth, async (request,response)=>{
  const cid=request.params.conversationId,target=String(request.params.userId||'');if(!validNumericId(cid)||!validNumericId(target))return response.status(400).json({error:'Invalid nickname request.'});
  try{await ensureDatabase();if(!(await messengerRequireMember(cid,request.user.id))||!(await messengerRequireMember(cid,target)))return response.status(403).json({error:'Conversation unavailable.'});const nickname=String(request.body?.nickname||'').trim().slice(0,80);if(nickname)await pool.query(`INSERT INTO messenger_conversation_nicknames(conversation_id,user_id,nickname,updated_by) VALUES($1,$2,$3,$4) ON CONFLICT(conversation_id,user_id) DO UPDATE SET nickname=EXCLUDED.nickname,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,[cid,target,nickname,request.user.id]);else await pool.query('DELETE FROM messenger_conversation_nicknames WHERE conversation_id=$1 AND user_id=$2',[cid,target]);await messengerBroadcastConversationSummaries(cid);const conversation=await messengerConversationSummary(cid,request.user.id);response.json({conversation});}
  catch(error){console.error('Messenger nickname failed:',error.message);response.status(500).json({error:'Could not update the nickname.'});}
});

app.post('/api/messaging/conversations/:conversationId/block', requireApiAuth, async (request,response)=>{
  const cid=request.params.conversationId;if(!validNumericId(cid))return response.status(400).json({error:'Invalid conversation.'});
  try{await ensureDatabase();if(!(await messengerRequireMember(cid,request.user.id)))return response.status(403).json({error:'Conversation unavailable.'});const target=await pool.query(`SELECT cm.user_id FROM messenger_conversations c JOIN messenger_conversation_members cm ON cm.conversation_id=c.id WHERE c.id=$1 AND c.conversation_type='direct' AND cm.user_id<>$2 LIMIT 1`,[cid,request.user.id]);if(!target.rowCount)return response.status(400).json({error:'Only direct conversations can be blocked.'});const blocked=request.body?.blocked!==false;if(blocked)await pool.query('INSERT INTO messenger_user_blocks(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[request.user.id,target.rows[0].user_id]);else await pool.query('DELETE FROM messenger_user_blocks WHERE blocker_id=$1 AND blocked_id=$2',[request.user.id,target.rows[0].user_id]);await messengerBroadcastConversationSummaries(cid);const conversation=await messengerConversationSummary(cid,request.user.id);response.json({conversation,blocked});}
  catch(error){console.error('Messenger block failed:',error.message);response.status(500).json({error:'Could not block this person.'});}
});

app.delete('/api/messaging/conversations/:conversationId/leave', requireApiAuth, async (request,response)=>{
  const cid=request.params.conversationId;if(!validNumericId(cid))return response.status(400).json({error:'Invalid conversation.'});
  try{await ensureDatabase();const found=await pool.query(`SELECT c.conversation_type FROM messenger_conversations c JOIN messenger_conversation_members cm ON cm.conversation_id=c.id WHERE c.id=$1 AND cm.user_id=$2 LIMIT 1`,[cid,request.user.id]);if(!found.rowCount)return response.status(404).json({error:'Conversation unavailable.'});if(found.rows[0].conversation_type!=='group')return response.status(400).json({error:'Only group chats can be left.'});await pool.query('DELETE FROM messenger_conversation_members WHERE conversation_id=$1 AND user_id=$2',[cid,request.user.id]);await messengerBroadcastConversationSummaries(cid);response.json({ok:true,conversationId:String(cid)});}
  catch(error){console.error('Messenger leave failed:',error.message);response.status(500).json({error:'Could not leave this group.'});}
});

app.get('/api/messaging/search', requireApiAuth, async (request,response)=>{
  try{await ensureDatabase();const q=String(request.query.q||'').trim().slice(0,120);if(!q)return response.json({results:[]});const cid=validNumericId(request.query.conversationId)?String(request.query.conversationId):null;const values=[request.user.id,`%${q}%`];let extra='';if(cid){values.push(cid);extra=' AND m.conversation_id=$3';}
    const result=await pool.query(`SELECT m.id FROM messenger_messages m JOIN messenger_conversation_members cm ON cm.conversation_id=m.conversation_id AND cm.user_id=$1 WHERE m.deleted_at IS NULL AND m.message_type<>'system' AND m.body ILIKE $2 ${extra} ORDER BY m.id DESC LIMIT 50`,values);const messages=await loadMessengerMessages(result.rows.map(row=>row.id),request.user.id);response.json({results:messages});
  }catch(error){console.error('Messenger search failed:',error.message);response.status(500).json({error:'Could not search messages.'});}
});

async function setupMessengerWebSocket(server) {
  const wss=new WebSocketServer({noServer:true,maxPayload:64*1024});
  server.on('upgrade',(request,socket,head)=>{
    let pathname='';try{pathname=new URL(request.url,'http://localhost').pathname;}catch(_error){}
    if(pathname!=='/ws/messenger')return;
    (async()=>{try{const session=readSession(request);if(!session||!(await serverSessionAllowed(session,request))){socket.destroy();return;}await ensureDatabase();wss.handleUpgrade(request,socket,head,ws=>{ws.facebookUser=session;wss.emit('connection',ws,request);});}catch(_error){socket.destroy();}})();
  });
  wss.on('connection',async ws=>{
    const userId=String(ws.facebookUser.id);ws.isAlive=true;messengerSocketSet(userId).add(ws);
    try{await pool.query('UPDATE users SET last_seen_at=NOW() WHERE id=$1',[userId]);await pool.query(`UPDATE messenger_message_receipts SET delivered_at=COALESCE(delivered_at,NOW()) WHERE user_id=$1 AND delivered_at IS NULL`,[userId]);}catch(_error){}
    ws.send(JSON.stringify({type:'ready',userId,serverTime:new Date().toISOString()}));
    try{const peers=await pool.query(`SELECT DISTINCT cm2.user_id FROM messenger_conversation_members cm1 JOIN messenger_conversation_members cm2 ON cm2.conversation_id=cm1.conversation_id WHERE cm1.user_id=$1 AND cm2.user_id<>$1`,[userId]);for(const p of peers.rows)messengerSendToUser(p.user_id,{type:'presence',userId,online:true});}catch(_error){}
    ws.on('pong',()=>{ws.isAlive=true;});
    ws.on('message',async raw=>{let data;try{data=JSON.parse(String(raw));}catch(_error){return;}if(data.type==='typing'&&validNumericId(data.conversationId)){
      const key=`${userId}:${data.conversationId}`;const now=Date.now();if(now-(messengerTypingLast.get(key)||0)<350&&data.active)return;messengerTypingLast.set(key,now);try{if(await messengerRequireMember(data.conversationId,userId))await messengerBroadcastConversation(data.conversationId,{type:'typing',conversationId:String(data.conversationId),userId,active:Boolean(data.active)},userId);}catch(_error){}
    }});
    ws.on('close',async()=>{const set=messengerSocketsByUser.get(userId);if(set){set.delete(ws);if(!set.size)messengerSocketsByUser.delete(userId);}if(!messengerUserOnline(userId)){try{await pool.query('UPDATE users SET last_seen_at=NOW() WHERE id=$1',[userId]);const peers=await pool.query(`SELECT DISTINCT cm2.user_id FROM messenger_conversation_members cm1 JOIN messenger_conversation_members cm2 ON cm2.conversation_id=cm1.conversation_id WHERE cm1.user_id=$1 AND cm2.user_id<>$1`,[userId]);for(const p of peers.rows)messengerSendToUser(p.user_id,{type:'presence',userId,online:false,lastSeenAt:new Date().toISOString()});}catch(_error){}}});
  });
  const timer=setInterval(()=>{for(const ws of wss.clients){if(ws.isAlive===false){ws.terminate();continue;}ws.isAlive=false;try{ws.ping();}catch(_error){}}},25000);timer.unref?.();
  return wss;
}
/* =================== End Messenger V85 =================== */

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

app.get('/messenger.js', requireAuth, (_request, response) => {
  response.setHeader('Cache-Control', 'private, no-cache, must-revalidate');
  response.type('application/javascript').sendFile(path.join(publicDirectory, 'messenger.js'));
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
  if (!server.__messengerSocketReady) { server.__messengerSocketReady = true; setupMessengerWebSocket(server).catch(error => console.error('Messenger WebSocket setup failed:', error.message)); }
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
