// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FirstStudyGuide } from "./FirstStudyGuide";

afterEach(cleanup);
it("opens the practice guide and navigates normal tools without executing or configuring them", () => {
  const onNavigate = vi.fn();
  render(<FirstStudyGuide onNavigate={onNavigate} hasResult={false} />);
  expect(screen.getByText("Practice: inspect, measure and export").parentElement).toHaveAttribute("open");
  fireEvent.click(screen.getByRole("button", { name: "Inspect image" }));
  fireEvent.click(screen.getByRole("button", { name: "Segment & measure" }));
  fireEvent.click(screen.getByRole("button", { name: "Inspect objects" }));
  fireEvent.click(screen.getByRole("button", { name: "Review & export" }));
  expect(onNavigate.mock.calls).toEqual([["Display"], ["Analyze"]]);
  expect(screen.getByRole("button", { name: "Inspect objects" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Review & export" })).toBeDisabled();
});
it("exposes result navigation only when available and discloses authored expected values", () => {
  const onNavigate = vi.fn();
  render(<FirstStudyGuide onNavigate={onNavigate} hasResult />);
  fireEvent.click(screen.getByRole("button", { name: "Inspect objects" }));
  fireEvent.click(screen.getByRole("button", { name: "Review & export" }));
  expect(onNavigate.mock.calls).toEqual([["Population"], ["Info"]]);
  const results = screen.getByText(/With the settings above, expect 3 objects/);
  expect(results).not.toBeVisible();
  fireEvent.click(screen.getByText("Expected example results"));
  expect(results).toBeVisible();
  expect(results).toHaveTextContent("320, 768 and 512 pixels; areas 80, 192 and 128 µm²");
  expect(results).toHaveTextContent("100, 150 and 200");
  expect(screen.getByText(/Three authored rectangles, not cells/)).toBeVisible();
  expect(screen.getByText(/Every correction needs its own human review/)).toBeVisible();
});
