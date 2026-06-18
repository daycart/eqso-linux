import type { Request, Response, NextFunction } from "express";
import { validateSession, type Session } from "./auth";

declare global {
  namespace Express {
    interface Request {
      session?: Session;
    }
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Token de autenticación requerido" });
    return;
  }
  const session = validateSession(token);
  if (!session) {
    res.status(401).json({ error: "Sesión expirada o inválida" });
    return;
  }
  if (session.role !== "admin" && !session.isAdmin) {
    res.status(403).json({ error: "Acceso restringido a administradores" });
    return;
  }
  req.session = session;
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = req.headers.authorization;
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: "Token de autenticación requerido" });
    return;
  }
  const session = validateSession(token);
  if (!session) {
    res.status(401).json({ error: "Sesión expirada o inválida" });
    return;
  }
  req.session = session;
  next();
}
