import { describe, it, expect, vi, beforeEach } from "vitest";

const { getMock, emitMetricMock } = vi.hoisted(() => ({ getMock: vi.fn(), emitMetricMock: vi.fn() }));
vi.mock("axios", () => ({ default: { get: getMock }, get: getMock }));
vi.mock("../utils/plutoMetricsSink.js", () => ({ emitMetric: emitMetricMock }));

import { getDestinationWeather, isSevereWeather, _resetWeatherCache } from "./weatherService.js";

const daily = (over: any = {}) => ({
  data: {
    daily: {
      temperature_2m_max: [31],
      temperature_2m_min: [26],
      precipitation_sum: [2],
      weathercode: [1],
      ...over,
    },
  },
});

beforeEach(() => {
  getMock.mockReset();
  emitMetricMock.mockReset();
  _resetWeatherCache();
});

describe("isSevereWeather", () => {
  it("severe on thunderstorm/heavy codes or heavy precip", () => {
    expect(isSevereWeather(95, 0)).toBe(true);
    expect(isSevereWeather(65, 0)).toBe(true);
    expect(isSevereWeather(1, 30)).toBe(true);
  });
  it("not severe on mild conditions", () => {
    expect(isSevereWeather(1, 2)).toBe(false);
    expect(isSevereWeather(61, 5)).toBe(false);
  });
});

describe("getDestinationWeather", () => {
  it("returns a summary for a known IATA + date", async () => {
    getMock.mockResolvedValue(daily());
    const w = await getDestinationWeather("BOM", "2026-08-12");
    expect(w).toMatchObject({ tempMaxC: 31, city: "Mumbai", severe: false });
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it("caches within the hour (no second network call)", async () => {
    getMock.mockResolvedValue(daily());
    await getDestinationWeather("BOM", "2026-08-12");
    await getDestinationWeather("BOM", "2026-08-12");
    expect(getMock).toHaveBeenCalledTimes(1);
  });

  it("unknown IATA or bad date → null, no network call", async () => {
    expect(await getDestinationWeather("ZZZ", "2026-08-12")).toBeNull();
    expect(await getDestinationWeather("BOM", "bad-date")).toBeNull();
    expect(getMock).not.toHaveBeenCalled();
  });

  it("timeout/error → null (silent skip) + pluto.weather.failed metric", async () => {
    getMock.mockRejectedValue(new Error("timeout of 5000ms exceeded"));
    const w = await getDestinationWeather("DEL", "2026-08-12");
    expect(w).toBeNull();
    const types = emitMetricMock.mock.calls.map((c) => c[0]?.type);
    expect(types).toContain("pluto.weather.failed");
  });

  it("flags severe weather from the forecast", async () => {
    getMock.mockResolvedValue(daily({ weathercode: [95], precipitation_sum: [40] }));
    const w = await getDestinationWeather("GOI", "2026-08-12");
    expect(w?.severe).toBe(true);
  });
});
