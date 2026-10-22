// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ScientificNumber, scientificNumber } from "./ScientificNumber";

afterEach(cleanup);
describe("ScientificNumber display precision", () => {
  it("makes a compact signed mean readable and its exact value keyboard accessible and selectable", () => {
    const value = -0.12345678901234568;
    render(<ScientificNumber value={value} />);
    const summary = screen.getByText("≈ -0.123457", { selector: "summary" });
    expect(summary).toHaveAccessibleName("Approximately -0.123457; show exact value");
    summary.focus(); expect(summary).toHaveFocus();
    expect(screen.getByLabelText("Exact value")).not.toBeVisible();
    fireEvent.click(summary);
    expect(screen.getByLabelText("Exact value")).toBeVisible();
    expect(screen.getByLabelText("Exact value")).toHaveTextContent(String(value));
  });
  it.each([0, -0, -12, 100006, Number.MAX_SAFE_INTEGER, 1.25, Number.MIN_VALUE, 1e-200, 1e200])("preserves the exact spelling of %s without rounding integers or losing the sign", value => {
    const { exact, display } = scientificNumber(value);
    expect(exact).toBe(Object.is(value, -0) ? "-0" : String(value));
    if (Number.isInteger(value) || Object.is(value, -0)) expect(display).toBe(exact);
    expect(Number(display)).not.toBeNaN();
    expect(Number(display)).not.toBe(Infinity);
    if (value !== 0) expect(Math.sign(Number(display))).toBe(Math.sign(value));
  });
  it.each([1.234567890123456e-200, -1.234567890123456e200])("retains very small and large exact floats behind compact scientific notation", value => {
    const { exact, display } = scientificNumber(value);
    expect(exact).toBe(String(value));
    if (!Number.isInteger(value)) expect(display).toBe("1.23457e-200");
    render(<ScientificNumber value={value} />);
    expect(screen.getByText(exact)).toBeInTheDocument();
  });
  it("keeps null non-estimability distinct from zero and rejects nonfinite values", () => {
    expect(scientificNumber(null)).toEqual({ exact: "Not estimable", display: "Not estimable" });
    for (const value of [NaN, Infinity, -Infinity]) expect(() => scientificNumber(value)).toThrow("must be finite or null");
  });
});
