import { Router } from "express";
import { z } from "zod";
import argon2 from "argon2";
import { db } from "../prisma/db";
import { createHash, randomBytes } from "node:crypto";
import { createAccessToken, createRefreshToken } from "../lib/jwt";
import { connectRedis, redis } from "../lib/redis";
import jwt from "jsonwebtoken";

const router = Router();

const signupSchema = z.object({
  username: z.string().trim().min(3).max(30),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
});

const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,p=4,t=3$xNteWUCFVchT8WWZ+0XcgQ$J2wuSEHpgb09Rthx8cxqCsoxyOP821vImY7a8Knaqf4";

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

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

    if (
      error instanceof Error &&
      "sqlState" in error &&
      (error as { sqlState?: string }).sqlState === "23505"
    ) {
      return res.status(409).json({
        error: "Username or email already exists",
      });
    }

    return res.status(500).json({
      error: "Internal server error",
    });
  }
});

router.post("/login", async (req, res) => {
  try {
    const result = loginSchema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: "Invalid input",
        details: result.error.issues,
      });
    }

    const { email, password } = result.data;

    const user = await db.orm.auth.User.where((u) => u.email.eq(email)).first();

    if (!user) {
      await argon2.verify(DUMMY_PASSWORD_HASH, password);

      return res.status(401).json({
        error: "Invalid email or password",
      });
    }

    const passwordValid = await argon2.verify(user.passwordHash, password);

    if (!passwordValid) {
      return res.status(401).json({
        error: "Invalid email or password",
      });
    }

    const sessionId = randomBytes(32).toString("hex");

    const accessToken = createAccessToken(user.id);
    const refreshToken = createRefreshToken(user.id, sessionId);

    const refreshTokenHash = hashRefreshToken(refreshToken);
    await connectRedis();

    await redis.set(
      `auth:refresh:${sessionId}`,
      JSON.stringify({
        userId: user.id,
        refreshTokenHash,
      }),
      {
        EX: 7 * 24 * 60 * 60,
      },
    );

    return res.status(200).json({
      message: "Login successful",
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
      },
    });
  } catch (error) {
    console.error("Login error:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
});

router.post("/refresh", async (req, res) => {
  try {
    const result = refreshSchema.safeParse(req.body);

    if (!result.success) {
      return res.status(400).json({
        error: "Invalid input",
        details: result.error.issues,
      });
    }

    const { refreshToken } = result.data;

    let payload: jwt.JwtPayload;

    try {
      payload = jwt.verify(
        refreshToken,
        process.env.JWT_REFRESH_SECRET!,
      ) as jwt.JwtPayload;
    } catch (error) {
      console.error("Refresh JWT verification failed:", error);

      return res.status(401).json({
        error: "Invalid or expired refresh token",
      });
    }

    if (
      payload.type !== "refresh" ||
      typeof payload.sub !== "string" ||
      typeof payload.sid !== "string"
    ) {
      return res.status(401).json({
        error: "Invalid refresh token",
      });
    }

    const sessionKey = `auth:refresh:${payload.sid}`;

    const sessionData = await redis.get(sessionKey);

    if (!sessionData) {
      return res.status(401).json({
        error: "Session expired or revoked",
      });
    }

    const session = JSON.parse(sessionData) as {
      userId: string;
      refreshTokenHash: string;
    };

    if (session.userId !== payload.sub) {
      return res.status(401).json({
        error: "Invalid refresh session",
      });
    }

    const tokenValid =
      hashRefreshToken(refreshToken) === session.refreshTokenHash;

    if (!tokenValid) {
      return res.status(401).json({
        error: "Invalid refresh token",
      });
    }

    // Rotate the refresh session.
    await redis.del(sessionKey);

    const newSessionId = randomBytes(32).toString("hex");

    const accessToken = createAccessToken(session.userId);
    const newRefreshToken = createRefreshToken(session.userId, newSessionId);

    const newRefreshTokenHash = hashRefreshToken(newRefreshToken);
    await redis.set(
      `auth:refresh:${newSessionId}`,
      JSON.stringify({
        userId: session.userId,
        refreshTokenHash: newRefreshTokenHash,
      }),
      {
        EX: 7 * 24 * 60 * 60,
      },
    );

    return res.status(200).json({
      message: "Token refreshed successfully",
      accessToken,
      refreshToken: newRefreshToken,
    });
  } catch (error) {
    console.error("Refresh token error:", error);

    return res.status(500).json({
      error: "Internal server error",
    });
  }
});

export default router;
