const fs = require("fs");
const { Pool } = require("pg");

try { require("dotenv").config(); } catch (e) {}

const code = fs.readFileSync("server.js", "utf8");
const match = code.match(/["'](postgres(?:ql)?:\/\/[^"']+)["']/);
const dbUrl = process.env.DATABASE_URL || (match ? match[1] : null);

if (!dbUrl) {
  console.error("Database connection URL not found.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: dbUrl,
  ssl: dbUrl.includes("localhost") ? false : { rejectUnauthorized: false }
});

async function reset() {
  const identifier = "0yaxya@gmail.com";
  const newPassword = "qy17yaqy";

  try {
    const res = await pool.query(
      "UPDATE users SET password_hash = $1 WHERE LOWER(TRIM(identifier)) = LOWER(TRIM($2)) RETURNING id, identifier, password_hash",
      [newPassword, identifier]
    );

    if (res.rowCount === 0) {
      console.log("No user found with identifier:", identifier);
    } else {
      console.log("Password updated successfully:", res.rows[0]);
    }
  } catch (err) {
    console.error("Database query failed:", err.message);
  } finally {
    await pool.end();
  }
}

reset();
