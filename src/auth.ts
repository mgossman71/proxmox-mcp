import type { NextFunction, Request, Response } from "express";

/**
 * Build an Express middleware that enforces a shared-secret Bearer token.
 *
 * When `token` is null/undefined the middleware is a no-op so local
 * development stays frictionless. Otherwise every request must send
 * `Authorization: Bearer <token>` or it is rejected with HTTP 401.
 */
export function bearerAuth(token: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!token) {
      next();
      return;
    }
    if (req.headers["authorization"] !== `Bearer ${token}`) {
      res.status(401).json({
        error: "Unauthorized: missing or invalid Authorization header",
      });
      return;
    }
    next();
  };
}