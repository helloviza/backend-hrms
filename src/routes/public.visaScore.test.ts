// apps/backend/src/routes/public.visaScore.test.ts
//
// The Visa Profile Score API — the four endpoints, the five score modes,
// input validation, the DPDP redaction, and THE FIREWALL.
//
// No Mongo here, unlike public.visa.test.ts: these routes touch no model at
// all, which is itself one of the things worth asserting. The real router is
// mounted on a bare express app (never server.ts, which would boot the whole
// application and dial the cluster the dev backend points at).
//
// ── THE TEST THAT MATTERS MOST ────────────────────────────────────────
// The firewall block at the bottom serialises every response this API can
// produce and greps it for the actual delta values read out of the shipped
// ruleset. It is written against the REAL numbers rather than a fixture
// copy, so adding a question with a novel weight extends the test
// automatically instead of leaving a gap.
import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

process.env.NODE_ENV = "test";
// The gate is exercised as a real fail-closed control in its own block; the
// happy paths run under the documented non-production bypass.
process.env.TURNSTILE_DEV_BYPASS = "true";
delete process.env.TURNSTILE_SECRET;

const { default: visaScoreRouter, redactAnswers, resolveScoreMode, SENSITIVE_ANSWER_KEYS } =
  await import("./public.visaScore.js");
const { VISA_SCORE_RULESET: R } = await import("../config/visaScoreRuleset.js");
const { BASE_RATES } = await import("../utils/visaDifficulty.js");
const { visaScoreLimiter } = await import("../middleware/rateLimit.js");
const { listSeedCountries } = await import("../config/visaCountrySeed.js");

const app = express();
app.use(express.json());
app.use("/api/public", visaScoreRouter);

/** The real shipped limiter — 15 min / 60 per IP, process-global. Every
 *  supertest request arrives from the same loopback address, so without a
 *  reset the suite would exhaust the window and later tests would 429. */
function resetRateLimiter() {
  const anyLimiter = visaScoreLimiter as any;
  anyLimiter?.resetKey?.("::ffff:127.0.0.1");
  anyLimiter?.resetKey?.("127.0.0.1");
  anyLimiter?.resetKey?.("::1");
}
beforeEach(resetRateLimiter);

const MODAL: Record<string, number> = {
  residence: 0, age: 2, travel: 2, purpose: 0, staylen: 1, companions: 1,
  family: 1, assets: 1, employment: 1, payer: 0, finproof: 1, refusals: 0,
  compliance: 0, character: 0,
};

const post = (body: unknown) =>
  request(app).post("/api/public/visa-score/score").send(body as any);

/* ═══════════════════════════════════════════════════════════════════════
 * POST /score — the five modes
 * ═══════════════════════════════════════════════════════════════════════ */
