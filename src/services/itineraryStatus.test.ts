// Phase 5 Step 3 — itinerary BOOKED propagation.
import { describe, it, expect, vi, beforeEach } from "vitest";

const H = vi.hoisted(() => ({ updateOne: vi.fn() }));
vi.mock("../models/Itinerary.js", () => ({ default: { updateOne: H.updateOne } }));

import { propagateItineraryBooked } from "./itineraryStatus.js";

beforeEach(() => H.updateOne.mockReset());

describe("propagateItineraryBooked", () => {
  it("marks the linked itinerary BOOKED (workspace-scoped)", async () => {
    await propagateItineraryBooked({ workspaceId: "ws1", tripBundle: { itineraryId: "itn1" } });
    expect(H.updateOne).toHaveBeenCalledWith(
      { _id: "itn1", workspaceId: "ws1" },
      { $set: { status: "BOOKED" } },
    );
  });

  it("no itineraryId → no-op", async () => {
    await propagateItineraryBooked({ workspaceId: "ws1", tripBundle: {} });
    await propagateItineraryBooked({ workspaceId: "ws1" });
    expect(H.updateOne).not.toHaveBeenCalled();
  });
});
