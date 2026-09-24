import { describe, it, expect, vi } from "vitest";
import { bearerAuth } from "../src/auth.js";

describe("bearerAuth", () => {
  function makeReq(headers: Record<string, string>) {
    return { headers } as any;
  }

  function makeRes() {
    return {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
  }

  it("should call next() immediately when token is not configured", () => {
    const mw = bearerAuth(undefined);
    const req = makeReq({});
    const res = makeRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should call next() immediately when token is null", () => {
    const mw = bearerAuth(null as any);
    const req = makeReq({});
    const res = makeRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("should reject request with no Authorization header", () => {
    const mw = bearerAuth("secret-token");
    const req = makeReq({});
    const res = makeRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      error: "Unauthorized: missing or invalid Authorization header",
    });
  });

  it("should reject request with wrong token", () => {
    const mw = bearerAuth("secret-token");
    const req = makeReq({ authorization: "Bearer wrong-token" });
    const res = makeRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("should reject request with non-Bearer scheme", () => {
    const mw = bearerAuth("secret-token");
    const req = makeReq({ authorization: "Basic c2VjcmV0" });
    const res = makeRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("should accept request with correct Bearer token", () => {
    const mw = bearerAuth("secret-token");
    const req = makeReq({ authorization: "Bearer secret-token" });
    const res = makeRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("should reject when authorization header is empty string", () => {
    const mw = bearerAuth("secret-token");
    const req = makeReq({ authorization: "" });
    const res = makeRes();
    const next = vi.fn();

    mw(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});