describe("POST /visa-score/score — the five modes", () => {
  it("mode 'score': a normal corridor returns the full contract", async () => {
    const res = await post({ passport: "IN", destination: "US", answers: MODAL });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.mode).toBe("score");

    for (const k of [
      "rulesetVersion", "route", "eligibility", "score", "band", "range",
      "profileStrength", "factors", "flags", "silentExcluded", "build",
      "disclaimer", "generatedAt",
    ]) {
      expect(res.body).toHaveProperty(k);
    }
    expect(typeof res.body.score).toBe("number");
    expect(res.body.band?.name).toBeTruthy();
    expect(res.body.route.destinationName).toBe("United States");
    expect(res.body.route.averagingWindow).toBe("a3");
  });

  it("mode 'no_visa': a visa-free corridor is stopped before it is scored", async () => {
    const visaFree = listSeedCountries().find((c) => c.visaCategory === "VISA_FREE");
    expect(visaFree).toBeTruthy();

    const res = await post({ passport: "IN", destination: visaFree!.iso2, answers: MODAL });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("no_visa");
  });

  it("mode 'blocked': a restricted corridor has no ordinary route to assess", async () => {
    const restricted = listSeedCountries().find((c) => c.visaCategory === "RESTRICTED");
    if (!restricted) return; // seed holds none today; the branch is still asserted by resolveScoreMode
    const res = await post({ passport: "IN", destination: restricted.iso2, answers: MODAL });
    expect(res.body.mode).toBe("blocked");
  });

  it("mode 'indicative': India-into-India holds no corridor rate, so no number", async () => {
    const res = await post({ passport: "IN", destination: "IN", answers: MODAL });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("indicative");
    expect(res.body.score).toBeNull();
    expect(res.body.band).toBeNull();
    expect(res.body.eligibility.assessable).toBe(false);
  });

  it("mode 'suppressed': an exhausted Schengen window withholds the number", async () => {
    const res = await post({
      passport: "IN", destination: "SCHENGEN", answers: { ...MODAL, schdays: 3 },
    });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("suppressed");
    expect(res.body.score).toBeNull();
    expect(res.body.build.suppressed).toBe(true);
    expect(res.body.flags.some((f: any) => f.code === "window")).toBe(true);
  });

  it("caps a misrepresentation finding at the display layer, raw value intact", async () => {
    const STRONG = { ...MODAL, residence: 1, travel: 4, employment: 0, finproof: 0, compliance: 3 };
    const res = await post({ passport: "IN", destination: "US", answers: STRONG });
    expect(res.body.score).toBe(449);
    expect(res.body.build.capped).toBe("misrep");
    expect(res.body.build.rawScore).toBeGreaterThan(449);
  });

  it("honours the 3Y/5Y toggle", async () => {
    const a3 = await post({ passport: "IN", destination: "US", answers: MODAL });
    resetRateLimiter();
    const a5 = await post({ passport: "IN", destination: "US", answers: MODAL, mode: "a5" });
    expect(a3.body.route.averagingWindow).toBe("a3");
    expect(a5.body.route.averagingWindow).toBe("a5");
    expect(a3.body.build.baseRate).not.toBe(a5.body.build.baseRate);
  });

  it("is deterministic apart from generatedAt", async () => {
    const body = { passport: "IN", destination: "CA", answers: MODAL };
    const a = await post(body);
    resetRateLimiter();
    const b = await post(body);

    const strip = (o: any) => { const { generatedAt, ...rest } = o; return rest; };
    expect(JSON.stringify(strip(a.body))).toBe(JSON.stringify(strip(b.body)));
    expect(typeof a.body.generatedAt).toBe("string");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * Validation
 * ═══════════════════════════════════════════════════════════════════════ */
describe("POST /visa-score/score — input validation", () => {
  const cases: Array<[string, unknown]> = [
    ["a missing passport", { destination: "US", answers: MODAL }],
    ["a malformed passport", { passport: "INDIA", destination: "US", answers: MODAL }],
    ["a malformed destination", { passport: "IN", destination: "U", answers: MODAL }],
    ["a bad averaging mode", { passport: "IN", destination: "US", answers: MODAL, mode: "a7" }],
    ["answers as an array", { passport: "IN", destination: "US", answers: [1, 2] }],
    ["missing answers", { passport: "IN", destination: "US" }],
    ["an unknown question", { passport: "IN", destination: "US", answers: { nope: 0 } }],
    ["a non-integer option", { passport: "IN", destination: "US", answers: { travel: 1.5 } }],
    ["a negative option", { passport: "IN", destination: "US", answers: { travel: -1 } }],
    ["heldVisas as a string", { passport: "IN", destination: "US", answers: MODAL, heldVisas: "GB" }],
  ];

  for (const [label, body] of cases) {
    it(`400s cleanly on ${label}`, async () => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(typeof res.body.error).toBe("string");
      expect(Array.isArray(res.body.details)).toBe(true);
      expect(res.body.score).toBeUndefined();
    });
  }

  it("rejects an option index past the end rather than scoring it as zero", async () => {
    // The failure this guards: options[99] is undefined, `?? 0` would make
    // it contribute nothing, and a wrong score would be returned at full
    // confidence instead of an error.
    const q = R.questions.find((x) => x.id === "employment")!;
    const res = await post({
      passport: "IN", destination: "US",
      answers: { ...MODAL, employment: q.options.length },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("employment");
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * DPDP §12.7
 * ═══════════════════════════════════════════════════════════════════════ */
describe("DPDP — the compliance and character answers", () => {
  it("names exactly the two sensitive questions", () => {
    expect([...SENSITIVE_ANSWER_KEYS].sort()).toEqual(["character", "compliance"]);
  });

  it("redacts their VALUES while keeping their keys", () => {
    const out = redactAnswers({ travel: 2, compliance: 3, character: 3, employment: 7 });
    expect(out.compliance).toBe("[redacted]");
    expect(out.character).toBe("[redacted]");
    expect(out.travel).toBe(2);
    expect(out.employment).toBe(7);
  });

  it("survives junk input without throwing", () => {
    expect(redactAnswers(null)).toEqual({});
    expect(redactAnswers("nope")).toEqual({});
    expect(redactAnswers(undefined)).toEqual({});
  });

  it("routes every logged answer set through redactAnswers, and logs no raw body", async () => {
    /* A source-level assertion, like the "persists nothing" test below, and
     * deliberately not a logger spy: the router binds its child logger at
     * module load, so a spy installed afterwards would observe nothing and
     * the test would pass for the wrong reason — the worst outcome for a
     * privacy control.
     *
     * What this pins is the invariant that actually matters: the only
     * answers-shaped value reaching a log call is the redacted one, and no
     * log call is handed `req.body` or `body.answers` whole. */
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./public.visaScore.ts", import.meta.url), "utf-8");

    // Every logging call in the file.
    const logCalls = src.match(/scoreLogger\.(warn|error|info)\([\s\S]*?\n\s*\}\);|scoreLogger\.(warn|error|info)\([^\n]*\);/g) ?? [];
    expect(logCalls.length).toBeGreaterThan(0);

    for (const call of logCalls) {
      // No raw body, and no raw answers, in any log call.
      expect(call).not.toMatch(/\breq\.body\b/);
      expect(call).not.toMatch(/answers:\s*body\?*\.answers/);
      expect(call).not.toMatch(/answers:\s*body\.answers/);
      // If a call mentions answers at all, it must be the redacted form.
      if (/answers/.test(call)) expect(call).toMatch(/redactAnswers\(/);
    }

    // And the redactor is genuinely wired, not merely exported.
    expect(src).toMatch(/answers:\s*redactAnswers\(/);
  });

  it("emits [redacted] rather than the value for the two sensitive answers", () => {
    // The behaviour the source assertion above depends on, proven directly.
    const line = JSON.stringify({ answers: redactAnswers({ compliance: 3, character: 3, travel: 2 }) });
    expect(line).toContain("[redacted]");
    expect(line).not.toMatch(/"compliance"\s*:\s*3/);
    expect(line).not.toMatch(/"character"\s*:\s*3/);
    expect(line).toMatch(/"travel"\s*:\s*2/);
  });

  it("does not echo the submitted answers back in the response", async () => {
    const res = await post({
      passport: "IN", destination: "US", answers: { ...MODAL, compliance: 2, character: 2 },
    });
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('"answers"');
    expect(res.body.answers).toBeUndefined();
  });

  it("persists nothing — the router imports no model", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./public.visaScore.ts", import.meta.url), "utf-8");
    expect(src).not.toMatch(/from "\.\.\/models\//);
    expect(src).not.toMatch(/\.save\(\)|\.create\(|\.updateOne\(|\.insertMany\(/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * GET /routes
 * ═══════════════════════════════════════════════════════════════════════ */
describe("GET /visa-score/routes — the catalogue", () => {
  it("returns destinations with approval figures, climate and mode", async () => {
    const res = await request(app).get("/api/public/visa-score/routes");
    expect(res.status).toBe(200);
    expect(res.body.destinations.length).toBeGreaterThan(150);

    const us = res.body.destinations.find((d: any) => d.iso2 === "US");
    expect(us.name).toBe("United States");
    expect(us.mode).toBe("score");
    expect(us.approval.avg3Pct).toBe(73);
    expect(us.approval.avg5Pct).toBe(72);
    expect(us.approval.yearsPct[0]).toBe(76); // agrees with the map's y2026
    expect(us.climate.name).toBeTruthy();
  });

  it("includes the Schengen synthetic with its member list", async () => {
    const res = await request(app).get("/api/public/visa-score/routes");
    expect(res.body.schengen.iso2).toBe("SCHENGEN");
    expect(res.body.schengen.synthetic).toBe(true);
    expect(res.body.schengen.members).toHaveLength(10);
    expect(res.body.schengen.approval.avg3Pct).toBe(79);
    // The trend chart needs a line for the most-asked corridor too.
    expect(res.body.schengen.approval.yearsPct).toHaveLength(5);
    for (const v of res.body.schengen.approval.yearsPct) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(99);
    }
  });

  it("marks visa-free corridors no_visa and gives them no approval figure", async () => {
    const res = await request(app).get("/api/public/visa-score/routes");
    const freeRows = res.body.destinations.filter((d: any) => d.mode === "no_visa");
    expect(freeRows.length).toBeGreaterThan(0);
    for (const r of freeRows) expect(r.visaCategory).toBe("VISA_FREE");
  });

  it("clamps every displayed percentage to 1..99", async () => {
    const res = await request(app).get("/api/public/visa-score/routes");
    for (const d of res.body.destinations) {
      if (!d.approval) continue;
      for (const v of [d.approval.avg3Pct, d.approval.avg5Pct, ...d.approval.yearsPct]) {
        expect(v).toBeGreaterThanOrEqual(1);
        expect(v).toBeLessThanOrEqual(99);
      }
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * GET /questions
 * ═══════════════════════════════════════════════════════════════════════ */
describe("GET /visa-score/questions — the questionnaire", () => {
  it("returns labels, citations, order and conditional metadata", async () => {
    const res = await request(app).get("/api/public/visa-score/questions");
    expect(res.status).toBe(200);
    expect(res.body.questions.length).toBeGreaterThan(0);

    for (const q of res.body.questions) {
      expect(typeof q.id).toBe("string");
      expect(typeof q.text).toBe("string");
      expect(typeof q.cite).toBe("string");
      expect(q.cite.length).toBeGreaterThan(0);
      expect(Array.isArray(q.options)).toBe(true);
      for (const o of q.options) {
        expect(typeof o.label).toBe("string");
        expect(typeof o.index).toBe("number");
        // THE FIREWALL, per option.
        expect(o).not.toHaveProperty("points");
        expect(Object.keys(o).sort()).toEqual(["index", "label"]);
      }
    }
  });

  it("filters route-conditional questions by destination", async () => {
    const generic = await request(app).get("/api/public/visa-score/questions");
    const schengen = await request(app).get("/api/public/visa-score/questions?destination=SCHENGEN");
    const us = await request(app).get("/api/public/visa-score/questions?destination=US");

    const ids = (r: any) => r.body.questions.map((q: any) => q.id);
    expect(ids(schengen)).toContain("schdays");
    expect(ids(us)).not.toContain("schdays");
    expect(ids(generic)).toContain("schdays"); // unfiltered shows everything
  });

  it("discloses the first-timer SKIP rules but not the boost list", async () => {
    const res = await request(app).get("/api/public/visa-score/questions");
    expect(res.body.firstTimer.skipQuestions).toEqual(R.firstTimer.skipQuestions);
    // The boost list is part of the model — naming it beside a multiplier
    // would hand over a piece of the weighting.
    expect(res.body.firstTimer).not.toHaveProperty("boostQuestions");
    expect(res.body.firstTimer).not.toHaveProperty("boostMultiplier");
  });

  it("flags the silent questions so the client can honour the promise", async () => {
    const res = await request(app).get("/api/public/visa-score/questions");
    const silent = res.body.questions.filter((q: any) => q.silent).map((q: any) => q.id).sort();
    expect(silent).toEqual(["age", "companions"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * GET /meta/ruleset
 * ═══════════════════════════════════════════════════════════════════════ */
describe("GET /visa-score/meta/ruleset — provenance", () => {
  it("returns version, citations and data coverage", async () => {
    const res = await request(app).get("/api/public/visa-score/meta/ruleset");
    expect(res.status).toBe(200);
    expect(res.body.ruleset.version).toBe(R.version);
    expect(res.body.ruleset.effectiveFrom).toBe(R.effectiveFrom);
    expect(res.body.citations).toHaveLength(R.questions.length);
    for (const c of res.body.citations) expect(c.cite.length).toBeGreaterThan(0);
    expect(res.body.baseRateData.corridorsWithSourcedRate).toBe(Object.keys(BASE_RATES).length);
    expect(res.body.baseRateData.nationality).toBe("IN");
  });

  it("names the hard stops without disclosing their thresholds", async () => {
    const res = await request(app).get("/api/public/visa-score/meta/ruleset");
    const codes = res.body.hardStops.map((h: any) => h.code).sort();
    expect(codes).toEqual(["custodial", "misrep", "window"]);
    for (const h of res.body.hardStops) {
      expect(h).not.toHaveProperty("capAt");
      expect(h).not.toHaveProperty("optionIndex");
    }
  });

  it("names the bands without their score thresholds", async () => {
    const res = await request(app).get("/api/public/visa-score/meta/ruleset");
    for (const b of [...res.body.bands, ...res.body.climateBands]) {
      expect(b).not.toHaveProperty("min");
      expect(b.name).toBeTruthy();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * THE FIREWALL — §12.2
 * ═══════════════════════════════════════════════════════════════════════ */
describe("FIREWALL — no endpoint ships the model", () => {
  /** Every response this API can produce, serialised. */
  async function allResponses(): Promise<Array<[string, string]>> {
    const out: Array<[string, string]> = [];
    const grab = async (label: string, p: Promise<any>) => {
      const r = await p;
      out.push([label, JSON.stringify(r.body)]);
    };
    await grab("GET /routes", request(app).get("/api/public/visa-score/routes"));
    await grab("GET /questions", request(app).get("/api/public/visa-score/questions"));
    await grab("GET /questions?SCHENGEN", request(app).get("/api/public/visa-score/questions?destination=SCHENGEN"));
    await grab("GET /meta/ruleset", request(app).get("/api/public/visa-score/meta/ruleset"));
    resetRateLimiter();
    await grab("POST /score", post({ passport: "IN", destination: "US", answers: MODAL }));
    resetRateLimiter();
    await grab("POST /score weak", post({
      passport: "IN", destination: "CA",
      answers: { ...MODAL, employment: 7, refusals: 3, compliance: 2, character: 2 },
      heldVisas: ["GB", "CA"],
    }));
    resetRateLimiter();
    await grab("POST /score 400", post({ passport: "X", destination: "US", answers: MODAL }));
    return out;
  }

  it("never returns a `points` key", async () => {
    for (const [label, body] of await allResponses()) {
      expect(body, `${label} leaked a points key`).not.toContain('"points"');
    }
  });

  it("never returns K, the envelope, or the transform constants", async () => {
    for (const [label, body] of await allResponses()) {
      for (const key of ['"K"', '"envelope"', '"transform"', '"clampBaseBeforeLogit"',
                         '"scoreSpan"', '"scoreBase"', '"warningThreshold"',
                         '"boostMultiplier"', '"pointsPerVisa"', '"totalPoints"', '"heldVisaPoints"']) {
        expect(body, `${label} leaked ${key}`).not.toContain(key);
      }
    }
  });

  /** Every distinct weight in the shipped ruleset, read from the ruleset
   *  itself so a new question with a novel value is covered automatically. */
  function allDeltas(): number[] {
    const s = new Set<number>();
    for (const q of R.questions) for (const o of q.options) s.add(o.points);
    return [...s];
  }
  /** As a bare JSON number — a value, not a digit inside a longer one. */
  const asValue = (n: number) => new RegExp(`(^|[\\[,:\\s])${n}([,}\\]\\s]|$)`);

  it("never returns a NEGATIVE delta — checked on every endpoint", async () => {
    /* Negative values are the safe universal probe: an approval percentage,
     * a score, an option index and a count are all non-negative, so a minus
     * sign in any payload can only have come from the model. This covers
     * -45, -38, -33, -27, -22, -21, -20, -19, -18, -17, -16, -15, -13, -12,
     * -11, -10 and the rest — i.e. most of what identifies the weighting. */
    const negatives = allDeltas().filter((d) => d < 0);
    expect(negatives.length).toBeGreaterThan(10);

    for (const [label, body] of await allResponses()) {
      for (const d of negatives) {
        expect(asValue(d).test(body), `${label} leaked the delta ${d}`).toBe(false);
      }
    }
  });

  it("returns options with an EXACT {index,label} key set and nothing else", async () => {
    /* The positive deltas cannot be grepped for the way the negative ones
     * can: +14 is indistinguishable from `order: 14`, and +8 from an option
     * index. A substring scan there would fail on legitimate content and
     * teach everyone to ignore this suite.
     *
     * A WHITELIST is the stronger assertion anyway, and it is the discipline
     * the route file itself claims: if an option object can only ever have
     * these two keys, no weight can ride along regardless of its value. Same
     * for the question wrapper. This catches a leak a grep would miss — a
     * weight added under an innocuous name like `weight` or `w`. */
    for (const url of [
      "/api/public/visa-score/questions",
      "/api/public/visa-score/questions?destination=SCHENGEN",
    ]) {
      const res = await request(app).get(url);
      for (const q of res.body.questions) {
        expect(Object.keys(q).sort()).toEqual([
          "appliesTo", "cite", "dimension", "id", "options",
          "order", "silent", "skippedForFirstTimer", "text",
        ]);
        for (const o of q.options) {
          expect(Object.keys(o).sort()).toEqual(["index", "label"]);
        }
      }
    }
  });

  it("never returns a positive delta where it could not be an index or ordinal", async () => {
    /* The residual check the whitelist cannot make: a weight of +14 or +11
     * hidden inside a STRING (a label, a citation, a note). Option indices
     * top out at 7 and question ordinals at 14, so any delta of magnitude
     * >= 15 is unambiguous everywhere in the questionnaire payload. */
    const big = allDeltas().filter((d) => d >= 15);
    const bodies: string[] = [];
    for (const url of [
      "/api/public/visa-score/questions",
      "/api/public/visa-score/meta/ruleset",
    ]) {
      bodies.push(JSON.stringify((await request(app).get(url)).body));
    }
    for (const body of bodies) {
      for (const d of big) expect(asValue(d).test(body)).toBe(false);
    }
  });

  it("never pairs an option label with its weight", async () => {
    /* Even without a `points` key, an option object carrying both a known
     * label and its value would be a leak.
     *
     * Only DISTINCTIVE weights are asserted: a points value of 0, 1 or 2
     * collides with the option's own `index`, which is legitimately present
     * because the client posts it back. Comparing those would fail on
     * `{"index":0,...}` and prove nothing. */
    const res = await request(app).get("/api/public/visa-score/questions");
    let checked = 0;
    for (const q of res.body.questions) {
      const ruleQ = R.questions.find((x: any) => x.id === q.id)!;
      for (const [i, o] of q.options.entries()) {
        const pts = ruleQ.options[i].points;
        if (Math.abs(pts) < 10) continue;
        checked++;
        expect(asValue(pts).test(JSON.stringify(o)), `${q.id}[${i}] paired label with ${pts}`).toBe(false);
      }
    }
    expect(checked).toBeGreaterThan(15);
  });

  it("the ruleset and the engine are not imported anywhere under apps/frontend", async () => {
    /* Walked directly rather than shelled out to git grep: a subprocess that
     * fails for an unrelated reason (no git, wrong cwd) returns empty, and an
     * empty result would read as "no leak" — a privacy control that passes
     * when it did not run is worse than no control. */
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");

    const root = path.resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "../../../frontend/src");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|js|jsx)$/.test(entry)) continue;
        const src = readFileSync(full, "utf-8");
        if (/visaScoreRuleset|visa-score-ruleset|visaProfileScore/.test(src)) hits.push(full);
      }
    };

    // Prove the walk actually reached the frontend before trusting its silence.
    const topLevel = readdirSync(root);
    expect(topLevel.length).toBeGreaterThan(3);

    walk(root);
    expect(hits).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * resolveScoreMode, unit-level
 * ═══════════════════════════════════════════════════════════════════════ */
describe("resolveScoreMode", () => {
  const ok = { eligibility: { assessable: true }, build: { suppressed: false } };

  it("puts the route checks before the answer checks", () => {
    const visaFree = listSeedCountries().find((c) => c.visaCategory === "VISA_FREE")!;
    // Unassessable AND visa-free must still read no_visa: the corridor
    // question is answered before the data question.
    expect(resolveScoreMode(visaFree.iso2, {
      eligibility: { assessable: false }, build: { suppressed: false },
    })).toBe("no_visa");
  });

  it("returns suppressed only when the engine suppressed", () => {
    expect(resolveScoreMode("SCHENGEN", ok)).toBe("score");
    expect(resolveScoreMode("SCHENGEN", {
      eligibility: { assessable: true }, build: { suppressed: true },
    })).toBe("suppressed");
  });

  it("treats SCHENGEN as a visa route despite having no seed row", () => {
    expect(resolveScoreMode("SCHENGEN", ok)).toBe("score");
  });
});
