// apps/backend/src/routes/stubs.ts
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";

const r = Router();

// ---------- LEAVE ----------
r.get("/leave/team", requireAuth, (req, res) => {
  res.json([
    { id: "lv_t2001", employee: "Alex J", type: "Casual", days: 1, status: "Pending" },
    { id: "lv_t2002", employee: "Priya S", type: "Sick", days: 2, status: "Approved" },
  ]);
});

// ---------- USERS ----------
r.get("/users/profile", requireAuth, (req, res) => {
  res.json({
    id: (req as any).user?.id ?? "demo-user",
    name: "Demo User",
    email: "demo@plumtrips.com",
    role: (req as any).user?.role ?? "Employee",
    manager: "Taylor R",
    department: "Engineering",
    location: "Remote",
  });
});

r.get("/users/team", requireAuth, (req, res) => {
  res.json([
    { id: "u_201", name: "Riya K", role: "Engineer I" },
    { id: "u_202", name: "Samir M", role: "Engineer II" },
    { id: "u_203", name: "Neha P", role: "QA" },
  ]);
});

// ---------- HR ----------
r.get("/hr/policies", requireAuth, (req, res) => {
  res.json([
    { id: "pol_wfh", title: "WFH & Hybrid", url: "#" },
    { id: "pol_leave", title: "Leave Policy", url: "#" },
    { id: "pol_exp", title: "Expense Reimbursements", url: "#" },
  ]);
});

r.get("/hr/orgchart", requireAuth, (req, res) => {
  res.json({
    name: "CEO",
    children: [
      { name: "VP Engineering", children: [{ name: "Platform" }, { name: "Product Eng" }] },
      { name: "VP HR", children: [{ name: "People Ops" }, { name: "L&D" }] },
    ],
  });
});

r.get("/hr/holidays", requireAuth, (req, res) => {
  res.json([
    { date: "2025-10-02", name: "Gandhi Jayanti" },
    { date: "2025-10-31", name: "Regional Holiday" },
  ]);
});

// ---------- VENDORS ----------
r.get("/vendors/pipeline", requireAuth, (req, res) => {
  res.json([
    { id: "ven_1", name: "Screening Inc.", stage: "Onboarding" },
    { id: "ven_2", name: "Wellness Co.", stage: "Negotiation" },
  ]);
});

// ---------- REPORTS ----------
r.get("/reports/manager/summary", requireAuth, (req, res) => {
  res.json({
    headcount: 18,
    activeToday: 16,
    leavesToday: 2,
    lateArrivalsThisWeek: 3,
    approvalsPending: 4,
  });
});

r.get("/reports/hr/summary", requireAuth, (req, res) => {
  res.json({
    totalEmployees: 142,
    attritionYTD: 4,
    openRoles: 7,
    avgTimeToHireDays: 28,
    complianceScore: 97,
  });
});

export default r;
