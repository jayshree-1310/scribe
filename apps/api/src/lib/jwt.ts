import jwt, { type SignOptions } from "jsonwebtoken";

function getEnvSecret(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is not configured`);
  }

  return value;
}

const accessSecret = getEnvSecret("JWT_ACCESS_SECRET");
const refreshSecret = getEnvSecret("JWT_REFRESH_SECRET");

const accessExpiresIn = process.env.JWT_ACCESS_EXPIRES_IN || "15m";
const refreshExpiresIn = process.env.JWT_REFRESH_EXPIRES_IN || "7d";

const accessOptions: SignOptions = {
  expiresIn: accessExpiresIn as SignOptions["expiresIn"],
};

const refreshOptions: SignOptions = {
  expiresIn: refreshExpiresIn as SignOptions["expiresIn"],
};

export function createAccessToken(userId: string): string {
  return jwt.sign(
    {
      sub: userId,
      type: "access",
    },
    accessSecret,
    accessOptions,
  );
}

export function createRefreshToken(
  userId: string,
  sessionId: string,
): string {
  return jwt.sign(
    {
      sub: userId,
      sid: sessionId,
      type: "refresh",
    },
    refreshSecret,
    refreshOptions,
  );
}