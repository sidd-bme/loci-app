import { describe, expect, it } from "vitest";
import { chartTicks, displayedFraction, domainValue, fullChartView, panChartView, populationNumber, viewedDomain, zoomChartView } from "./population-chart-view";

describe("Population chart display domains", () => {
  it("zooms and pans within the full data range without producing filters", () => {
    const domains = { x: [10, 110] as [number, number], y: [-20, 80] as [number, number] };
    const zoom = zoomChartView(fullChartView(), 0.5, domains, false);
    expect(viewedDomain(domains.x, zoom.x)).toEqual([35, 85]);
    expect(viewedDomain(domains.y, zoom.y)).toEqual([5, 55]);
    const pan = panChartView(zoom, 0.5, -0.5, domains, false);
    expect(viewedDomain(domains.x, pan.x)).toEqual([60, 110]);
    expect(viewedDomain(domains.y, pan.y)).toEqual([-20, 30]);
    expect(panChartView(pan, 10, -10, domains, false)).toEqual(pan);
    expect(zoomChartView(pan, 100, domains, false)).toEqual(fullChartView());
  });

  it("keeps histogram count axes at zero while navigating the measurement axis", () => {
    const domains = { x: [0, 100] as [number, number], y: [0, 20] as [number, number] };
    const zoom = zoomChartView(fullChartView(), 0.5, domains, true);
    expect(zoom.y).toEqual([0, 1]);
    expect(panChartView(zoom, 0.2, 0.3, domains, true).y).toEqual([0, 1]);
    expect(chartTicks(domains.y, zoom.y, 4, true).map((tick) => tick.value)).toEqual([0, 5, 10, 15, 20]);
  });

  it("supports constant, subnormal and extreme domains without fabricated padding or nonfinite positions", () => {
    for (const x of [[-Number.MAX_VALUE, Number.MAX_VALUE], [Number.MIN_VALUE, Number.MIN_VALUE * 2],
      [Number.MAX_VALUE, Number.MAX_VALUE], [0, 0]] as Array<[number, number]>) {
      const domains = { x, y: x };
      let view = fullChartView();
      for (let i = 0; i < 40; i++) view = zoomChartView(view, 0.5, domains, false);
      const visible = viewedDomain(x, view.x);
      expect(visible.every(Number.isFinite)).toBe(true);
      expect(visible[0]).toBeLessThanOrEqual(visible[1]);
      if (x[0] !== x[1]) expect(visible[0]).toBeLessThan(visible[1]);
      else expect(view).toEqual(fullChartView());
      expect(chartTicks(x, view.x).every((tick) => Number.isFinite(tick.position))).toBe(true);
    }
    expect(domainValue([-Number.MAX_VALUE, Number.MAX_VALUE], 0.5)).toBe(0);
    expect(displayedFraction(Number.MAX_VALUE, [-Number.MAX_VALUE, Number.MAX_VALUE], [0, 1])).toBe(1);
    expect(displayedFraction(7, [7, 7], [0, 1])).toBe(0.5);
  });

  it("keeps very large and tiny axis labels compact without rounding a nonzero measurement to zero", () => {
    expect(populationNumber(Number.MAX_VALUE).length).toBeLessThan(20);
    expect(populationNumber(Number.MIN_VALUE)).not.toBe("0");
    expect(populationNumber(1234)).toBe("1,234");
  });
});
