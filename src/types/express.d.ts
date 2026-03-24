import "express";

declare global {
  namespace Express {
    interface User {
      id: string;
      role?: string;
      city?: string;
      business?: {
        name?: string;
      };
    }

    interface Request {
      user?: User;
    }
  }
}
