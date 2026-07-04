import { describe, it, expect, vi, beforeEach } from "vitest";

const { createMock, findByIdMock, findOneMock, sendMailMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  findByIdMock: vi.fn(),
  findOneMock: vi.fn(),
  sendMailMock: vi.fn(),
}));

vi.mock("../models/SBTRequest.js", () => ({ default: { create: createMock } }));
vi.mock("../models/CustomerWorkspace.js", () => ({ default: { findById: findByIdMock } }));
vi.mock("../models/User.js", () => ({ default: { findOne: findOneMock } }));
vi.mock("./mailer.js", () => ({ sendMail: sendMailMock }));

import { sendHandoffPayload } from "./plutoHandoffSink.js";

// Chainable stub: supports .lean() and .select().lean().
const chain = (val: any) => ({ lean: () => Promise.resolve(val), select: () => ({ lean: () => Promise.resolve(val) }) });

const payload: any = {
  source: "pluto.ai",
  timestamp: "t",
  tripType: "business",
  destination: "Goa",
  itineraryLocked: true,
  state: "EXECUTION",
  summary: "Business trip to Goa, 3 nights",
  nextSteps: ["book"],
  priority: "P0",
  targetSLA: "15 minutes",
  slaReason: "Business travel is time-critical",
  lockedDecisions: { policyStatus: "NEEDS_APPROVAL", destination: "Goa" },
};
const ctx = { workspaceObjectId: "ws1", requesterId: "u1", requesterEmail: "u@x.com", requesterName: "U", conversationId: "c1" };

beforeEach(() => {
  createMock.mockReset();
  findByIdMock.mockReset();
  findOneMock.mockReset();
  sendMailMock.mockReset();
  sendMailMock.mockResolvedValue(undefined);
});

describe("sendHandoffPayload — real delivery", () => {
  it("creates exactly ONE SBTRequest (source CONCIERGE_AI + tripBundle) and emails the booker", async () => {
    findByIdMock.mockReturnValue(chain({ _id: "ws1", defaultApproverEmails: ["booker@x.com"] }));
    findOneMock
      .mockReturnValueOnce(chain({ _id: "bk1", email: "booker@x.com" })) // approver
      .mockReturnValueOnce(chain({ email: "booker@x.com" })); // booker email lookup
    createMock.mockResolvedValue({ _id: "req1" });

    const result = await sendHandoffPayload(payload, ctx);

    expect(result).toEqual({ delivered: true, requestId: "req1" });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "CONCIERGE_AI",
        status: "PENDING",
        conversationId: "c1",
        tripBundle: expect.objectContaining({
          conversationSummary: "Business trip to Goa, 3 nights",
          policyStatus: "NEEDS_APPROVAL",
        }),
      }),
    );
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(String(sendMailMock.mock.calls[0][0].html)).toContain("Trip summary");
  });

  it("no booker → delivered:false, NO SBTRequest created", async () => {
    findByIdMock.mockReturnValue(chain({ _id: "ws1", defaultApproverEmails: [] }));
    findOneMock.mockReturnValueOnce(chain(null)); // leader lookup → none

    const result = await sendHandoffPayload(payload, ctx);

    expect(result.delivered).toBe(false);
    expect(result.error).toBe("no_booker");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("SBTRequest.create throws → delivered:false (caught, never thrown)", async () => {
    findByIdMock.mockReturnValue(chain({ _id: "ws1", defaultApproverEmails: ["booker@x.com"] }));
    findOneMock.mockReturnValueOnce(chain({ _id: "bk1", email: "booker@x.com" }));
    createMock.mockRejectedValue(new Error("mongo down"));

    const result = await sendHandoffPayload(payload, ctx);

    expect(result.delivered).toBe(false);
    expect(result.error).toBe("mongo down");
  });

  it("missing workspace context → delivered:false no_workspace", async () => {
    const result = await sendHandoffPayload(payload, { ...ctx, workspaceObjectId: null });
    expect(result).toEqual({ delivered: false, error: "no_workspace" });
    expect(createMock).not.toHaveBeenCalled();
  });
});
