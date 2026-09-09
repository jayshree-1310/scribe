import { db } from "./db.js";

const users = await db.orm.auth.User
  .where((u) => u.username.eq("testuser"))
  .all();

console.log(users);