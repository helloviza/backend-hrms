import request from "supertest";
import app from "../server.js";

describe("auth", () => {
  it("rejects bad login", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "x@y.com", password: "nope" });

    // Not seeded user -> expect 401
    expect(res.status).toBe(401);
  });
});
