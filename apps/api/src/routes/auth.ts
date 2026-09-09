import { Router } from "express";
import { z } from "zod";
import argon2 from "argon2";
import { db } from "../prisma/db";

const router = Router();

const signupSchema = z.object({
  username: z.string().trim().min(3).max(30),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
});

router.post("/signup", async (req, res) => {
  try {
    const result = signupSchema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: "Invalid input",
        details: result.error.issues,
      });
    }

    const { username, email, password } = result.data;

    const existingUsername = await db.orm.auth.User.where((u) =>
      u.username.eq(username),
    ).first();

    const existingEmail = await db.orm.auth.User.where((u) =>
      u.email.eq(email),
    ).first();

    if (existingUsername || existingEmail) {
      return res.status(409).json({
        error: "Username or email already exists",
      });
    }

    const passwordHash = await argon2.hash(password);

    const user = await db.orm.auth.User.create({
      username,
      email,
      passwordHash,
    });

    return res.status(201).json({
      message: "Account created successfully",
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
    });
  } catch (error) {
    console.error("Signup error:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
});

export default router;