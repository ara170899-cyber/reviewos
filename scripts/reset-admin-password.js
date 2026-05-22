const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const password = process.argv[2];
if (!password || password.length < 10) {
  console.error("Usage: npm run reset-admin -- <new-password-at-least-10-chars>");
  process.exit(1);
}

const dataDir = path.join(__dirname, "..", "data");
const usersFile = path.join(dataDir, "users.json");
fs.mkdirSync(dataDir, { recursive: true });

function readUsers() {
  try {
    return JSON.parse(fs.readFileSync(usersFile, "utf8"));
  } catch {
    return [];
  }
}

const users = Array.isArray(readUsers()) ? readUsers() : [];
let admin = users.find((user) => user.role === "admin") || users.find((user) => user.email === "admin@reviewos.ru");

if (!admin) {
  admin = {
    id: uuidv4(),
    email: "admin@reviewos.ru",
    name: "Администратор",
    role: "admin",
    plan: "unlimited",
    created_at: new Date().toISOString(),
    auto_post: false,
    cron_interval: "*/5 * * * *",
    shop_name: "ReviewOS",
  };
  users.push(admin);
}

admin.email = String(admin.email || "admin@reviewos.ru").trim().toLowerCase();
admin.name = admin.name || "Администратор";
admin.role = "admin";
admin.plan = admin.plan || "unlimited";
admin.password = bcrypt.hashSync(password, 10);

fs.writeFileSync(usersFile, JSON.stringify(users, null, 2), "utf8");
console.log(`Admin password reset for ${admin.email}`);
